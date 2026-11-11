"""The network readings, against stand-ins. Nothing here touches a real interface."""
import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT)]

import network  # noqa: E402

CONNECTED = """Connected to aa:bb:cc:dd:ee:ff (on wlan0)
\tSSID: Home Net
\tfreq: 2422.0
\tRX: 15546267 bytes (29094 packets)
\tTX: 32660291 bytes (29095 packets)
\tsignal: -48 dBm
\trx bitrate: 1.0 MBit/s
\ttx bitrate: 172.0 MBit/s 40MHz HE-MCS 7 HE-NSS 1 HE-GI 0 HE-DCM 0
"""
ROUTES = """Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
wlan0\t0000A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0
wlan0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0
"""


class Readings(unittest.TestCase):
    def test_a_connected_link(self):
        self.assertEqual(network.parse_iw_link(CONNECTED), {"ssid": "Home Net", "dbm": -48, "freq": 2422, "tx": 172.0})

    def test_no_link(self):
        self.assertEqual(network.parse_iw_link("Not connected.\n"), {"ssid": None})

    def test_a_name_in_chinese(self):
        text = CONNECTED.replace("Home Net", r"\xe5\xae\xb6\xe9\x87\x8c")
        self.assertEqual(network.parse_iw_link(text)["ssid"], "家里")

    def test_missing_fields(self):
        self.assertEqual(network.parse_iw_link("Connected to aa:bb (on wlan0)\n\tSSID: x\n"),
                         {"ssid": "x", "dbm": None, "freq": None, "tx": None})

    def test_default_route(self):
        self.assertEqual(network.default_route(ROUTES), ("wlan0", "192.168.0.1"))
        self.assertIsNone(network.default_route("Iface\tDestination\n"))

    def test_finding_the_wifi_interface(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("eth0", "wlan0", "wlan1"):
                (root / name).mkdir()
            self.assertIsNone(network.wifi_interface(("eth0", "x"), root))
            (root / "wlan0" / "phy80211").mkdir()
            (root / "wlan1" / "phy80211").mkdir()
            self.assertEqual(network.wifi_interface(("wlan1", "x"), root), "wlan1")
            self.assertEqual(network.wifi_interface(("eth0", "x"), root), "wlan0")

    def test_tailscale_peers_in_use(self):
        status = {"TailscaleIPs": ["100.64.0.1"], "Peer": {
            "a": {"DNSName": "phone.tail.ts.net.", "Active": True, "CurAddr": "1.2.3.4:41641", "Relay": "lax"},
            "b": {"DNSName": "laptop.tail.ts.net.", "Active": True, "CurAddr": "", "Relay": "lax"},
            "c": {"DNSName": "idle.tail.ts.net.", "Active": False, "CurAddr": "5.6.7.8:1", "Relay": "lax"},
        }}
        self.assertEqual(network.tailscale_summary(status),
                         {"ip": "100.64.0.1", "peers": [["laptop", False, "lax"], ["phone", True, "lax"]]})
        self.assertEqual(network.tailscale_summary({"Peer": None}), {"ip": None, "peers": []})
        self.assertIsNone(network.tailscale_summary(None))


class Asking(unittest.IsolatedAsyncioTestCase):
    async def wifi_from(self, script):
        with tempfile.TemporaryDirectory() as folder:
            tool = Path(folder) / "iw"
            tool.write_text("#!/bin/sh\n" + script + "\n")
            tool.chmod(0o755)
            with patch.dict(os.environ, {"PATH": f"{folder}:{os.environ['PATH']}"}):
                return await network.read_wifi("wlan0")

    async def test_iw(self):
        self.assertEqual((await self.wifi_from("echo 'Connected to x'; echo 'SSID: y'; echo 'signal: -60 dBm'"))["dbm"], -60)

    async def test_iw_failing_gives_nothing(self):
        self.assertIsNone(await self.wifi_from("exit 1"))

    async def test_no_iw_gives_nothing(self):
        with patch.dict(os.environ, {"PATH": "/nonexistent"}):
            self.assertIsNone(await network.read_wifi("wlan0"))

    async def test_iw_that_hangs_is_stopped(self):
        with patch.object(network, "COMMAND_TIMEOUT_S", 0.2):
            self.assertIsNone(await asyncio.wait_for(self.wifi_from("exec sleep 30"), 3))

    async def test_gateway_that_accepts(self):
        server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        self.assertIsNotNone(await network.gateway_ms("127.0.0.1", (port,)))
        server.close()

    async def test_gateway_that_refuses_still_times_the_trip(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.assertIsNotNone(await network.gateway_ms("127.0.0.1", (port,)))

    async def test_gateway_that_never_answers(self):
        with patch("asyncio.open_connection", AsyncMock(side_effect=OSError)):
            self.assertIsNone(await network.gateway_ms("192.0.2.1", (53, 80)))


class Watch(unittest.IsolatedAsyncioTestCase):
    def stand_ins(self):
        return [patch.object(network, "default_route", return_value=("wlan0", "192.168.0.1")),
                patch.object(network, "wifi_interface", return_value="wlan0"),
                patch.object(network, "read_wifi", AsyncMock(return_value={"ssid": "x", "dbm": -50})),
                patch.object(network, "gateway_ms", AsyncMock(return_value=4.0)),
                patch.object(network, "local_address", return_value="192.168.0.72"),
                patch.object(network, "tailscale_status", AsyncMock(return_value=None))]

    class Telemetry:
        def __init__(self):
            self.watching = asyncio.Event()
            self.state = {}

        def publish(self, key, value):
            self.state[key] = value

    async def test_nothing_is_read_while_nobody_watches(self):
        telemetry = self.Telemetry()
        patches = self.stand_ins()
        mocks = [p.start() for p in patches]
        self.addCleanup(lambda: [p.stop() for p in patches])
        task = asyncio.create_task(network.NetworkWatch(telemetry).run())
        await asyncio.sleep(0.05)
        self.assertEqual(telemetry.state, {})
        for mock in mocks:
            self.assertEqual(mock.call_count, 0)
        telemetry.watching.set()
        await asyncio.sleep(0.05)
        self.assertEqual(telemetry.state["wifi"], {"ssid": "x", "dbm": -50})
        self.assertEqual(telemetry.state["gw"], 4.0)
        self.assertEqual(telemetry.state["lan"], "192.168.0.72")
        self.assertIsNone(telemetry.state["ts"])
        task.cancel()

    async def test_a_machine_with_no_wifi_says_so(self):
        telemetry = self.Telemetry()
        telemetry.watching.set()
        patches = [patch.object(network, "default_route", return_value=("eth0", "10.0.0.1")),
                   patch.object(network, "wifi_interface", return_value=None),
                   patch.object(network, "gateway_ms", AsyncMock(return_value=None)),
                   patch.object(network, "local_address", return_value=None),
                   patch.object(network, "tailscale_status", AsyncMock(return_value=None))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        task = asyncio.create_task(network.NetworkWatch(telemetry).run())
        await asyncio.sleep(0.05)
        self.assertIs(telemetry.state["wifi"], False)
        task.cancel()

    async def test_a_failure_does_not_stop_the_watch(self):
        telemetry = self.Telemetry()
        telemetry.watching.set()
        watch = network.NetworkWatch(telemetry)
        with patch.object(watch, "poll", AsyncMock(side_effect=[ValueError, None])) as poll, \
                patch.object(network, "COMMAND_TIMEOUT_S", 0.1), self.assertLogs("dronestats", "ERROR"), \
                patch("asyncio.sleep", AsyncMock(side_effect=[None, asyncio.CancelledError])):
            with self.assertRaises(asyncio.CancelledError):
                await watch.run()
        self.assertEqual(poll.await_count, 2)


class LocalApi(unittest.IsolatedAsyncioTestCase):
    async def test_status_over_a_socket(self):
        seen = []

        async def answer(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n" + json.dumps({"Peer": {}}).encode())
            await writer.drain()
            writer.close()

        with tempfile.TemporaryDirectory() as folder:
            path = f"{folder}/t.sock"
            server = await asyncio.start_unix_server(answer, path)
            self.assertEqual(await network.tailscale_status(path), {"Peer": {}})
            server.close()
        self.assertIn(b"Host: local-tailscaled.sock", seen[0])
