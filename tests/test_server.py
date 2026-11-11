"""End-to-end tests against the pretend flight controller. No hardware is involved.

    .venv/bin/python -m unittest discover -s tests
"""
import asyncio
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tools")]

import fake_fc  # noqa: E402
import server as srv  # noqa: E402
import telemetry as tel  # noqa: E402
from telemetry import L  # noqa: E402

READ_ONLY_COMMANDS = {L.MAV_CMD_REQUEST_MESSAGE, L.MAV_CMD_RUN_PREARM_CHECKS}
ARM_DISARM = L.MAV_CMD_COMPONENT_ARM_DISARM


def frames_from(system, component, encode):
    """A message as if received from (system, component). `encode` builds it on a MAVLink object."""
    sender = L.MAVLink(None, srcSystem=system, srcComponent=component)
    return L.MAVLink(None).parse_buffer(encode(sender).pack(sender))


class Harness(unittest.IsolatedAsyncioTestCase):
    scenario = "ready"
    quiet = False

    async def asyncSetUp(self):
        names = patch.object(srv, "tailscale_name", AsyncMock(return_value=None))
        self.tailscale_name = names.start()
        self.addCleanup(names.stop)
        self.fc_server, self.vehicle = await fake_fc.run(0, self.scenario, self.quiet)
        fc_port = self.fc_server.sockets[0].getsockname()[1]
        self.telemetry = tel.Telemetry("127.0.0.1", fc_port)
        self.server = srv.Server(self.telemetry, ROOT / "web", srv.host_pattern())
        self.http = await asyncio.start_server(self.server.handle, "127.0.0.1", 0, limit=8192)
        self.port = self.http.sockets[0].getsockname()[1]
        self.tasks = [asyncio.create_task(self.telemetry.run()),
                      asyncio.create_task(self.server.broadcast_loop())]
        self.connections = []

    async def asyncTearDown(self):
        for writer in self.connections:
            writer.close()
        for task in self.tasks:
            task.cancel()
        self.http.close()
        self.fc_server.close()

    async def raw(self, method, path, headers=None, body=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        payload = b"" if body is None else json.dumps(body).encode()
        base = {"Host": f"127.0.0.1:{self.port}", "Content-Length": str(len(payload))}
        lines = [f"{method} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in {**base, **(headers or {})}.items()]
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode() + payload)
        data = await reader.read()
        writer.close()
        head, _, content = data.partition(b"\r\n\r\n")
        return int(head.split()[1]), head.decode("latin-1"), content

    async def post(self, path, body=None, token=None, **overrides):
        headers = {"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"}
        if token:
            headers["X-Exec-Token"] = token
        headers.update(overrides)
        status, _, content = await self.raw("POST", path, headers, body if body is not None else {})
        return status, json.loads(content) if content else {}

    async def run_command(self, token, action=None, **params):
        return await self.post("/api/exec/run", {"action": action, "seq": self.server.seq, "params": params}, token=token)

    async def watch(self):
        """Opens the live stream, as a browser tab does. Returns (reader, writer, viewer id)."""
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        self.connections.append(writer)
        await reader.readuntil(b"event: full\ndata: ")
        full = json.loads(await reader.readline())
        return reader, writer, full["viewer"]

    async def until(self, condition, timeout=6, what="condition"):
        end = asyncio.get_running_loop().time() + timeout
        while not condition():
            if asyncio.get_running_loop().time() > end:
                self.fail(f"timed out waiting for {what}")
            await asyncio.sleep(0.05)

    async def linked(self):
        viewing = await self.watch()
        await self.until(self.telemetry.fresh, what="a heartbeat")
        return viewing

    async def opened(self):
        _, writer, viewer = await self.linked()
        status, body = await self.post("/api/exec/open", {"viewer": viewer})
        self.assertEqual(status, 200, body)
        self.owner_writer = writer
        return body["token"]


class ReadOnlyByDefault(Harness):
    async def test_commands_need_a_token(self):
        await self.linked()
        for token in (None, "wrong", "令牌"):
            headers = {"X-Exec-Token": token.encode().decode("latin-1")} if token else {}
            status, body = await self.post("/api/exec/run", {"action": "arm", "seq": self.server.seq}, **headers)
            self.assertEqual((status, body["error"]), (403, "token"))
        self.assertFalse(self.vehicle.armed)

    async def test_watching_sends_only_reads(self):
        await self.linked()
        await asyncio.sleep(1.5)
        sent = {command for command, *_ in self.vehicle.commands}
        self.assertLessEqual(sent, READ_ONLY_COMMANDS)
        self.assertFalse(self.vehicle.armed)


class QuietLink(Harness):
    quiet = True

    async def test_missing_data_is_fetched_within_the_cap(self):
        await self.linked()
        await self.until(lambda: "att" in self.telemetry.state and "volts" in self.telemetry.state, what="fetched data")
        self.vehicle.commands.clear()
        await asyncio.sleep(2)
        fetched = len(self.vehicle.commands)
        self.assertGreater(fetched, 0)
        self.assertLessEqual(fetched / 2, 1 / tel.POLL_STEP_S + 1)
        self.assertLessEqual({command for command, *_ in self.vehicle.commands}, READ_ONLY_COMMANDS)


class StreamingLink(Harness):
    async def test_streamed_messages_are_not_fetched_again(self):
        await self.linked()
        await asyncio.sleep(1.5)
        self.vehicle.commands.clear()
        await asyncio.sleep(1.5)
        asked = {int(p1) for command, p1, _ in self.vehicle.commands if command == L.MAV_CMD_REQUEST_MESSAGE}
        self.assertNotIn(L.MAVLINK_MSG_ID_ATTITUDE, asked)
        self.assertNotIn(L.MAVLINK_MSG_ID_SYS_STATUS, asked)


class LinkOnlyWhileWatched(Harness):
    async def test_connects_on_demand_and_leaves_when_nobody_watches(self):
        grace, tel.GRACE_S = tel.GRACE_S, 0.2
        self.addCleanup(setattr, tel, "GRACE_S", grace)
        await asyncio.sleep(0.5)
        self.assertIsNone(self.telemetry.mav)
        self.assertFalse(self.telemetry.watching.is_set())

        _, writer, _ = await self.watch()
        await self.until(self.telemetry.fresh, what="a heartbeat")

        writer.close()
        await self.until(lambda: not self.telemetry.watching.is_set(), timeout=5, what="the link to close")
        self.assertNotIn("att", self.telemetry.state)     # nothing out of date is kept

    async def test_silent_viewer_is_dropped_and_link_released(self):
        silent, srv.VIEWER_SILENT_S = srv.VIEWER_SILENT_S, 0.4
        self.addCleanup(setattr, srv, "VIEWER_SILENT_S", silent)
        grace, tel.GRACE_S = tel.GRACE_S, 0.2
        self.addCleanup(setattr, tel, "GRACE_S", grace)
        await self.watch()
        await self.until(lambda: not self.server.viewers, what="the silent viewer to be dropped")
        await self.until(lambda: not self.telemetry.watching.is_set(), timeout=5, what="the link to close")

    async def test_reporting_in_keeps_a_viewer(self):
        silent, srv.VIEWER_SILENT_S = srv.VIEWER_SILENT_S, 0.6
        self.addCleanup(setattr, srv, "VIEWER_SILENT_S", silent)
        _, _, viewer = await self.watch()
        for _ in range(6):
            await asyncio.sleep(0.2)
            status, _ = await self.post("/api/alive", {"viewer": viewer})
            self.assertEqual(status, 200)
        self.assertIn(viewer, self.server.viewers)


class Frames(Harness):
    async def test_a_frame_arrives_every_second_with_nothing_to_report(self):
        self.telemetry.port = 1      # nothing listens there, so the link never comes up
        reader, _, _ = await self.watch()
        seen = []
        for _ in range(2):
            await asyncio.wait_for(reader.readuntil(b"event: d\ndata: "), 3)
            seen.append(json.loads(await reader.readline())["seq"])
        self.assertLess(seen[0], seen[1])

    async def test_non_finite_values_never_reach_the_stream(self):
        await self.linked()
        msgs = frames_from(1, 1, lambda m: m.attitude_encode(0, math.nan, 0, 0, 0, 0, 0))
        before = self.telemetry.state.get("att")
        for msg in msgs:
            self.telemetry._on_message(msg)
        self.assertEqual(self.telemetry.state.get("att"), before)
        for msg in frames_from(1, 1, lambda m: m.vfr_hud_encode(math.inf, math.nan, 10, 5, 1.0, 0.0)):
            self.telemetry._on_message(msg)
        text = json.dumps(self.telemetry.state)
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)


class Heartbeats(Harness):
    async def test_another_component_cannot_redirect_commands(self):
        await self.linked()
        for msg in frames_from(1, 191, lambda m: m.heartbeat_encode(
                L.MAV_TYPE_QUADROTOR, L.MAV_AUTOPILOT_ARDUPILOTMEGA, 0, 7, L.MAV_STATE_STANDBY)):
            self.telemetry._on_message(msg)
        self.assertEqual(self.telemetry.target, (1, 1))
        self.assertNotEqual(self.telemetry.state["mode"], 7)

    async def test_another_vehicle_cannot_redirect_commands(self):
        await self.linked()
        for msg in frames_from(9, 1, lambda m: m.heartbeat_encode(
                L.MAV_TYPE_QUADROTOR, L.MAV_AUTOPILOT_ARDUPILOTMEGA, 0, 7, L.MAV_STATE_STANDBY)):
            self.telemetry._on_message(msg)
        self.assertEqual(self.telemetry.target, (1, 1))

    async def test_a_closed_link_stops_counting_as_fresh_at_once(self):
        await self.linked()
        self.telemetry.mav.file.writer.close()
        await self.until(lambda: not self.telemetry.fresh(), timeout=1, what="the link to stop being fresh")


class ConnectBackoff(unittest.IsolatedAsyncioTestCase):
    async def test_a_port_that_closes_at_once_is_not_hammered(self):
        count = 0

        async def accept_and_close(_, writer):
            nonlocal count
            count += 1
            writer.close()

        server = await asyncio.start_server(accept_and_close, "127.0.0.1", 0)
        telemetry = tel.Telemetry("127.0.0.1", server.sockets[0].getsockname()[1])
        telemetry.viewer_joined()
        task = asyncio.create_task(telemetry.run())
        await asyncio.sleep(1.5)
        task.cancel()
        server.close()
        self.assertLessEqual(count, 3)


class CrossSiteRequests(Harness):
    async def test_foreign_host_is_refused(self):
        status, _, _ = await self.raw("GET", "/", {"Host": "evil.example"})
        self.assertEqual(status, 421)
        status, _, _ = await self.raw("POST", "/api/exec/open", {
            "Host": "evil.example:8080", "Origin": "http://evil.example:8080", "Content-Type": "application/json"}, {})
        self.assertEqual(status, 421)      # DNS rebinding: origin and host agree, and it is still refused

    async def test_foreign_origin_cannot_open_execution(self):
        _, _, viewer = await self.linked()
        for override in ({"Origin": "http://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Content-Type": "text/plain"}):
            status, body = await self.post("/api/exec/open", {"viewer": viewer}, **override)
            self.assertEqual((status, body["error"]), (403, "origin"), override)
        self.assertFalse(self.server.gate.active())

    async def test_cross_site_page_cannot_start_the_stream(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nSec-Fetch-Site: cross-site\r\n\r\n".encode())
        line = await reader.readline()
        writer.close()
        self.assertIn(b"403", line)
        self.assertFalse(self.server.viewers)
        self.assertFalse(self.telemetry.watching.is_set())

    async def test_oversized_body_is_refused(self):
        status, _ = await self.post("/api/exec/open", {"x": "y" * 2000})
        self.assertEqual(status, 400)


class Execution(Harness):
    async def test_arm_goes_through_when_opened(self):
        token = await self.opened()
        status, body = await self.run_command(token, action="arm")
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_ACCEPTED))
        self.assertTrue(self.vehicle.armed)
        arm = [c for c in self.vehicle.commands if c[0] == ARM_DISARM]
        self.assertEqual(arm, [(ARM_DISARM, 1.0, 0.0)])     # sent once, and not forced

    async def test_mode_list_is_enforced(self):
        token = await self.opened()
        for mode in (1, 13, 14, 99, "9", None, [9], True, 9.0):
            status, body = await self.run_command(token, action="mode", mode=mode)
            self.assertEqual((status, body["error"]), (409, "bad_param"), mode)
        self.assertEqual(self.vehicle.mode, 0)
        status, body = await self.run_command(token, action="mode", mode=9)
        self.assertEqual(body["result"], L.MAV_RESULT_ACCEPTED)
        self.assertEqual(self.vehicle.mode, 9)

    async def test_unknown_action_is_refused(self):
        token = await self.opened()
        for action in ("force_disarm", "", None, ["arm"], {"a": 1}):
            status, body = await self.run_command(token, action=action)
            self.assertEqual((status, body["error"]), (400, "bad_action"), action)

    async def test_commands_are_not_stacked(self):
        token = await self.opened()
        first = await self.run_command(token, action="arm")
        second = await self.run_command(token, action="mode", mode=9)
        self.assertEqual(first[1]["result"], L.MAV_RESULT_ACCEPTED)
        self.assertEqual((second[0], second[1]["error"]), (429, "busy"))

    async def test_token_expires(self):
        ttl, srv.EXEC_TTL_S = srv.EXEC_TTL_S, 0.2
        self.addCleanup(setattr, srv, "EXEC_TTL_S", ttl)
        token = await self.opened()
        await asyncio.sleep(0.4)
        status, body = await self.run_command(token, action="arm")
        self.assertEqual((status, body["error"]), (403, "token"))
        self.assertFalse(self.vehicle.armed)

    async def test_closing_revokes_the_token(self):
        token = await self.opened()
        status, _ = await self.post("/api/exec/close", token=token)
        self.assertEqual(status, 200)
        status, _ = await self.run_command(token, action="arm")
        self.assertEqual(status, 403)

    async def test_command_from_a_delayed_or_frozen_page_is_refused(self):
        token = await self.opened()
        await self.until(lambda: self.server.seq > srv.FRESH_TICKS + 1, what="ticks to pass")
        for seq in (self.server.seq - srv.FRESH_TICKS - 1, 0, None, "1"):
            status, body = await self.post("/api/exec/run", {"action": "arm", "seq": seq}, token=token)
            self.assertEqual((status, body["error"]), (409, "stale"), seq)
        self.assertFalse(self.vehicle.armed)
        self.assertNotIn(ARM_DISARM, [c[0] for c in self.vehicle.commands])

    async def test_opening_needs_a_connected_viewer(self):
        await self.linked()
        for body in ({}, {"viewer": "made-up"}, {"viewer": ["x"]}):
            status, reply = await self.post("/api/exec/open", body)
            self.assertEqual((status, reply["error"]), (403, "viewer"), body)
        self.assertFalse(self.server.gate.active())

    async def test_holder_leaving_closes_execution_at_once(self):
        token = await self.opened()
        self.owner_writer.close()
        await self.until(lambda: not self.server.gate.active(), what="execution to close")
        status, _ = await self.run_command(token, action="arm")
        self.assertEqual(status, 403)

    async def test_another_viewer_cannot_take_over(self):
        token = await self.opened()
        _, _, other = await self.watch()
        status, body = await self.post("/api/exec/open", {"viewer": other})
        self.assertEqual((status, body["error"]), (409, "held"))
        status, body = await self.run_command(token, action="arm")
        self.assertEqual(body["result"], L.MAV_RESULT_ACCEPTED)     # the holder is unaffected

    async def test_another_viewer_can_open_once_the_holder_is_gone(self):
        await self.opened()
        _, _, other = await self.watch()
        self.owner_writer.close()
        await self.until(lambda: not self.server.gate.active(), what="execution to close")
        status, _ = await self.post("/api/exec/open", {"viewer": other})
        self.assertEqual(status, 200)

    async def test_reopening_by_the_holder_invalidates_the_old_token(self):
        _, _, viewer = await self.linked()
        _, first = await self.post("/api/exec/open", {"viewer": viewer})
        _, second = await self.post("/api/exec/open", {"viewer": viewer})
        status, _ = await self.run_command(first["token"], action="arm")
        self.assertEqual(status, 403)
        self.assertNotEqual(first["token"], second["token"])


class InFlight(Harness):
    scenario = "flight"

    async def test_disarm_is_refused_in_the_air(self):
        token = await self.opened()
        status, body = await self.run_command(token, action="disarm")
        self.assertEqual((status, body["error"]), (409, "in_air"))
        self.assertTrue(self.vehicle.armed)
        self.assertNotIn(ARM_DISARM, [c[0] for c in self.vehicle.commands])

    async def test_reboot_is_refused_while_armed(self):
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("armed") is True, what="armed state")
        status, body = await self.run_command(token, action="reboot")
        self.assertEqual((status, body["error"]), (409, "armed"))
        self.assertNotIn(L.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, [c[0] for c in self.vehicle.commands])

    async def test_land_is_allowed_in_the_air(self):
        token = await self.opened()
        status, body = await self.run_command(token, action="mode", mode=9)
        self.assertEqual(body["result"], L.MAV_RESULT_ACCEPTED)
        self.assertEqual(self.vehicle.mode, 9)

    async def test_flight_time_is_not_invented_for_an_arming_not_seen(self):
        await self.linked()
        await self.until(lambda: self.telemetry.state.get("armed") is True, what="armed state")
        self.assertFalse(self.telemetry.state.get("armed_at"))


class ArmedOnTheGround(Harness):
    scenario = "armed"

    async def test_disarm_goes_through_on_a_fresh_ground_report(self):
        token = await self.opened()
        status, body = await self.run_command(token, action="disarm")
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_ACCEPTED))
        self.assertFalse(self.vehicle.armed)

    async def test_disarm_is_refused_without_a_ground_report(self):
        self.vehicle.mute.add(L.MAVLINK_MSG_ID_EXTENDED_SYS_STATE)
        token = await self.opened()
        status, body = await self.run_command(token, action="disarm")
        self.assertEqual((status, body["error"]), (409, "in_air"))     # no evidence is not evidence
        self.assertTrue(self.vehicle.armed)

    async def test_an_old_ground_report_does_not_count(self):
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_ON_GROUND, what="a ground report")
        self.vehicle.mute.add(L.MAVLINK_MSG_ID_EXTENDED_SYS_STATE)
        status, body = await self.run_command(token, action="disarm")
        self.assertEqual((status, body["error"]), (409, "in_air"))
        self.assertTrue(self.vehicle.armed)


class Bench(Harness):
    scenario = "bench"

    async def test_flight_controller_refusal_is_reported(self):
        token = await self.opened()
        status, body = await self.run_command(token, action="arm")
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_FAILED))
        self.assertFalse(self.vehicle.armed)

    async def test_prearm_reasons_are_collected_without_arming(self):
        await self.linked()
        await self.until(lambda: self.telemetry.state.get("prearm"), what="pre-arm reasons")
        self.assertIn("RC not found", self.telemetry.state["prearm"])
        self.assertFalse(self.vehicle.armed)

    async def test_reasons_are_dropped_once_the_checks_pass(self):
        await self.linked()
        await self.until(lambda: self.telemetry.state.get("prearm"), what="pre-arm reasons")
        self.vehicle.prearm_ok = True
        await self.until(lambda: not self.telemetry.state.get("prearm"), what="the reasons to clear")

    async def test_opening_tabs_does_not_flood_prearm_checks(self):
        await self.watch()
        await self.until(lambda: self.telemetry.state.get("prearm"), what="pre-arm reasons")
        for _ in range(6):
            await self.watch()
        await asyncio.sleep(1)
        checks = [c for c in self.vehicle.commands if c[0] == L.MAV_CMD_RUN_PREARM_CHECKS]
        self.assertEqual(len(checks), 1)


class Logs(Harness):
    async def test_list_is_read_only_and_leaves_transfers_alone(self):
        await self.linked()
        status, body = await self.post("/api/logs")
        self.assertEqual(status, 200)
        self.assertEqual([entry[0] for entry in body["logs"]], [1, 2])
        self.assertIn("LOG_REQUEST_LIST", self.vehicle.received)
        for kind in ("LOG_REQUEST_END", "LOG_ERASE", "LOG_REQUEST_DATA"):
            self.assertNotIn(kind, self.vehicle.received)

    async def test_two_pages_opening_together_do_not_collide(self):
        await self.linked()
        first, second = await asyncio.gather(self.post("/api/logs"), self.post("/api/logs"))
        self.assertEqual(sorted((first[0], second[0])), [200, 409])
        self.assertEqual(self.vehicle.received.count("LOG_REQUEST_LIST"), 1)

    async def test_a_recent_list_is_reused(self):
        await self.linked()
        for _ in range(3):
            status, body = await self.post("/api/logs")
            self.assertEqual((status, len(body["logs"])), (200, 2))
        self.assertEqual(self.vehicle.received.count("LOG_REQUEST_LIST"), 1)

    async def test_no_logs_is_an_empty_list(self):
        self.vehicle.logs = []
        await self.linked()
        status, body = await self.post("/api/logs")
        self.assertEqual((status, body["logs"]), (200, []))

    async def test_not_while_armed(self):
        self.vehicle.armed = True
        await self.linked()
        await self.until(lambda: self.telemetry.state.get("armed") is True, what="armed state")
        status, body = await self.post("/api/logs")
        self.assertEqual((status, body["error"]), (409, "unavailable"))
        self.assertNotIn("LOG_REQUEST_LIST", self.vehicle.received)


class StaleValues(Harness):
    async def test_a_value_that_stops_updating_is_marked_and_left_out_of_history(self):
        await self.linked()
        await self.until(lambda: self.telemetry.state.get("volts") is not None, what="a voltage")
        self.vehicle.mute.add(L.MAVLINK_MSG_ID_SYS_STATUS)
        await self.until(lambda: "SYS_STATUS" in (self.telemetry.state.get("old") or []), timeout=9, what="the value to go stale")
        before = len(self.telemetry.history)
        await self.until(lambda: len(self.telemetry.history) > before, what="another sample")
        self.assertIsNone(self.telemetry.history[-1][1])
        self.assertNotIn("VFR_HUD", self.telemetry.state["old"])    # others are still arriving


class EveryValueFetched(Harness):
    quiet = True

    async def test_nothing_is_marked_old_on_a_link_with_no_streams(self):
        await self.linked()
        for _ in range(10):
            await asyncio.sleep(1)
            self.assertEqual(self.telemetry.state.get("old") or [], [])

    async def test_the_rc_failsafe_setting_is_read(self):
        await self.linked()
        await self.until(lambda: "FS_THR_ENABLE" in (self.telemetry.state.get("params") or {}),
                         what="the setting")


class HostNames(Harness):
    NAME = "dronepi.tail0000.ts.net"

    async def status_for(self, host):
        status, _, _ = await self.raw("GET", "/", {"Host": host})
        return status

    async def test_the_name_given_in_the_tailscale_console_is_recognised(self):
        self.tailscale_name.return_value = self.NAME
        for host in ("dronepi", "dronepi:8080", "dronepi.tail0000.ts.net:8080", "DRONEPI:8080"):
            self.assertEqual(await self.status_for(host), 200, host)
        self.tailscale_name.assert_awaited_once()

    async def test_other_names_are_still_refused(self):
        self.tailscale_name.return_value = self.NAME
        for host in ("evil.example.com", "dronepi.evil.example.com", "dronepix:8080", "x.dronepi", "dronepi.", ""):
            self.assertEqual(await self.status_for(host), 421, host)

    async def test_refused_names_ask_tailscale_only_now_and_then(self):
        for _ in range(3):
            self.assertEqual(await self.status_for("evil.example.com"), 421)
        self.tailscale_name.assert_awaited_once()

    async def test_a_new_name_replaces_the_old_one(self):
        self.tailscale_name.return_value = self.NAME
        self.assertEqual(await self.status_for("dronepi"), 200)
        self.tailscale_name.return_value = "drone.tail0000.ts.net"
        self.server.name_asked_at = float("-inf")       # as if the wait had passed
        self.assertEqual(await self.status_for("drone"), 200)
        self.assertEqual(await self.status_for("dronepi"), 421)

    async def test_requests_through_the_name_pass_the_origin_check(self):
        self.tailscale_name.return_value = self.NAME
        host = "dronepi:8080"
        self.assertEqual(await self.status_for(host), 200)
        status, body = await self.post("/api/alive", {"viewer": "nobody"}, Host=host, Origin=f"http://{host}")
        self.assertEqual((status, body["error"]), (404, "viewer"))
        status, body = await self.post("/api/alive", {"viewer": "nobody"}, Host=host, Origin="http://evil.example.com")
        self.assertEqual((status, body["error"]), (403, "origin"))


class NameFromTailscale(unittest.IsolatedAsyncioTestCase):
    """The lookup itself, against a stand-in for tailscaled's local socket."""

    async def name_from(self, reply):
        async def answer(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(reply)
            await writer.drain()
            writer.close()

        with tempfile.TemporaryDirectory() as folder:
            path = f"{folder}/tailscaled.sock"
            server = await asyncio.start_unix_server(answer, path)
            try:
                with patch.object(srv.network, "TAILSCALE_SOCKET", path):
                    return await srv.tailscale_name()
            finally:
                server.close()

    async def test_reads_the_name(self):
        body = json.dumps({"Self": {"HostName": "dronepi-board", "DNSName": "DRONEPI.tail0000.ts.net."}}).encode()
        self.assertEqual(await self.name_from(b"HTTP/1.0 200 OK\r\n\r\n" + body), "dronepi.tail0000.ts.net")

    async def test_anything_else_gives_no_name(self):
        for reply in (b"HTTP/1.0 403 Forbidden\r\n\r\n{}", b"HTTP/1.0 200 OK\r\n\r\nnot json", b"HTTP/1.0 200 OK\r\n\r\n[]",
                      b'HTTP/1.0 200 OK\r\n\r\n{"Self": {"DNSName": ""}}', b'HTTP/1.0 200 OK\r\n\r\n{"Self": {"DNSName": 5}}',
                      b'HTTP/1.0 200 OK\r\n\r\n{"Self": null}', b""):
            self.assertIsNone(await self.name_from(reply), reply)

    async def test_no_socket_gives_no_name(self):
        with patch.object(srv.network, "TAILSCALE_SOCKET", "/nonexistent/tailscaled.sock"):
            self.assertIsNone(await srv.tailscale_name())


class SlowNetwork(Harness):
    async def test_reporting_in_tells_the_page_how_far_along_the_stream_is(self):
        _, _, viewer = await self.watch()
        await self.until(lambda: self.server.seq >= 3, what="ticks to pass")
        status, body = await self.post("/api/alive", {"viewer": viewer})
        self.assertEqual(status, 200)
        self.assertGreaterEqual(body["seq"], 3)


class PacketLoss(unittest.TestCase):
    def received(self, telemetry, seq):
        sender = L.MAVLink(None, srcSystem=1, srcComponent=1)
        sender.seq = seq
        message = sender.system_time_encode(0, 1000)
        telemetry._on_message(L.MAVLink(None).parse_buffer(message.pack(sender))[0])

    def counted(self, sequence):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.target = (1, 1)
        for seq in sequence:
            self.received(telemetry, seq)
        return telemetry._seq_got, telemetry._seq_lost

    def test_a_gap_in_the_counter_is_loss(self):
        self.assertEqual(self.counted([10, 11, 14, 15]), (4, 2))

    def test_heartbeats_are_counted_with_the_rest(self):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.target = (1, 1)
        sender = L.MAVLink(None, srcSystem=1, srcComponent=1)
        parser = L.MAVLink(None)
        for seq, encode in enumerate((lambda: sender.system_time_encode(0, 1000),
                                      lambda: sender.heartbeat_encode(L.MAV_TYPE_QUADROTOR, L.MAV_AUTOPILOT_ARDUPILOTMEGA, 0, 0, 3),
                                      lambda: sender.system_time_encode(0, 2000))):
            sender.seq = seq
            telemetry._on_message(parser.parse_buffer(encode().pack(sender))[0])
        self.assertEqual((telemetry._seq_got, telemetry._seq_lost), (3, 0))

    def test_a_repeat_is_not_loss(self):
        self.assertEqual(self.counted([10, 11, 11, 12]), (4, 0))

    def test_the_counter_wraps(self):
        self.assertEqual(self.counted([254, 255, 0, 1]), (4, 0))

    def test_a_restart_after_a_silence_is_not_loss(self):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.target = (1, 1)
        self.received(telemetry, 200)
        telemetry._seq_at -= tel.SEQUENCE_SILENCE_S + 1
        self.received(telemetry, 0)
        self.assertEqual((telemetry._seq_got, telemetry._seq_lost), (2, 0))


class History(Harness):
    async def test_samples_reach_viewers_and_survive_a_reload(self):
        reader, writer, _ = await self.linked()
        await asyncio.wait_for(reader.readuntil(b"event: h\ndata: "), 6)
        sample = json.loads(await reader.readline())
        self.assertEqual(len(sample), 14)
        self.assertAlmostEqual(sample[11], fake_fc.HOME[0], delta=0.01)     # the position, for the flight path
        writer.close()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        self.connections.append(writer)
        await reader.readuntil(b"event: full\ndata: ")
        full = json.loads(await reader.readline())
        self.assertGreaterEqual(len(full["history"]), 1)

    async def test_no_samples_while_nobody_watches(self):
        await asyncio.sleep(2.5)
        self.assertEqual(len(self.telemetry.history), 0)


class NoLink(Harness):
    async def test_execution_refused_without_a_flight_controller(self):
        self.telemetry.port = 1
        _, _, viewer = await self.watch()
        status, body = await self.post("/api/exec/open", {"viewer": viewer})
        self.assertEqual((status, body["error"]), (409, "no_link"))


class Assets(Harness):
    async def test_static_files_and_no_path_traversal(self):
        status, head, _ = await self.raw("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Content-Security-Policy", head)
        for path in ("/../server.py", "/web/../../etc/passwd", "/server.py", "/.venv/pyvenv.cfg"):
            status, _, _ = await self.raw("GET", path)
            self.assertEqual(status, 404, path)


if __name__ == "__main__":
    unittest.main()
