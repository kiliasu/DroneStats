"""How this computer is connected: its Wi-Fi, the way to the gateway, and Tailscale.

Read only while someone is watching, at a slow pace. A call to `iw` costs about 3 ms of CPU, and
asking tailscaled over its local socket about the same. Nothing here changes any setting.
"""
import asyncio
import json
import logging
import re
import socket
import struct
import time
from pathlib import Path

log = logging.getLogger("dronestats")

TAILSCALE_SOCKET = "/run/tailscale/tailscaled.sock"
WIFI_S = 5
GATEWAY_S = 10
TAILSCALE_S = 10
COMMAND_TIMEOUT_S = 3
GATEWAY_TIMEOUT_S = 1
GATEWAY_PORTS = (53, 80)    # any answer times the trip, a refusal as well as a connection


def default_route(text=None):
    """(interface, gateway address) of the default route, or None."""
    if text is None:
        try:
            text = Path("/proc/net/route").read_text()
        except OSError:
            return None
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) > 3 and fields[1] == "00000000" and int(fields[3], 16) & 2:
            return fields[0], socket.inet_ntoa(struct.pack("<L", int(fields[2], 16)))
    return None


def wifi_interface(route=None, root=Path("/sys/class/net")):
    """The Wi-Fi interface, preferring the one the default route goes through."""
    names = sorted(path.parent.name for path in root.glob("*/phy80211"))
    if route and route[0] in names:
        return route[0]
    return names[0] if names else None


def local_address(gateway):
    """This computer's address towards the gateway. Connecting a UDP socket sends nothing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((gateway, 9))
            return probe.getsockname()[0]
    except OSError:
        return None


def parse_iw_link(text):
    """The output of `iw dev <name> link`. `iw` writes anything outside plain ASCII in an SSID as \\xNN."""
    if "Connected to" not in text:
        return {"ssid": None}

    def number(pattern):
        found = re.search(pattern, text)
        return float(found.group(1)) if found else None

    ssid = re.search(r"SSID: (.*)", text)
    name = ""
    if ssid:
        raw = re.sub(rb"\\x([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]), ssid.group(1).encode())
        name = raw.decode("utf-8", "replace")
    dbm, freq, rate = number(r"signal: (-?\d+)"), number(r"freq: ([\d.]+)"), number(r"tx bitrate: ([\d.]+)")
    return {"ssid": name, "dbm": None if dbm is None else int(dbm), "freq": None if freq is None else round(freq), "tx": rate}


async def read_wifi(interface):
    """What `iw` says about the link, or None if it cannot be asked."""
    try:
        process = await asyncio.create_subprocess_exec(
            "iw", "dev", interface, "link", stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        return None
    try:
        output, _ = await asyncio.wait_for(process.communicate(), COMMAND_TIMEOUT_S)
        return parse_iw_link(output.decode("ascii", "replace")) if process.returncode == 0 else None
    except TimeoutError:
        return None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def gateway_ms(host, ports=GATEWAY_PORTS):
    """Milliseconds for a TCP handshake with the gateway, or None. Ordinary users cannot ping here."""
    for port in ports:
        started = time.perf_counter()
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), GATEWAY_TIMEOUT_S)
            writer.close()
        except ConnectionRefusedError:
            pass
        except (OSError, TimeoutError):
            continue
        return round((time.perf_counter() - started) * 1000, 1)
    return None


async def tailscale_status(path=None):
    """tailscaled's own view of the tailnet, over its local socket, or None."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path or TAILSCALE_SOCKET), COMMAND_TIMEOUT_S)
    except (OSError, TimeoutError):
        return None
    try:
        writer.write(b"GET /localapi/v0/status HTTP/1.0\r\nHost: local-tailscaled.sock\r\n\r\n")
        data = await asyncio.wait_for(reader.read(), COMMAND_TIMEOUT_S)
    except (OSError, TimeoutError):
        return None
    finally:
        writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    if b" 200 " not in head.split(b"\r\n", 1)[0] + b" ":
        return None
    try:
        status = json.loads(body)
    except ValueError:
        return None
    return status if isinstance(status, dict) else None


def tailscale_summary(status):
    """This machine's address, and for each peer in use right now, whether the path is direct."""
    if not status:
        return None
    peers = []
    for peer in (status.get("Peer") or {}).values():
        if peer.get("Active"):
            name = (peer.get("DNSName") or peer.get("HostName") or "?").split(".")[0]
            peers.append([name, bool(peer.get("CurAddr")), peer.get("Relay") or peer.get("PeerRelay") or None])
    addresses = status.get("TailscaleIPs") or (status.get("Self") or {}).get("TailscaleIPs") or []
    return {"ip": addresses[0] if addresses else None, "peers": sorted(peers)}


class NetworkWatch:
    """Publishes all this to the dashboard's state, only while someone is watching."""

    def __init__(self, telemetry):
        self.t = telemetry
        self.due = {"wifi": 0.0, "gateway": 0.0, "tailscale": 0.0}

    def _due(self, name, period, now):
        if now < self.due[name]:
            return False
        self.due[name] = now + period
        return True

    async def poll(self):
        now = time.monotonic()
        route = default_route()
        if self._due("wifi", WIFI_S, now):
            interface = wifi_interface(route)
            # False is no Wi-Fi here at all. None would be no news on a machine that never had any.
            self.t.publish("wifi", await read_wifi(interface) if interface else False)
        if self._due("gateway", GATEWAY_S, now):
            self.t.publish("gw", await gateway_ms(route[1]) if route else None)
            self.t.publish("lan", local_address(route[1]) if route else None)
        if self._due("tailscale", TAILSCALE_S, now):
            self.t.publish("ts", tailscale_summary(await tailscale_status()))

    async def run(self):
        while True:
            await self.t.watching.wait()
            try:
                await self.poll()
            except Exception:
                log.exception("network check failed")
            await asyncio.sleep(1)
