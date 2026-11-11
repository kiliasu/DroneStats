#!/usr/bin/env python3
"""DroneStats: a live MAVLink dashboard for a multicopter, served to a browser.

Read-only unless a viewer turns on execution, which the server enforces:
commands need a short-lived token held by one connected viewer, must be based on
data seen in the last few seconds, are limited to the table in commands.py, and
each goes to the flight controller once. By default it listens on loopback only,
which Tailscale in userspace mode can still deliver tailnet connections to.
"""
import argparse
import asyncio
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import time
from pathlib import Path

import commands
import marks
import network
from board import BoardStats
from telemetry import Telemetry

log = logging.getLogger("dronestats")

TICK_S = 0.2                # dashboard updates per viewer: 5 per second
KEEPALIVE_TICKS = 5         # with nothing new, still send a frame this often
BOARD_TICKS = 25            # how often to read this computer's own health
MAX_BODY = 1024
MAX_PLAN_BODY = 256 * 1024  # only for whoever holds execution, since a whole plan arrives this way
MAX_VIEWERS = 8
SEND_BUFFER = 16 * 1024     # small, so a stalled viewer is noticed soon
MAX_CLIENT_BACKLOG = 512 * 1024    # room for a first frame with a long stored plan and all the history
VIEWER_SILENT_S = 20        # a viewer that stops reporting in is dropped, as with a sleeping phone
EXEC_TTL_S = 180            # execution turns itself off after this long unused
EXEC_COOLDOWN_S = 0.5
FRESH_TICKS = 15            # a command must be based on a frame from the last 3 s
NAME_LOOKUP_GAP_S = 30      # an unfamiliar host name asks Tailscale again, at most this often

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                 ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}
MAP_TILES = "https://server.arcgisonline.com"
COMMON_HEADERS = (
    "X-Content-Type-Options: nosniff\r\n"
    "X-Frame-Options: DENY\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; "
    f"font-src 'self'; connect-src 'self'; img-src 'self' {MAP_TILES}; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'\r\n"
)
REASONS = {200: "OK", 304: "Not Modified", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
           405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
           421: "Misdirected Request", 429: "Too Many Requests"}


class Asset:
    def __init__(self, path):
        data = path.read_bytes()
        self.etag = '"%s"' % hashlib.sha256(data).hexdigest()[:16]
        self.ctype = CONTENT_TYPES[path.suffix]
        self.data = data
        self.gz = gzip.compress(data, 9, mtime=0) if path.suffix != ".woff2" else None


class Viewer:
    def __init__(self, writer):
        self.id = secrets.token_urlsafe(12)
        self.writer = writer
        self.alive_at = time.monotonic()


class ExecGate:
    """The one token that allows commands, the viewer holding it, and when it stops working."""

    def __init__(self):
        self.token = None
        self.owner = None
        self.until = 0.0
        self.busy = False
        self.last_run = 0.0

    def active(self):
        return self.token is not None and time.monotonic() < self.until

    def open(self, owner):
        self.token = secrets.token_urlsafe(24)
        self.owner = owner
        self.until = time.monotonic() + EXEC_TTL_S
        return self.token

    def close(self):
        self.token = None
        self.owner = None

    def allows(self, token):
        return (self.active() and isinstance(token, str)
                and hmac.compare_digest(token.encode(), self.token.encode()))

    def touch(self):
        self.until = time.monotonic() + EXEC_TTL_S


class Server:
    def __init__(self, telemetry, web_dir, allowed_host, marks_file=None, extra_hosts=()):
        self.t = telemetry
        self.extra_hosts = tuple(extra_hosts)
        self.commander = commands.Commander(telemetry)
        self.marks = marks.Marks(marks_file)
        self.publish_marks()
        self.gate = ExecGate()
        self.allowed_host = allowed_host
        self.name_asked_at = float("-inf")
        self.assets = {}
        for path in sorted(web_dir.rglob("*")):
            if path.suffix in CONTENT_TYPES:
                self.assets["/" + path.relative_to(web_dir).as_posix()] = Asset(path)
        self.assets["/"] = self.assets["/index.html"]
        self.viewers = {}
        self.seq = 0
        self.board = BoardStats()

    # --- plumbing -----------------------------------------------------------

    async def handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            await self.dispatch(head, reader, writer)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError,
                ConnectionError, ValueError):
            pass
        except Exception:
            log.exception("request failed")
        finally:
            writer.close()

    async def dispatch(self, head, reader, writer):
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        path = target.split("?", 1)[0]
        headers = {}
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if sep:
                headers[name.strip().lower()] = value.strip()

        # Refusing unknown Host values stops a web page from reaching this
        # service through DNS rebinding.
        if not await self.host_allowed(headers.get("host", "")):
            return self.send(writer, 421, b"", "text/plain")

        if method == "GET":
            if path == "/events":
                if headers.get("sec-fetch-site", "same-origin") != "same-origin":
                    return self.send(writer, 403, b"", "text/plain")
                if len(self.viewers) >= MAX_VIEWERS:
                    return self.send(writer, 429, b"", "text/plain")
                return await self.stream(reader, writer)
            if path == "/api/commands":
                return self.reply(writer, commands=commands.catalog())
            if path in self.assets:
                return self.send_asset(writer, self.assets[path], headers)
            return self.send(writer, 404, b"", "text/plain")

        if method == "POST" and path.startswith("/api/"):
            if not self.same_origin(headers):
                return self.reply(writer, 403, error="origin")
            holder = path == "/api/exec/run" and self.gate.allows(headers.get("x-exec-token"))
            body = await self.read_json(reader, headers, MAX_PLAN_BODY if holder else MAX_BODY)
            if body is None:
                return self.reply(writer, 400, error="body")
            return await self.api(path, body, headers, writer)

        return self.send(writer, 405, b"", "text/plain")

    async def host_allowed(self, host):
        """Whether this is one of this machine's names. Its name on the tailnet can be changed in the
        Tailscale admin console at any time, so an unfamiliar one is checked before it is refused."""
        if self.allowed_host.fullmatch(host):
            return True
        now = time.monotonic()
        if now - self.name_asked_at < NAME_LOOKUP_GAP_S:
            return False
        self.name_asked_at = now
        name = await tailscale_name()
        if name:
            self.allowed_host = host_pattern(name, self.extra_hosts)
        return bool(self.allowed_host.fullmatch(host))

    @staticmethod
    def same_origin(headers):
        origin = headers.get("origin", "")
        host = headers.get("host", "")
        return (origin in ("http://" + host, "https://" + host)
                and headers.get("sec-fetch-site", "same-origin") == "same-origin"
                and headers.get("content-type", "").startswith("application/json"))

    @staticmethod
    async def read_json(reader, headers, limit=MAX_BODY):
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            return None
        if not 0 <= length <= limit:
            return None
        raw = await asyncio.wait_for(reader.readexactly(length), 5) if length else b"{}"
        try:
            body = json.loads(raw)
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def send(self, writer, status, body, ctype, extra=""):
        writer.write((f"HTTP/1.1 {status} {REASONS[status]}\r\nContent-Type: {ctype}\r\n"
                      f"Content-Length: {len(body)}\r\nConnection: close\r\n"
                      f"{COMMON_HEADERS}{extra}\r\n").encode() + body)

    def reply(self, writer, status=200, **fields):
        self.send(writer, status, json.dumps(fields, separators=(",", ":")).encode(),
                  "application/json", "Cache-Control: no-store\r\n")

    def send_asset(self, writer, asset, headers):
        cache = ("Cache-Control: public, max-age=31536000, immutable\r\n"
                 if asset.gz is None else "Cache-Control: no-cache\r\n")
        tag = f"ETag: {asset.etag}\r\n{cache}"
        if headers.get("if-none-match") == asset.etag:
            return self.send(writer, 304, b"", asset.ctype, tag)
        if asset.gz is not None and "gzip" in headers.get("accept-encoding", ""):
            return self.send(writer, 200, asset.gz, asset.ctype,
                             tag + "Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n")
        return self.send(writer, 200, asset.data, asset.ctype, tag)

    # --- live updates -------------------------------------------------------

    @staticmethod
    def frame(event, payload):
        return f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()

    async def stream(self, reader, writer):
        viewer = Viewer(writer)
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SEND_BUFFER)
        writer.write((f"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                      f"Cache-Control: no-store\r\nConnection: keep-alive\r\n{COMMON_HEADERS}\r\n").encode())
        self.publish_exec()
        full = dict(self.t.state, messages=list(self.t.messages), history=list(self.t.history),
                    viewer=viewer.id, seq=self.seq, baud=self.t.bytes_per_s_full * 10)
        writer.write(b"retry: 2000\n\n" + self.frame("full", full))
        self.viewers[viewer.id] = viewer
        self.t.viewer_joined()
        try:
            while await reader.read(1024):
                pass
        finally:
            del self.viewers[viewer.id]
            self.t.viewer_left()
            if self.gate.owner is viewer:
                self.gate.close()       # its holder is gone, so nothing may be commanded
                log.warning("execution turned off: its viewer left")
                self.publish_exec()

    def publish_marks(self):
        self.t.publish("marks", [dict(mark) for mark in self.marks.items])

    def publish_exec(self):
        left = max(0, round(self.gate.until - time.monotonic())) if self.gate.active() else None
        self.t.publish("exec", left)

    def drop_unresponsive(self):
        now = time.monotonic()
        for viewer in list(self.viewers.values()):
            backlog = viewer.writer.transport.get_write_buffer_size()
            if backlog > MAX_CLIENT_BACKLOG or now - viewer.alive_at > VIEWER_SILENT_S:
                # abort, not close: close would wait for a flush this viewer will never take.
                viewer.writer.transport.abort()

    async def broadcast_loop(self):
        while True:
            if not self.viewers:
                await self.t.watching.wait()
            await asyncio.sleep(TICK_S)
            self.seq += 1
            self.commander.tick()
            # Running out in the air would leave its holder without RTL or Land when they are needed most.
            if self.gate.active() and self.t.armed():
                self.gate.touch()
            self.publish_exec()
            self.drop_unresponsive()
            self.t.publish("viewers", len(self.viewers))
            if self.seq % KEEPALIVE_TICKS == 0:
                self.t.publish("avail", self.commander.availability())
            if self.seq % BOARD_TICKS == 1 and self.viewers:
                self.t.publish("board", self.board.read())
            changes = self.t.take_changes()
            fresh = self.t.take_new_messages()
            samples = self.t.take_new_samples()
            if changes or self.seq % KEEPALIVE_TICKS == 0:
                changes = dict(changes or {}, seq=self.seq)
            if not self.viewers or not (changes or fresh or samples):
                continue
            data = ((self.frame("d", changes) if changes else b"")
                    + b"".join(self.frame("m", item) for item in fresh)
                    + b"".join(self.frame("h", item) for item in samples))
            for viewer in self.viewers.values():
                viewer.writer.write(data)

    # --- API ----------------------------------------------------------------

    def viewer_of(self, body):
        viewer_id = body.get("viewer")
        return self.viewers.get(viewer_id) if isinstance(viewer_id, str) else None

    async def api(self, path, body, headers, writer):
        if path == "/api/alive":
            viewer = self.viewer_of(body)
            if viewer is None:
                return self.reply(writer, 404, error="viewer")
            viewer.alive_at = time.monotonic()
            # A slow network can leave a page minutes behind while its stream looks healthy.
            # This tells the page how far along the stream really is.
            return self.reply(writer, ok=True, seq=self.seq)

        if path == "/api/prearm":
            return self.reply(writer, ok=self.t.request_prearm_check())

        if path == "/api/logs":
            if not self.t.fresh() or self.t.armed():
                return self.reply(writer, 409, error="unavailable")
            logs = await self.t.list_logs()
            if logs is None:
                return self.reply(writer, 409, error="unavailable")
            return self.reply(writer, logs=logs)

        if path == "/api/plan/refresh":
            self.t.plans.mark_dirty()
            return self.reply(writer, ok=True)

        if path == "/api/marks":
            try:
                mark = self.marks.apply(body)
            except marks.BadMark as e:
                return self.reply(writer, 409, error="bad_mark", field=str(e))
            self.publish_marks()
            return self.reply(writer, ok=True, mark=mark)

        if path == "/api/exec/open":
            viewer = self.viewer_of(body)
            if viewer is None:
                return self.reply(writer, 403, error="viewer")
            if not self.t.fresh():
                return self.reply(writer, 409, error="no_link")
            if self.gate.active() and self.gate.owner is not viewer:
                return self.reply(writer, 409, error="held")
            token = self.gate.open(viewer)
            log.warning("execution turned on")
            self.publish_exec()
            return self.reply(writer, token=token, left=EXEC_TTL_S)

        if path == "/api/exec/close":
            if not self.gate.allows(headers.get("x-exec-token")):
                return self.reply(writer, 403, error="token")
            self.gate.close()
            log.warning("execution turned off")
            self.publish_exec()
            return self.reply(writer, ok=True)

        if path == "/api/exec/run":
            token = headers.get("x-exec-token")
            if not self.gate.allows(token):
                return self.reply(writer, 403, error="token")
            return await self.run_command(body, token, writer)

        return self.reply(writer, 404, error="path")

    async def run_command(self, body, token, writer):
        name = body.get("action")
        action = commands.ACTIONS.get(name) if isinstance(name, str) else None
        if action is None:
            return self.reply(writer, 400, error="bad_action")
        now = time.monotonic()
        if not action.urgent and (self.gate.busy or now - self.gate.last_run < EXEC_COOLDOWN_S):
            return self.reply(writer, 429, error="busy")
        # Proof the sender was seeing live data just now. A request held up in the
        # network, or sent from a frozen page, arrives too old and goes no further.
        seq = body.get("seq")
        if type(seq) is not int or self.seq - seq > FRESH_TICKS:
            log.warning("command refused: %s stale", name)
            return self.reply(writer, 409, error="stale")
        try:
            params = commands.clean(action, body.get("params", {}))
        except commands.BadParam as e:
            log.warning("command refused: %s bad %s", name, e)
            return self.reply(writer, 409, error="bad_param", field=str(e))

        self.gate.busy = True
        try:
            refused = await self.commander.refusal(action, params)
            if refused:
                self.commander.note(action, params, refused)
                return self.reply(writer, 409, error=refused)
            if not self.gate.allows(token):     # it may have closed during that check
                return self.reply(writer, 403, error="token")
            self.gate.touch()
            result, said = await self.commander.send(action, params)
            self.gate.last_run = time.monotonic()
        finally:
            self.gate.busy = False
        effect = await self.commander.settle(action, params, result)    # holding nothing else up meanwhile
        self.gate.last_run = time.monotonic()
        outcome = "no_reply" if result is None else "accepted" if result == 0 else "refused"
        self.commander.note(action, params, "no_effect" if effect is False else outcome)
        return self.reply(writer, result=result, effect=effect, said=said)


async def tailscale_name():
    """This machine's name on the tailnet, such as drone.tail0000.ts.net, or None if unavailable."""
    status = await network.tailscale_status()
    try:
        return status["Self"]["DNSName"].rstrip(".").lower() or None
    except (TypeError, KeyError, AttributeError):
        return None


def host_pattern(name_on_tailnet="", extra=()):
    """The names a request may be addressed to: any address typed as numbers, which DNS rebinding cannot
    produce, this machine's own name, with .local or its tailnet domain, and any named with --allow-host."""
    names = {socket.gethostname().lower(), name_on_tailnet.partition(".")[0]} - {""}
    names = "|".join(re.escape(name) for name in sorted(names))
    others = "".join("|" + re.escape(name.lower()) for name in extra if name)
    return re.compile(rf"(?i)(localhost|\d{{1,3}}(\.\d{{1,3}}){{3}}|\[[0-9a-f:.]+\]"
                      rf"|({names})(\.local|\.[a-z0-9-]+\.ts\.net)?{others})(:\d+)?")


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--listen", default="127.0.0.1:8080")
    parser.add_argument("--mavlink", default="127.0.0.1:5678", help="mavlink-router TCP port")
    parser.add_argument("--baud", type=int, default=57600, help="speed of the serial link to the FC")
    parser.add_argument("--cells", type=int, default=2, help="battery cells in series")
    parser.add_argument("--simulator", action="store_true", help="say on the page that this is not a real aircraft")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="another name the page may be opened by, such as drone.example.com (repeatable)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    mav_host, mav_port = args.mavlink.rsplit(":", 1)
    host, port = args.listen.rsplit(":", 1)
    telemetry = Telemetry(mav_host, int(mav_port), args.baud, args.cells)
    if args.simulator:
        telemetry.publish("sim", True)
    # systemd says where this service may keep things. Run by hand, they stay beside the code.
    state_dir = Path(os.environ.get("STATE_DIRECTORY", Path(__file__).parent / "state"))
    server = Server(telemetry, Path(__file__).parent / "web", host_pattern(extra=args.allow_host), state_dir / "marks.json",
                    extra_hosts=args.allow_host)
    tcp = await asyncio.start_server(server.handle, host, int(port), limit=8192)
    log.info("listening on %s:%s", host, port)
    async with tcp:
        await asyncio.gather(tcp.serve_forever(), telemetry.run(), server.broadcast_loop(),
                             network.NetworkWatch(telemetry).run())


if __name__ == "__main__":
    asyncio.run(main())
