"""The command table and the stored plans, end to end against the pretend flight controller."""
import asyncio
import json
import math
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tools"), str(ROOT / "tests")]

import commands  # noqa: E402
import fake_fc  # noqa: E402
import marks  # noqa: E402
import plans  # noqa: E402
import server as srv  # noqa: E402
import telemetry as tel  # noqa: E402
from test_server import READ_ONLY_COMMANDS, Harness  # noqa: E402
from telemetry import L  # noqa: E402

MISSION, FENCE, RALLY = fake_fc.MISSION, fake_fc.FENCE, fake_fc.RALLY
READ_ONLY_MESSAGES = {"COMMAND_LONG", "PARAM_REQUEST_READ", "MISSION_REQUEST_LIST", "MISSION_REQUEST_INT", "MISSION_ACK"}
NEAR = fake_fc._at(50, 50)
WAYPOINT = {"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": NEAR[0], "lon": NEAR[1], "alt": 20}


def quickly(test, module, **values):
    """Shortens a wait for one test."""
    for name, value in values.items():
        test.addCleanup(setattr, module, name, getattr(module, name))
        setattr(module, name, value)


class Table(unittest.TestCase):
    def test_every_action_can_be_described_to_a_client(self):
        entries = commands.catalog()
        self.assertEqual(len({e["name"] for e in entries}), len(entries))
        json.dumps(entries)
        for e in entries:
            self.assertIn(e["risk"], commands.HOLD_MS)
            self.assertGreaterEqual(e["hold_ms"], 1000)
            self.assertTrue(e["summary"])
            schema = e["input_schema"]
            self.assertEqual(schema["additionalProperties"], False)
            for name, spec in schema["properties"].items():
                self.assertIn(spec["type"], ("number", "integer", "boolean", "string", "array"), (e["name"], name))
                self.assertEqual(name in schema["required"], "default" not in spec)

    def test_everything_dangerous_has_a_rule_or_says_why_not(self):
        for action in commands.ACTIONS.values():
            if action.risk == commands.DANGER:
                self.assertIsNotNone(action.state, action.name)

    def test_every_setting_that_can_be_written_is_also_read(self):
        self.assertLessEqual(set(commands.EDITABLE), set(tel.WANTED_PARAMS))

    def test_a_motor_number_is_sent_as_its_place_in_the_test_order(self):
        """The firmware's motor test takes a place in the order it goes round in. Both tables are from
        AP_MotorsMatrix's quad X: the commands' by motor number, the pretend flight controller's by place."""
        for motor, place in commands.QUAD_X_TEST_ORDER.items():
            self.assertEqual(fake_fc.MOTOR_AT_TEST_PLACE[place], motor)
        self.assertEqual(sorted(commands.QUAD_X_TEST_ORDER.values()), [1, 2, 3, 4])

    def test_takeoff_must_be_to_above_where_it_is(self):
        on_a_rise = SimpleNamespace(height=6.2)
        self.assertEqual(commands._takeoff_check(on_a_rise, {"alt": 5}), "too_low")
        self.assertIsNone(commands._takeoff_check(on_a_rise, {"alt": 8}))
        self.assertIsNone(commands._takeoff_check(SimpleNamespace(height=.3), {"alt": 1}))
        self.assertIsNone(commands._takeoff_check(SimpleNamespace(height=None), {"alt": 5}))    # not known: the flight controller decides

    def test_what_counts_as_outside_the_fence(self):
        home = (*fake_fc.HOME, 584)
        at = fake_fc._at
        poly = [{"cmd": plans.FENCE_POLY_IN, "lat": lat, "lon": lon, "p": [4, 0, 0, 0]}
                for lat, lon in (at(-50, -50), at(50, -50), at(50, 50), at(-50, 50))]
        keep_out = [{"cmd": plans.FENCE_CIRCLE_OUT, "lat": at(20, 20)[0], "lon": at(20, 20)[1], "p": [10, 0, 0, 0]}]
        outside = commands._outside_fence
        self.assertFalse(outside(at(10, 10), 300, home, {}, poly))                          # no fence of any kind set
        self.assertTrue(outside(at(0, 0), 61, home, {"FENCE_TYPE": 1, "FENCE_ALT_MAX": 60}, []))
        self.assertFalse(outside(at(0, 0), 59, home, {"FENCE_TYPE": 1, "FENCE_ALT_MAX": 60}, []))
        self.assertTrue(outside(at(0, 121), 10, home, {"FENCE_TYPE": 2, "FENCE_RADIUS": 120}, []))
        self.assertFalse(outside(at(0, 119), 10, home, {"FENCE_TYPE": 2, "FENCE_RADIUS": 120}, []))
        self.assertFalse(outside(at(0, 121), 10, None, {"FENCE_TYPE": 2, "FENCE_RADIUS": 120}, []))    # no home to measure from
        self.assertFalse(outside(at(40, 40), 10, home, {"FENCE_TYPE": 4}, poly))
        self.assertTrue(outside(at(60, 0), 10, home, {"FENCE_TYPE": 4}, poly))
        self.assertTrue(outside(at(20, 20), 10, home, {"FENCE_TYPE": 4}, poly + keep_out))
        self.assertFalse(outside(at(40, 40), 10, home, {"FENCE_TYPE": 4}, poly + keep_out))
        self.assertFalse(outside(at(60, 0), 10, home, {"FENCE_TYPE": 3, "FENCE_ALT_MAX": 60, "FENCE_RADIUS": 120}, poly))   # polygons not in force
        self.assertFalse(outside(None, None, home, {"FENCE_TYPE": 7, "FENCE_RADIUS": 1}, poly))


class Replies(unittest.IsolatedAsyncioTestCase):
    async def test_two_of_the_same_command_each_get_their_own_answer(self):
        """A kill sent while a disarm is still waiting: the refusal belongs to the disarm."""
        t = tel.Telemetry("127.0.0.1", 1)
        command = L.MAV_CMD_COMPONENT_ARM_DISARM
        first = asyncio.create_task(t._acknowledged(command, lambda: None, 1))
        second = asyncio.create_task(t._acknowledged(command, lambda: None, 1))
        await asyncio.sleep(0)
        for result in (L.MAV_RESULT_FAILED, L.MAV_RESULT_ACCEPTED):
            t._on_command_ack(L.MAVLink_command_ack_message(command, result, 0, 0, tel.SYSID, tel.COMPID))
        self.assertEqual((await first, await second), (L.MAV_RESULT_FAILED, L.MAV_RESULT_ACCEPTED))
        self.assertEqual(t.acks[command], [])

    async def test_no_answer_leaves_nothing_waiting(self):
        t = tel.Telemetry("127.0.0.1", 1)
        self.assertIsNone(await t._acknowledged(L.MAV_CMD_DO_SET_MODE, lambda: None, .05))
        self.assertEqual(t.acks[L.MAV_CMD_DO_SET_MODE], [])

    async def test_an_answer_that_comes_as_the_wait_runs_out_is_dropped(self):
        t = tel.Telemetry("127.0.0.1", 1)
        command = L.MAV_CMD_DO_SET_MODE
        gone = asyncio.get_running_loop().create_future()
        gone.cancel()                       # timed out, and not yet taken off the list
        t.acks[command] = [gone]
        t._on_command_ack(L.MAVLink_command_ack_message(command, L.MAV_RESULT_ACCEPTED, 0, 0, tel.SYSID, tel.COMPID))
        self.assertEqual(t.acks[command], [])

    def test_input_is_held_to_its_schema(self):
        takeoff = commands.ACTIONS["takeoff"]
        self.assertEqual(commands.clean(takeoff, {}), {"alt": 5})
        self.assertEqual(commands.clean(takeoff, {"alt": 10}), {"alt": 10})
        for bad in ({"alt": 0}, {"alt": 121}, {"alt": "10"}, {"alt": True}, {"alt": None}, {"alt": math.nan},
                    {"alt": math.inf}, {"alt": [5]}, {"alt": 5, "extra": 1}, "alt", [1]):
            with self.assertRaises(commands.BadParam, msg=bad):
                commands.clean(takeoff, bad)
        with self.assertRaises(commands.BadParam):
            commands.clean(commands.ACTIONS["goto"], {"lat": 33.0, "lon": -117.0})     # no height given

    def test_nan_in_a_request_body_is_refused(self):
        # Python's parser accepts NaN, though JSON has no such thing.
        given = json.loads('{"alt": NaN}')
        with self.assertRaises(commands.BadParam):
            commands.clean(commands.ACTIONS["takeoff"], given)


class CheckingPlans(unittest.TestCase):
    def test_a_good_mission_gets_a_home_placeholder(self):
        prepared = plans.check("mission", [{"cmd": L.MAV_CMD_NAV_TAKEOFF, "alt": 10}, WAYPOINT])
        self.assertEqual(len(prepared), 3)
        self.assertEqual(prepared[1][0], L.MAV_CMD_NAV_TAKEOFF)
        self.assertEqual(prepared[2][4], 20.0)

    def test_a_mission_that_could_hurt_is_refused(self):
        bad = [
            [],
            "items",
            [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": NEAR[0], "lon": NEAR[1]}],                  # no height: into the ground
            [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": NEAR[0], "lon": NEAR[1], "alt": 0}],
            [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "alt": 20}],                                       # nowhere
            [{"cmd": L.MAV_CMD_NAV_TAKEOFF}],
            [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": 91, "lon": 0, "alt": 20}],
            [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": NEAR[0], "lon": NEAR[1], "alt": math.nan}],
            [{**WAYPOINT, "alt": 900}],
            [{**WAYPOINT, "frame": L.MAV_FRAME_GLOBAL}],                                        # above sea level, not home
            [{"cmd": L.MAV_CMD_DO_SET_SERVO, "p": [5, 2000, 0, 0]}],                            # could spin a motor
            [{"cmd": L.MAV_CMD_DO_JUMP, "p": [9, 1, 0, 0]}],
            [{**WAYPOINT, "p": [0, 0]}],
            [{**WAYPOINT, "p": [math.inf, 0, 0, 0]}],
            ["not an item"],
        ]
        for items in bad:
            with self.assertRaises(plans.BadPlan, msg=items):
                plans.check("mission", items)

    def test_blanks_become_what_the_firmware_accepts(self):
        # Real firmware refused a return to launch with a NaN in it, and kept the items before it.
        prepared = plans.check("mission", [{"cmd": L.MAV_CMD_NAV_TAKEOFF, "alt": 10, "p": [0, 0, 0, None]},
                                           {**WAYPOINT, "p": [0, 0, 0, None]},
                                           {"cmd": L.MAV_CMD_NAV_RETURN_TO_LAUNCH, "p": [0, 0, 0, None]}])
        self.assertTrue(math.isnan(prepared[1][5][3]))
        self.assertTrue(math.isnan(prepared[2][5][3]))
        self.assertEqual(prepared[3][5], [0.0, 0.0, 0.0, 0.0])

    def test_a_fence_polygon_must_hold_together(self):
        vertex = {"cmd": plans.FENCE_POLY_IN, "lat": NEAR[0], "lon": NEAR[1], "p": [3, 0, 0, 0]}
        self.assertEqual(len(plans.check("fence", [vertex, vertex, vertex])), 3)
        for items in ([vertex, vertex], [vertex, vertex, {**vertex, "p": [4, 0, 0, 0]}],
                      [{**vertex, "p": [2, 0, 0, 0]}] * 2,
                      [{"cmd": plans.FENCE_CIRCLE_IN, "lat": NEAR[0], "lon": NEAR[1], "p": [0, 0, 0, 0]}],
                      [{"cmd": plans.FENCE_RETURN, "lat": NEAR[0], "lon": NEAR[1]}] * 2,
                      [{"cmd": L.MAV_CMD_NAV_WAYPOINT, "lat": NEAR[0], "lon": NEAR[1]}]):
            with self.assertRaises(plans.BadPlan, msg=items):
                plans.check("fence", items)

    def test_a_rally_point_needs_a_height(self):
        self.assertEqual(len(plans.check("rally", [{"lat": NEAR[0], "lon": NEAR[1], "alt": 15}])), 1)
        with self.assertRaises(plans.BadPlan):
            plans.check("rally", [{"lat": NEAR[0], "lon": NEAR[1]}])


class ReadingPlans(Harness):
    scenario = "flight"

    def setUp(self):
        quickly(self, plans.PlanStore, START_S=0, STEP_S=.05, RETRY_S=.2)

    def plan(self, kind):
        return (self.telemetry.state.get("plan") or {}).get(kind, {})

    async def until_read(self):
        await self.linked()
        await self.until(lambda: all(self.plan(kind).get("at") for kind in plans.KINDS), what="the plans to be read")

    async def test_all_three_plans_reach_the_stream(self):
        await self.until_read()
        mission = self.plan("mission")["items"]
        self.assertEqual(len(mission), len(self.vehicle.plans[MISSION]))
        self.assertEqual(mission[0]["seq"], 0)
        self.assertAlmostEqual(mission[0]["lat"], fake_fc.HOME[0], places=5)      # home sits in the first slot
        self.assertEqual(mission[1]["cmd"], L.MAV_CMD_NAV_TAKEOFF)
        self.assertIsNone(mission[1]["lat"])                                      # a takeoff has no place of its own
        self.assertEqual(mission[1]["alt"], 15)
        speed = next(item for item in mission if item["cmd"] == L.MAV_CMD_DO_CHANGE_SPEED)
        self.assertEqual(speed["p"][1], 4)
        self.assertEqual(len(self.plan("fence")["items"]), len(self.vehicle.plans[FENCE]))
        self.assertEqual(len(self.plan("rally")["items"]), 2)
        json.dumps(self.telemetry.state["plan"], allow_nan=False)
        self.assertEqual(self.telemetry.plans.waypoints(), len(self.vehicle.plans[MISSION]) - 1)

    async def test_a_new_viewer_gets_the_plan_in_its_first_frame(self):
        await self.until_read()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        self.connections.append(writer)
        await reader.readuntil(b"event: full\ndata: ")
        full = json.loads(await reader.readline())
        self.assertEqual(len(full["plan"]["rally"]["items"]), 2)

    async def test_reading_sends_nothing_but_reads(self):
        await self.until_read()
        await asyncio.sleep(.3)
        self.assertLessEqual(set(self.vehicle.received), READ_ONLY_MESSAGES)
        self.assertLessEqual({c[0] for c in self.vehicle.commands}, READ_ONLY_COMMANDS)

    async def test_a_lost_item_is_asked_for_again(self):
        quickly(self, plans, ITEM_TIMEOUT_S=.1)
        self.vehicle.drop_items = [0, 2, 2]
        await self.until_read()
        self.assertEqual([i["seq"] for i in self.plan("mission")["items"]], list(range(len(self.vehicle.plans[MISSION]))))

    async def test_a_refusal_is_reported_and_keeps_what_was_known(self):
        await self.until_read()
        known = self.plan("rally")["items"]
        self.vehicle.deny_reads.add(RALLY)
        self.telemetry.plans.mark_dirty("rally")
        await self.until(lambda: self.plan("rally")["err"] == "denied", what="the refusal")
        self.assertEqual(self.plan("rally")["items"], known)
        self.vehicle.deny_reads.clear()
        await self.until(lambda: self.plan("rally")["err"] is None, what="the next read to work")

    async def test_silence_is_reported_and_does_not_block_the_rest(self):
        quickly(self, plans, COUNT_TIMEOUT_S=.05, ITEM_TIMEOUT_S=.05, TRIES=2)
        await self.until_read()
        self.vehicle.drop_items = [1] * 4
        self.telemetry.plans.mark_dirty("mission")
        await self.until(lambda: self.plan("mission")["err"] == "no_reply", what="the failure")
        self.assertEqual(len(self.plan("mission")["items"]), len(self.vehicle.plans[MISSION]))

    async def test_a_changed_mission_is_noticed(self):
        quickly(self, tel, POLL_STEP_S=.02)
        await self.until_read()
        self.vehicle.plans[MISSION] = self.vehicle.plans[MISSION][:3]
        self.telemetry.ask_for(L.MAVLINK_MSG_ID_MISSION_CURRENT)
        await self.until(lambda: len(self.plan("mission")["items"]) == 3, what="the shorter mission")

    async def test_refreshing_needs_no_execution_and_commands_nothing(self):
        await self.until_read()
        self.vehicle.plans[RALLY] = []
        status, _ = await self.post("/api/plan/refresh")
        self.assertEqual(status, 200)
        await self.until(lambda: not self.plan("rally")["items"], what="the rally points to go")
        self.assertLessEqual(set(self.vehicle.received), READ_ONLY_MESSAGES)

    async def test_a_busy_link_is_left_alone(self):
        with patch.object(tel.Telemetry, "link_busy", lambda _: True):
            await self.linked()
            await asyncio.sleep(.3)
            self.assertNotIn("MISSION_REQUEST_LIST", self.vehicle.received)

    async def test_a_reboot_means_reading_again(self):
        await self.until_read()
        self.telemetry._last_boot_ms = 10 ** 9
        self.vehicle.received.clear()
        self.telemetry._check_reboot(1000)
        await self.until(lambda: "MISSION_REQUEST_LIST" in self.vehicle.received, what="another read")


class Commanding(Harness):
    def setUp(self):
        quickly(self, commands, SETTLE_S=1.5)

    async def known(self, opened=True):
        token = await self.opened() if opened else None
        if not opened:
            await self.linked()
        await self.until(lambda: "landed" in self.telemetry.state and "ekf" in self.telemetry.state
                         and "pos" in self.telemetry.state and "sens" in self.telemetry.state, what="the state to be known")
        return token

    async def airborne(self, token, alt=10):
        for action, params in (("mode", {"mode": commands.GUIDED}), ("arm", {}), ("takeoff", {"alt": alt})):
            self.server.gate.last_run = 0
            status, body = await self.run_command(token, action=action, **params)
            self.assertEqual((status, body.get("result")), (200, 0), action)
        self.vehicle.alt = alt
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_IN_AIR, what="to be in the air")

    async def refused(self, token, reason, action, **params):
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action=action, **params)
        self.assertEqual((status, body.get("error")), (409, reason), action)

    async def accepted(self, token, action, **params):
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action=action, **params)
        self.assertEqual((status, body.get("result")), (200, 0), (action, body))
        return body

    async def test_the_table_is_served_to_anyone_who_can_read_the_page(self):
        status, _, content = await self.raw("GET", "/api/commands")
        self.assertEqual(status, 200)
        self.assertEqual({e["name"] for e in json.loads(content)["commands"]}, set(commands.ACTIONS))
        status, _, _ = await self.raw("GET", "/api/commands", {"Host": "evil.example"})
        self.assertEqual(status, 421)

    async def test_no_action_runs_without_the_token(self):
        await self.known(opened=False)
        for name in commands.ACTIONS:
            status, _ = await self.post("/api/exec/run", {"action": name, "seq": self.server.seq, "params": {}})
            self.assertEqual(status, 403, name)
        self.assertLessEqual(set(self.vehicle.received), READ_ONLY_MESSAGES)
        self.assertLessEqual({c[0] for c in self.vehicle.commands}, READ_ONLY_COMMANDS)

    async def test_takeoff_needs_guided_armed_and_the_ground(self):
        token = await self.known()
        await self.refused(token, "not_armed", "takeoff", alt=5)
        self.vehicle.grounded = True    # stays on the ground when armed, whatever the mode
        await self.accepted(token, "arm")
        await self.refused(token, "not_guided", "takeoff", alt=5)
        await self.accepted(token, "mode", mode=commands.GUIDED)
        await self.accepted(token, "takeoff", alt=7)
        self.vehicle.grounded = False
        self.assertEqual(self.vehicle.climb_to, 7)
        self.vehicle.alt = 7
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_IN_AIR, what="to be in the air")
        await self.refused(token, "not_on_ground", "takeoff", alt=5)

    async def test_takeoff_is_not_sent_without_an_estimate_of_position(self):
        token = await self.known()
        await self.accepted(token, "mode", mode=commands.GUIDED)
        await self.accepted(token, "arm")
        self.telemetry.state["ekf"]["flags"] = 0
        await self.refused(token, "no_position", "takeoff", alt=5)

    async def test_goto_and_its_limits(self):
        token = await self.known()
        lat, lon = fake_fc._at(30, 40)
        await self.refused(token, "not_armed", "goto", lat=lat, lon=lon, alt=10)
        await self.airborne(token)
        far = fake_fc._at(5000, 0)
        await self.refused(token, "too_far", "goto", lat=far[0], lon=far[1], alt=10)
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="goto", lat=lat, lon=lon, alt=500)
        self.assertEqual((status, body["error"], body["field"]), (409, "bad_param", "alt"))
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=12)
        self.assertAlmostEqual(self.vehicle.guided[0], 30, delta=.1)
        self.assertAlmostEqual(self.vehicle.guided[1], 40, delta=.1)
        self.assertEqual(self.vehicle.guided[2], 12)
        await self.until(lambda: self.telemetry.state.get("target"), what="the target to be reported")
        self.assertAlmostEqual(self.telemetry.state["target"][0], lat, places=5)
        await self.accepted(token, "mode", mode=commands.LOITER)
        await self.refused(token, "not_guided", "goto", lat=lat, lon=lon, alt=10)

    async def test_fly_here_can_switch_to_guided_itself(self):
        token = await self.known()
        await self.airborne(token)
        await self.accepted(token, "mode", mode=commands.LOITER)
        await self.until(lambda: self.telemetry.state.get("mode") == commands.LOITER, what="Loiter")
        lat, lon = fake_fc._at(20, 20)
        await self.refused(token, "not_guided", "goto", lat=lat, lon=lon, alt=10)
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=10, change_mode=True)
        self.assertEqual(self.vehicle.mode, commands.GUIDED)
        self.assertAlmostEqual(self.vehicle.guided[0], 20, delta=.1)
        self.assertIn(L.MAV_DO_REPOSITION_FLAGS_CHANGE_MODE, {c[2] for c in self.vehicle.commands if c[0] == L.MAV_CMD_DO_REPOSITION})

    async def test_land_here_flies_there_then_lands(self):
        token = await self.known()
        await self.airborne(token, alt=8)
        await self.accepted(token, "mode", mode=commands.BRAKE)
        lat, lon = fake_fc._at(6, 0)
        await self.accepted(token, "land_at", lat=lat, lon=lon, alt=8)
        self.assertEqual(self.vehicle.mode, commands.GUIDED)
        self.assertEqual(self.telemetry.state["pending"], {"lat": lat, "lon": lon})
        self.assertNotEqual(self.vehicle.mode, commands.LAND)
        await self.until(lambda: self.vehicle.mode == commands.LAND, timeout=12, what="the landing on arrival")
        self.assertIsNone(self.telemetry.state["pending"])
        await self.until(lambda: self.telemetry.state["cmds"][0][3] == "landing", what="the record of it")

    async def test_a_landing_on_arrival_gives_way(self):
        token = await self.known()
        await self.airborne(token, alt=8)
        far = fake_fc._at(100, 100)
        for cancel, params in (("land_cancel", {}), ("mode", {"mode": commands.LOITER})):
            await self.accepted(token, "land_at", lat=far[0], lon=far[1], alt=8)
            self.assertTrue(self.telemetry.state["pending"])
            await self.accepted(token, cancel, **params)
            self.assertIsNone(self.telemetry.state["pending"])
        await self.accepted(token, "land_at", lat=far[0], lon=far[1], alt=8)
        await self.until(lambda: self.telemetry.state.get("mode") == commands.GUIDED, what="Guided")
        await self.accepted(token, "speed", speed=9)      # how fast it goes does not change where it lands
        self.assertTrue(self.telemetry.state["pending"])

    async def test_a_landing_on_arrival_stops_if_the_mode_changes_by_other_means(self):
        quickly(self, commands, MODE_SETTLE_S=.5)
        token = await self.known()
        await self.airborne(token, alt=8)
        far = fake_fc._at(100, 100)
        await self.accepted(token, "land_at", lat=far[0], lon=far[1], alt=8)
        self.vehicle.mode = commands.LOITER        # from the sticks, say
        await self.until(lambda: self.telemetry.state["pending"] is None, what="it to give up")
        self.assertEqual(self.vehicle.mode, commands.LOITER)
        self.assertEqual(self.telemetry.state["cmds"][0][3], "cancelled")

    async def test_home_can_be_set_at_a_place(self):
        token = await self.known()
        lat, lon = fake_fc._at(30, 30)
        await self.accepted(token, "set_home", lat=lat, lon=lon)
        self.assertAlmostEqual(self.vehicle.home_at[0], lat, places=6)
        self.assertEqual(self.vehicle.home_at[2], fake_fc.HOME_MSL)      # it keeps the height it has
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="set_home", lat=lat)
        self.assertEqual((status, body["error"]), (409, "bad_place"))
        await self.accepted(token, "set_home")      # and still the present position, with neither
        await self.accepted(token, "arm")
        await self.refused(token, "armed", "set_home", lat=lat, lon=lon)

    async def test_a_new_height_keeps_the_destination(self):
        token = await self.known()
        await self.airborne(token)
        lat, lon = fake_fc._at(30, 40)
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=12)
        await self.until(lambda: self.telemetry.state.get("target"), what="the target to be reported")
        await self.accepted(token, "altitude", alt=25)
        self.assertAlmostEqual(self.vehicle.guided[0], 30, delta=.1)
        self.assertEqual(self.vehicle.guided[2], 25)

    async def test_speed_yaw_pause_and_resume(self):
        token = await self.known()
        await self.refused(token, "not_armed", "speed", speed=3)
        await self.refused(token, "not_armed", "pause")
        await self.airborne(token)
        await self.accepted(token, "speed", speed=3)
        self.assertEqual(self.vehicle.speed, 3)
        await self.accepted(token, "yaw", heading=90)
        self.assertEqual(self.vehicle.heading, 90)
        await self.accepted(token, "pause")
        self.assertTrue(self.vehicle.paused)
        await self.accepted(token, "resume")
        self.assertFalse(self.vehicle.paused)
        await self.accepted(token, "mode", mode=commands.LOITER)
        await self.refused(token, "not_steered", "speed", speed=3)

    async def test_a_new_place_ends_a_pause(self):
        """ArduCopter keeps a pause across a new destination: it would accept it and not move."""
        token = await self.known()
        await self.airborne(token)
        lat, lon = fake_fc._at(20, 0)
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=10)
        await self.accepted(token, "pause")
        self.assertTrue(self.vehicle.paused)
        lat, lon = fake_fc._at(0, 20)
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=10)
        self.assertFalse(self.vehicle.paused)
        self.assertAlmostEqual(self.vehicle.guided[1], 20, delta=.1)
        await self.accepted(token, "pause")
        await self.accepted(token, "altitude", alt=15)
        self.assertFalse(self.vehicle.paused)
        await self.accepted(token, "pause")
        await self.accepted(token, "land_at", lat=lat, lon=lon, alt=10)
        self.assertFalse(self.vehicle.paused)

    async def test_a_pause_that_cannot_be_ended_is_said(self):
        token = await self.known()
        await self.airborne(token)
        lat, lon = fake_fc._at(20, 0)
        with patch.object(tel.Telemetry, "command", side_effect=lambda *a, **k: asyncio.sleep(0, L.MAV_RESULT_FAILED)):
            body = await self.accepted(token, "goto", lat=lat, lon=lon, alt=10)
        self.assertTrue(any("Resume" in line for line in body["said"]), body)

    async def test_a_speed_asked_for_in_guided_holds_for_the_next_place(self):
        """The firmware starts its first destination after a takeoff from its usual speed again."""
        token = await self.known()
        await self.airborne(token)
        await self.accepted(token, "speed", speed=3)
        self.assertEqual(self.telemetry.state["asked_speed"], 3)
        lat, lon = fake_fc._at(30, 0)
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=10)
        self.assertEqual(self.vehicle.speed, 3)
        await self.accepted(token, "speed", speed=4)
        await self.accepted(token, "altitude", alt=12)
        self.assertEqual(self.vehicle.speed, 4)
        # It is forgotten on leaving Guided, as the firmware forgets it: the next time starts afresh.
        await self.accepted(token, "mode", mode=commands.LOITER)
        await self.until(lambda: self.telemetry.state.get("asked_speed") is None, what="the speed to be forgotten")
        await self.accepted(token, "goto", lat=lat, lon=lon, alt=10, change_mode=True)
        self.assertEqual(self.vehicle.speed, fake_fc.USUAL_SPEED)

    async def test_a_speed_asked_for_in_auto_is_left_to_the_mission(self):
        token = await self.known()
        await self.airborne(token)
        self.vehicle.mode = commands.AUTO
        await self.until(lambda: self.telemetry.state.get("mode") == commands.AUTO, what="Auto")
        await self.accepted(token, "speed", speed=3)
        self.assertIsNone(self.telemetry.state.get("asked_speed"))

    async def test_a_new_height_does_not_send_it_where_another_mode_was_going(self):
        """A waypoint a mission was flying to stays on record for a few seconds after the mode changes."""
        token = await self.known()
        await self.airborne(token)
        self.vehicle.plans[MISSION] = fake_fc.sample_plan()[MISSION]
        self.vehicle.mode, self.vehicle.mission_running, self.vehicle.current = commands.AUTO, True, 2
        await self.until(lambda: self.telemetry.state.get("mode") == commands.AUTO and self.telemetry.state.get("target"),
                         what="the mission's waypoint to be reported")
        await self.accepted(token, "mode", mode=commands.GUIDED)
        self.assertIsNone(self.telemetry.state.get("target"))
        await self.accepted(token, "altitude", alt=25)
        v = self.vehicle
        self.assertLess(math.hypot(v.guided[0] - v.north, v.guided[1] - v.east), 3)    # where it is, not the waypoint 40 m on
        self.assertEqual(v.guided[2], 25)

    async def test_a_landing_on_arrival_is_given_up_when_execution_is_turned_off(self):
        token = await self.known()
        await self.airborne(token, alt=8)
        far = fake_fc._at(60, 0)
        await self.accepted(token, "land_at", lat=far[0], lon=far[1], alt=8)
        self.assertIsNotNone(self.server.commander.pending)
        status, _ = await self.post("/api/exec/close", token=token)
        self.assertEqual(status, 200)
        await self.until(lambda: self.server.commander.pending is None, what="the landing to be given up")
        self.assertIsNone(self.telemetry.state["pending"])
        self.assertEqual(self.telemetry.state["cmds"][0][1:], ["land_at", {}, "cancelled"])
        self.vehicle.north, self.vehicle.east = 60, 0       # it gets there all the same, and holds
        await asyncio.sleep(.8)
        self.assertEqual(self.vehicle.mode, commands.GUIDED)

    async def test_a_landing_on_arrival_is_given_up_when_its_holder_leaves(self):
        token = await self.known()
        await self.airborne(token, alt=8)
        far = fake_fc._at(60, 0)
        await self.accepted(token, "land_at", lat=far[0], lon=far[1], alt=8)
        self.owner_writer.close()
        await self.until(lambda: self.server.commander.pending is None, what="the landing to be given up")
        self.vehicle.north, self.vehicle.east = 60, 0
        await asyncio.sleep(.8)
        self.assertEqual(self.vehicle.mode, commands.GUIDED)
        await self.linked()                                 # and someone looking in later does not set it off
        await asyncio.sleep(.6)
        self.assertEqual(self.vehicle.mode, commands.GUIDED)

    async def test_modes_are_refused_for_what_they_would_lack(self):
        token = await self.known()
        await self.refused(token, "no_mission", "mode", mode=commands.AUTO)
        self.telemetry.state["ekf"]["flags"] = 0
        for mode in sorted(commands.FLIES_ON_POSITION):
            await self.refused(token, "no_position", "mode", mode=mode)
        await self.accepted(token, "mode", mode=commands.LAND)     # always there
        self.telemetry.state["ekf"]["flags"] = 0x3F
        self.telemetry.state["home"] = None
        self.vehicle.mute.add(L.MAVLINK_MSG_ID_HOME_POSITION)
        await self.refused(token, "no_home", "mode", mode=commands.RTL)

    async def test_availability_says_why_for_the_page(self):
        await self.known()
        avail = self.server.commander.availability()
        self.assertEqual(avail["takeoff"], "not_armed")
        self.assertEqual(avail["reboot"] if "reboot" in avail else None, None)
        self.assertEqual(avail["mode"]["3"], "no_mission")
        self.assertNotIn("arm", avail)
        await self.until(lambda: self.telemetry.state.get("avail"), what="availability to be published")

    async def test_availability_with_no_link(self):
        self.telemetry.port = 1
        self.assertEqual(self.server.commander.availability(), {"*": "no_link"})

    async def test_settings(self):
        token = await self.known()
        await self.until(lambda: "RTL_ALT_M" in self.telemetry.params, what="the setting to be read")
        await self.accepted(token, "param_set", name="RTL_ALT_M", value=30)
        self.assertEqual(self.vehicle.params["RTL_ALT_M"], 30)
        await self.until(lambda: self.telemetry.state["params"]["RTL_ALT_M"] == 30, what="the new value to show")
        await self.refused(token, "out_of_range", "param_set", name="RTL_ALT_M", value=1500)   # centimetres, by habit
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="param_set", name="SERVO5_FUNCTION", value=0)
        self.assertEqual((status, body["error"]), (409, "bad_param"))
        await self.accepted(token, "arm")
        await self.refused(token, "armed", "param_set", name="RTL_ALT_M", value=20)
        self.assertEqual(self.vehicle.params["RTL_ALT_M"], 30)

    async def test_a_setting_the_flight_controller_changes_is_not_called_done(self):
        token = await self.known()
        original = fake_fc.Connection.on_message

        def rounded(conn, m):
            if m.get_type() == "PARAM_SET":
                m.param_value = 10.0
            original(conn, m)
        with patch.object(fake_fc.Connection, "on_message", rounded):
            self.server.gate.last_run = 0
            status, body = await self.run_command(token, action="param_set", name="WP_SPD", value=7)
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_FAILED))

    async def test_calibration_and_motor_test_only_on_the_ground_and_disarmed(self):
        token = await self.known()
        await self.accepted(token, "calibrate", what="gyro")
        sent = [c for c in self.vehicle.commands if c[0] == L.MAV_CMD_PREFLIGHT_CALIBRATION]
        self.assertEqual(sent[-1], (L.MAV_CMD_PREFLIGHT_CALIBRATION, 1.0, 0.0))
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="calibrate", what="compass")
        self.assertEqual((status, body["error"]), (409, "bad_param"))
        await self.until(lambda: "FRAME_TYPE" in (self.telemetry.state.get("params") or {}), what="the frame to be known")
        await self.accepted(token, "motor_test", motor=2, throttle=15, seconds=2)
        self.assertEqual(self.vehicle.motor_tests, [(2, 0.0, 15.0, 2.0)])       # the motor that turned
        self.assertIn((L.MAV_CMD_DO_MOTOR_TEST, 3.0, 0.0), self.vehicle.commands)   # third in the order of the test
        for params in ({"motor": 5}, {"motor": 1, "throttle": 31}, {"motor": 1, "seconds": 6}, {"motor": 1.5}, {}):
            self.server.gate.last_run = 0
            status, body = await self.run_command(token, action="motor_test", **params)
            self.assertEqual((status, body.get("error")), (409, "bad_param"), params)
        self.assertEqual(len(self.vehicle.motor_tests), 1)
        await self.accepted(token, "arm")
        await self.refused(token, "armed", "motor_test", motor=1)
        await self.refused(token, "armed", "calibrate", what="level")
        await self.refused(token, "armed", "set_home")

    async def test_each_motor_number_turns_that_motor(self):
        token = await self.known()
        await self.until(lambda: "FRAME_TYPE" in (self.telemetry.state.get("params") or {}), what="the frame to be known")
        for motor in (1, 2, 3, 4):
            await self.accepted(token, "motor_test", motor=motor)
        self.assertEqual([test[0] for test in self.vehicle.motor_tests], [1, 2, 3, 4])

    async def test_no_motor_is_spun_on_a_frame_whose_numbering_is_not_known(self):
        token = await self.known()
        await self.refused(token, "unknown_frame", "motor_test", motor=1)       # before the frame has been read
        await self.until(lambda: "FRAME_TYPE" in (self.telemetry.state.get("params") or {}), what="the frame to be known")
        self.telemetry.params["FRAME_TYPE"] = 0.0       # a quad plus
        self.telemetry._set("params", dict(self.telemetry.state["params"], FRAME_TYPE=0.0))
        await self.refused(token, "unknown_frame", "motor_test", motor=1)
        self.assertEqual(self.vehicle.motor_tests, [])

    async def test_the_fence_is_not_turned_on_round_an_aircraft_outside_it(self):
        self.vehicle.params.update(FENCE_TYPE=2, FENCE_RADIUS=30)       # a circle of 30 m round home
        token = await self.known()
        await self.until(lambda: "FENCE_RADIUS" in (self.telemetry.state.get("params") or {}) and self.telemetry.state.get("home"),
                         what="the fence's size and home")
        await self.airborne(token)
        self.vehicle.north = 50
        await self.until(lambda: commands.Facts(self.telemetry).outside_fence, what="it to be seen outside")
        await self.refused(token, "outside_fence", "fence_enable", on=True)
        self.assertFalse(self.vehicle.fence_on)
        await self.accepted(token, "fence_enable", on=False)       # turning it off is never held back
        self.vehicle.north = 10
        await self.until(lambda: not commands.Facts(self.telemetry).outside_fence, what="it to be seen inside")
        await self.accepted(token, "fence_enable", on=True)
        self.assertTrue(self.vehicle.fence_on)

    async def test_fence_on_and_off_is_checked_against_the_telemetry(self):
        token = await self.known()
        body = await self.accepted(token, "fence_enable", on=True)
        self.assertTrue(body["effect"])
        self.assertTrue(self.vehicle.fence_on)
        body = await self.accepted(token, "fence_enable", on=False)
        self.assertTrue(body["effect"])

    async def test_accepted_but_nothing_happened_is_reported(self):
        token = await self.known()
        quickly(self, commands, SETTLE_S=.3)
        self.vehicle.ack_only.add(L.MAV_CMD_DO_SET_MODE)
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="mode", mode=commands.BRAKE)
        self.assertEqual((status, body["result"], body["effect"]), (200, 0, False))
        self.assertEqual(self.telemetry.state["cmds"][0][3], "no_effect")

    async def test_a_refusal_carries_the_flight_controllers_explanation(self):
        self.vehicle.prearm_ok = False
        token = await self.known()
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="arm")
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_FAILED))
        self.assertTrue(any("RC not found" in text for text in body["said"]), body)

    async def test_every_attempt_is_on_record(self):
        token = await self.known()
        await self.refused(token, "not_armed", "takeoff", alt=5)
        await self.accepted(token, "arm")
        record = self.telemetry.state["cmds"]
        self.assertEqual([entry[1] for entry in record], ["arm", "takeoff"])
        self.assertEqual([entry[3] for entry in record], ["accepted", "not_armed"])
        self.assertEqual(record[1][2], {"alt": 5})

    async def test_kill_stops_it_in_the_air_even_with_a_command_in_progress(self):
        token = await self.known()
        await self.refused(token, "not_armed", "kill")
        await self.airborne(token)
        self.server.gate.busy = True
        status, body = await self.run_command(token, action="kill")
        self.assertEqual((status, body["result"]), (200, 0))
        self.assertIn((L.MAV_CMD_COMPONENT_ARM_DISARM, 0.0, float(commands.FORCE_DISARM)), self.vehicle.commands)
        self.assertFalse(self.vehicle.armed)

    async def test_plain_disarm_still_needs_the_ground(self):
        token = await self.known()
        await self.airborne(token)
        await self.refused(token, "in_air", "disarm")
        self.assertTrue(self.vehicle.armed)

    async def test_mission_start_and_choosing_an_item(self):
        token = await self.known()
        await self.refused(token, "no_mission", "mission_item", seq=1)
        self.vehicle.plans = fake_fc.sample_plan()
        self.telemetry.plans.mark_dirty()
        await self.until(lambda: self.telemetry.plans.waypoints() > 0, timeout=8, what="the mission to be read")
        await self.refused(token, "no_such_item", "mission_item", seq=50)
        self.assertEqual((await self.accepted(token, "mission_item", seq=2))["effect"], True)
        self.assertEqual(self.vehicle.current, 2)
        await self.refused(token, "not_armed", "mission_start")
        await self.accepted(token, "arm")
        body = await self.accepted(token, "mission_start")
        self.assertTrue(body["effect"])
        self.assertEqual(self.vehicle.mode, commands.AUTO)

    async def test_execution_does_not_run_out_while_armed(self):
        token = await self.known()
        await self.accepted(token, "arm")
        quickly(self, srv, EXEC_TTL_S=.5)
        self.server.gate.touch()
        await asyncio.sleep(1)
        self.assertTrue(self.server.gate.active())
        self.vehicle.armed = False
        await self.until(lambda: self.telemetry.state.get("armed") is False, what="the disarm to be seen")
        await self.until(lambda: not self.server.gate.active(), what="execution to close")

    async def test_only_the_holder_may_send_a_long_body(self):
        token = await self.known()
        items = [WAYPOINT] * 40
        status, _ = await self.post("/api/exec/run", {"action": "plan_upload", "seq": self.server.seq,
                                                      "params": {"kind": "mission", "items": items}})
        self.assertEqual(status, 400)
        self.server.gate.last_run = 0
        status, _ = await self.run_command(token, action="plan_upload", kind="mission", items=items)
        self.assertEqual(status, 200)


class WritingPlans(Harness):
    def setUp(self):
        quickly(self, plans.PlanStore, START_S=0, STEP_S=.05)

    def plan(self, kind):
        return (self.telemetry.state.get("plan") or {}).get(kind, {})

    async def ready(self):
        token = await self.opened()
        await self.until(lambda: self.plan("rally").get("at"), what="the first read")
        self.server.gate.last_run = 0
        return token

    async def test_a_mission_is_written_and_read_back(self):
        token = await self.ready()
        items = [{"cmd": L.MAV_CMD_NAV_TAKEOFF, "alt": 10}, WAYPOINT, {"cmd": L.MAV_CMD_NAV_RETURN_TO_LAUNCH}]
        status, body = await self.run_command(token, action="plan_upload", kind="mission", items=items)
        self.assertEqual((status, body["result"]), (200, 0), body)
        stored = self.vehicle.plans[MISSION]
        self.assertEqual([i["command"] for i in stored[1:]], [i["cmd"] for i in items])
        self.assertAlmostEqual(stored[2]["x"] / 1e7, NEAR[0], places=6)
        self.assertEqual(stored[0]["x"], int(round(fake_fc.HOME[0] * 1e7)))      # home is not overwritten
        self.assertEqual(len(self.plan("mission")["items"]), 4)
        self.assertEqual(self.telemetry.state["cmds"][0][2], {"kind": "mission", "items": "3 items"})

    async def test_a_fence_and_rally_points_are_written(self):
        token = await self.ready()
        corner = [fake_fc._at(*c) for c in ((50, 0), (0, 50), (-50, 0))]
        fence = [{"cmd": plans.FENCE_POLY_IN, "lat": lat, "lon": lon, "p": [3, 0, 0, 0]} for lat, lon in corner]
        status, body = await self.run_command(token, action="plan_upload", kind="fence", items=fence)
        self.assertEqual((status, body["result"]), (200, 0), body)
        self.assertEqual(len(self.vehicle.plans[FENCE]), 3)
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="plan_upload", kind="rally",
                                              items=[{"lat": NEAR[0], "lon": NEAR[1], "alt": 15}])
        self.assertEqual((status, body["result"]), (200, 0), body)
        self.assertEqual(self.vehicle.plans[RALLY][0]["command"], L.MAV_CMD_NAV_RALLY_POINT)
        self.assertEqual(len(self.plan("rally")["items"]), 1)

    async def test_a_bad_plan_never_reaches_the_flight_controller(self):
        token = await self.ready()
        status, body = await self.run_command(token, action="plan_upload", kind="mission", items=[{"cmd": L.MAV_CMD_NAV_WAYPOINT}])
        self.assertEqual((status, body["error"]), (409, "bad_plan"))
        self.assertNotIn("MISSION_COUNT", self.vehicle.received)

    async def test_nothing_is_written_or_erased_while_armed(self):
        self.vehicle.armed = True
        token = await self.ready()
        await self.until(lambda: self.telemetry.state.get("armed"), what="armed state")
        status, body = await self.run_command(token, action="plan_upload", kind="mission", items=[WAYPOINT])
        self.assertEqual((status, body["error"]), (409, "armed"))
        status, body = await self.run_command(token, action="plan_clear", kind="mission")
        self.assertEqual((status, body["error"]), (409, "armed"))
        self.assertNotIn("MISSION_COUNT", self.vehicle.received)
        self.assertNotIn("MISSION_CLEAR_ALL", self.vehicle.received)

    async def test_an_interrupted_upload_is_not_called_done_and_the_page_sees_what_is_left(self):
        quickly(self, plans, UPLOAD_TIMEOUT_S=.3)
        quickly(self, plans.PlanStore, RETRY_S=.1)
        token = await self.ready()
        self.vehicle.plans = fake_fc.sample_plan()
        self.vehicle.stall_upload_at = 2
        items = [WAYPOINT, WAYPOINT, WAYPOINT]
        status, body = await self.run_command(token, action="plan_upload", kind="mission", items=items)
        self.assertEqual(status, 200)
        self.assertIsNone(body["result"])
        self.assertEqual(self.telemetry.state["cmds"][0][3], "no_reply")
        self.assertIn("MISSION_ACK", self.vehicle.received)     # it is told, so it can stop waiting
        self.assertIsNone(self.vehicle.upload)
        self.assertEqual(len(self.plan("mission")["items"]), len(self.vehicle.plans[MISSION]))

    async def test_a_refusal_halfway_says_why_and_how_much_is_stored(self):
        token = await self.ready()
        self.vehicle.plans = fake_fc.sample_plan()
        self.vehicle.refuse_item = (3, L.MAV_MISSION_INVALID_PARAM4)
        status, body = await self.run_command(token, action="plan_upload", kind="mission", items=[WAYPOINT] * 5)
        self.assertEqual((status, body["result"]), (200, L.MAV_MISSION_INVALID_PARAM4))
        self.assertEqual(body["said"], ["MAV_MISSION_INVALID_PARAM4, 6 items now stored"])
        self.assertEqual(self.telemetry.state["cmds"][0][3], "refused")
        self.assertEqual(len(self.plan("mission")["items"]), len(self.vehicle.plans[MISSION]))

    async def test_a_plan_that_reads_back_differently_is_not_called_done(self):
        token = await self.ready()
        original = fake_fc.Connection.on_plan_message

        def changed(conn, m, kind):
            if kind == "MISSION_ITEM_INT" and m.seq == 1:
                m.z = 99.0
            original(conn, m, kind)
        with patch.object(fake_fc.Connection, "on_plan_message", changed):
            status, body = await self.run_command(token, action="plan_upload", kind="mission", items=[WAYPOINT])
        self.assertEqual((status, body["result"]), (200, L.MAV_RESULT_FAILED))
        self.assertEqual(body["said"], ["read back differently, 2 items now stored"])

    async def test_a_flight_controller_still_waiting_on_an_upload_is_read_again_later(self):
        quickly(self, plans.PlanStore, RETRY_S=.1)
        await self.ready()
        self.vehicle.upload = {"type": MISSION, "count": 2, "next": 0, "got": []}
        self.telemetry.plans.mark_dirty("mission")
        await self.until(lambda: self.plan("mission")["err"] == "denied", what="the refusal")
        self.vehicle.upload = None
        self.vehicle.plans = fake_fc.sample_plan()
        await self.until(lambda: self.plan("mission")["err"] is None and len(self.plan("mission")["items"]) == 8, what="a fresh read")

    async def test_clearing(self):
        token = await self.ready()
        self.vehicle.plans = fake_fc.sample_plan()
        status, body = await self.run_command(token, action="plan_clear", kind="fence")
        self.assertEqual((status, body["result"]), (200, 0))
        self.assertEqual(self.vehicle.plans[FENCE], [])
        self.assertEqual(self.vehicle.plans[RALLY] != [], True)
        self.assertEqual(self.plan("fence")["items"], [])


class MarksOnTheMap(Harness):
    """They concern nobody but the viewers, so changing them needs no execution and sends nothing."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    async def test_marks_go_to_every_viewer_and_stay_on_disk(self):
        path = Path(self.folder.name) / "deep" / "marks.json"
        self.server.marks = marks.Marks(path)
        reader, _, _ = await self.linked()
        lat, lon = fake_fc._at(10, 10)
        status, body = await self.post("/api/marks", {"op": "add", "lat": lat, "lon": lon, "name": "  东门  "})
        self.assertEqual(status, 200, body)
        mark = body["mark"]
        self.assertEqual(mark["name"], "东门")
        self.assertEqual(self.telemetry.state["marks"][0]["id"], mark["id"])
        status, body = await self.post("/api/marks", {"op": "update", "id": mark["id"], "lat": lat + .001, "name": "西门"})
        self.assertEqual(body["mark"]["name"], "西门")
        self.assertEqual(self.telemetry.state["marks"][0]["lat"], round(lat + .001, 7))
        again = marks.Marks(path)
        self.assertEqual(again.items[0]["name"], "西门")
        status, _ = await self.post("/api/marks", {"op": "remove", "id": mark["id"]})
        self.assertEqual(status, 200)
        self.assertEqual(self.telemetry.state["marks"], [])
        self.assertEqual(marks.Marks(path).items, [])
        self.assertLessEqual(set(self.vehicle.received), READ_ONLY_MESSAGES)

    async def test_nonsense_is_refused(self):
        lat, lon = fake_fc._at(10, 10)
        for body in ({"op": "add", "lat": 91, "lon": lon, "name": "x"}, {"op": "add", "lat": math.nan, "lon": lon, "name": "x"},
                     {"op": "add", "lat": lat, "lon": lon}, {"op": "add", "lat": lat, "lon": lon, "name": "   "},
                     {"op": "add", "lat": str(lat), "lon": lon, "name": "x"}, {"op": "update", "id": "none", "name": "x"},
                     {"op": "remove", "id": ["x"]}, {"op": "explode"}, {}):
            status, reply = await self.post("/api/marks", body)
            self.assertEqual((status, reply.get("error")), (409, "bad_mark"), body)
        self.assertFalse(self.server.marks.items)

    async def test_a_foreign_site_cannot_touch_them(self):
        status, body = await self.post("/api/marks", {"op": "add", "lat": 1, "lon": 1, "name": "x"}, Origin="http://evil.example")
        self.assertEqual((status, body["error"]), (403, "origin"))

    async def test_a_damaged_file_is_not_fatal(self):
        path = Path(self.folder.name) / "marks.json"
        path.write_text("{ not json", "utf-8")
        self.assertEqual(marks.Marks(path).items, [])
        path.write_text(json.dumps([{"id": "a", "lat": 1, "lon": 2, "name": "ok"}, {"id": "b", "lat": 99, "lon": 2, "name": "bad"}, "junk"]), "utf-8")
        self.assertEqual([m["id"] for m in marks.Marks(path).items], ["a"])

    async def test_a_full_list_says_so(self):
        store = marks.Marks()
        for n in range(marks.MAX_MARKS):
            store.add(1, 2, str(n))
        with self.assertRaises(marks.BadMark):
            store.add(1, 2, "one more")

    def test_marks_and_the_plan_outlast_nobody_watching(self):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.publish("marks", [{"id": "a"}])
        telemetry.publish("plan", {"mission": {"items": [1], "at": 5, "err": None}})
        telemetry.publish("att", [0, 0, 0])
        telemetry._forget_vehicle()
        self.assertEqual(telemetry.state["marks"], [{"id": "a"}])
        self.assertEqual(telemetry.state["plan"]["mission"]["at"], 5)
        self.assertNotIn("att", telemetry.state)
        self.assertIn("mission", telemetry.plans.dirty)     # and it is read again when somebody comes

    def test_a_simulator_is_still_one_after_nobody_watching(self):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.publish("sim", True)
        telemetry._forget_vehicle()
        self.assertIs(telemetry.state["sim"], True)


class RcLost(Harness):
    scenario = "rclost"

    async def test_modes_that_answer_to_the_sticks_are_refused_in_the_air_with_no_signal(self):
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_IN_AIR
                         and "sens" in self.telemetry.state and "ekf" in self.telemetry.state, what="the state")
        for mode in sorted(commands.NEEDS_PILOT):
            self.server.gate.last_run = 0
            status, body = await self.run_command(token, action="mode", mode=mode)
            self.assertEqual((status, body["error"]), (409, "no_rc"), mode)
        self.server.gate.last_run = 0
        status, body = await self.run_command(token, action="mode", mode=commands.LAND)
        self.assertEqual((status, body["result"]), (200, 0))


class ThrottleStick(Harness):
    scenario = "flight"

    async def stick_at(self, pwm):
        self.vehicle.stick = pwm
        await self.until(lambda: (self.telemetry.state.get("rc") or {"ch": [0, 0, 0]})["ch"][2] == pwm, what="the stick's report")

    async def mode(self, token, mode):
        self.server.gate.last_run = 0
        return await self.run_command(token, action="mode", mode=mode)

    async def test_modes_that_follow_the_stick_are_refused_in_the_air_with_it_low(self):
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_IN_AIR
                         and "sens" in self.telemetry.state and "ekf" in self.telemetry.state, what="the state")
        await self.stick_at(1000)
        self.assertIn(commands.CIRCLE, commands.NEEDS_PILOT)
        for mode in sorted(commands.NEEDS_PILOT):
            status, body = await self.mode(token, mode)
            self.assertEqual((status, body["error"]), (409, "stick_low"), mode)
            self.assertEqual(self.server.commander.availability()["mode"][str(mode)], "stick_low")
        for mode in (commands.BRAKE, commands.GUIDED):
            status, body = await self.mode(token, mode)
            self.assertEqual((status, body["result"]), (200, 0), mode)
        await self.stick_at(commands.STICK_LOW_PWM - 1)
        status, body = await self.mode(token, commands.LOITER)
        self.assertEqual((status, body["error"]), (409, "stick_low"))
        await self.stick_at(commands.STICK_LOW_PWM)
        status, body = await self.mode(token, commands.LOITER)
        self.assertEqual((status, body["result"]), (200, 0))

    async def test_not_having_heard_from_the_stick_counts_as_low(self):
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_IN_AIR
                         and "sens" in self.telemetry.state and "ekf" in self.telemetry.state and "rc" in self.telemetry.state,
                         what="the state")
        self.vehicle.mute.add(L.MAVLINK_MSG_ID_RC_CHANNELS)
        self.telemetry.seen["RC_CHANNELS"] = time.monotonic() - commands.RC_REPORT_S - 1
        status, body = await self.mode(token, commands.CIRCLE)
        self.assertEqual((status, body["error"]), (409, "stick_low"))

    def test_the_stick_is_read_from_the_channel_it_is_mapped_to(self):
        telemetry = tel.Telemetry("127.0.0.1", 1)
        telemetry.seen["RC_CHANNELS"] = time.monotonic()
        telemetry.publish("rc", {"count": 8, "rssi": None, "ch": [1500, 1500, 1000, 1500] + [0] * 8})
        self.assertTrue(commands._stick_low(telemetry))
        telemetry.publish("params", {"RCMAP_THROTTLE": 1})
        self.assertFalse(commands._stick_low(telemetry))
        telemetry.publish("rc", {"count": 8, "rssi": None, "ch": [65535] * 12})
        self.assertTrue(commands._stick_low(telemetry))


class ThrottleStickOnTheGround(Harness):
    scenario = "ready"

    async def test_on_the_ground_the_stick_does_not_matter(self):
        self.vehicle.stick = 1000
        token = await self.opened()
        await self.until(lambda: self.telemetry.state.get("landed") == L.MAV_LANDED_STATE_ON_GROUND
                         and (self.telemetry.state.get("rc") or {"ch": [0, 0, 0]})["ch"][2] == 1000, what="on the ground")
        status, body = await self.run_command(token, action="mode", mode=commands.LOITER)
        self.assertEqual((status, body["result"]), (200, 0))


class SimulatorCheck(unittest.IsolatedAsyncioTestCase):
    """The flight check refuses anything that cannot prove it is a simulator."""

    async def test_a_flight_controller_with_no_simulator_settings_is_refused(self):
        import sitl_check
        fc, vehicle = await fake_fc.run(0, "ready", False)
        self.addCleanup(fc.close)
        del vehicle.params["SIM_SPEEDUP"]
        port = fc.sockets[0].getsockname()[1]
        with self.assertRaises(SystemExit):
            await sitl_check.prove_simulator("127.0.0.1", port, timeout=2.5)
        self.assertLessEqual(set(vehicle.received), {"PARAM_REQUEST_READ"})

    async def test_a_simulator_passes(self):
        import sitl_check
        fc, _ = await fake_fc.run(0, "ready", False)
        self.addCleanup(fc.close)
        await sitl_check.prove_simulator("127.0.0.1", fc.sockets[0].getsockname()[1], timeout=5)


class MoreState(Harness):
    scenario = "flight"

    async def test_the_extra_readings_arrive(self):
        await self.linked()
        s = self.telemetry.state
        await self.until(lambda: {"batt", "power", "fence", "nav"} <= set(s), what="the readings")
        self.assertEqual(s["batt"]["pct"], 87)
        self.assertIsNone(s["batt"]["cells"])        # one voltage is the pack, not its cells
        self.assertEqual(s["power"]["vcc"], 5.02)
        self.assertFalse(s["fence"]["breached"])
        self.assertEqual(len(s["mission"]), 4)
        json.dumps(s, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
