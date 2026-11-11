#!/usr/bin/env python3
"""Runs every action in commands.py against ArduPilot SITL, through the same API the page uses.

The pretend flight controller in fake_fc.py was written from the same understanding as the code it
tests, so it cannot catch a misunderstanding of the firmware. This can. It flies the simulator:
takeoff, go-to, a mission, a kill in the air, then the ground commands.

It refuses to run against anything but a simulator. Before sending a single command it asks for
SIM_SPEEDUP, a setting only simulator firmware has, and it also refuses the port of the real link.

    .venv/bin/python tools/sitl_check.py --mavlink 192.168.0.50:5760
"""
import argparse
import asyncio
import json
import logging
import math
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT)]

import commands  # noqa: E402
import plans  # noqa: E402
import server as srv  # noqa: E402
import telemetry as tel  # noqa: E402
from wire import COMPID, L, SYSID  # noqa: E402

REAL_LINK_PORT = 5678
GROUND = L.MAV_LANDED_STATE_ON_GROUND
AUTO, GUIDED, LOITER, BRAKE, LAND = commands.AUTO, commands.GUIDED, commands.LOITER, commands.BRAKE, commands.LAND
TURNS_RADIUS_M = 10
PREARM = L.MAV_SYS_STATUS_PREARM_CHECK


class _Sink:
    def __init__(self, writer):
        self.writer = writer

    def write(self, data):
        self.writer.write(bytes(data))


async def prove_simulator(host, port, timeout=30):
    """Returns only if whatever is at this address answers for a setting only simulators have."""
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
    mav = L.MAVLink(_Sink(writer), srcSystem=SYSID, srcComponent=COMPID)
    mav.robust_parsing = True
    deadline = time.monotonic() + timeout
    target, asked = None, 0.0
    try:
        while time.monotonic() < deadline:
            if target and time.monotonic() - asked > 2:
                asked = time.monotonic()
                mav.param_request_read_send(*target, b"SIM_SPEEDUP", -1)
            try:
                data = await asyncio.wait_for(reader.read(4096), 1)
            except TimeoutError:
                continue
            if not data:
                break
            for m in mav.parse_buffer(data) or ():
                if m.get_type() == "HEARTBEAT" and m.autopilot != L.MAV_AUTOPILOT_INVALID and m.get_srcComponent() == L.MAV_COMP_ID_AUTOPILOT1:
                    target = (m.get_srcSystem(), m.get_srcComponent())
                elif m.get_type() == "PARAM_VALUE" and m.param_id == "SIM_SPEEDUP":
                    return
    finally:
        writer.close()
    sys.exit("This did not answer as a simulator (no SIM_SPEEDUP). Nothing was sent. Stopping.")


class Check:
    def __init__(self, host, port):
        self.telemetry = tel.Telemetry(host, port)
        self.server = srv.Server(self.telemetry, ROOT / "web", srv.host_pattern())
        self.problems = []
        self.results = []
        self.token = None
        self.http_port = None

    @property
    def s(self):
        return self.telemetry.state

    def say(self, line):
        print(line, flush=True)

    def note(self, label, good, detail=""):
        self.results.append((label, good))
        self.say(f"  {'ok  ' if good else 'FAIL'} {label}" + (f"  [{detail}]" if detail != "" else ""))
        if not good:
            self.problems.append(label)

    async def post(self, path, body):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.http_port)
        payload = json.dumps(body).encode()
        token = f"X-Exec-Token: {self.token}\r\n" if self.token else ""
        writer.write((f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.http_port}\r\nOrigin: http://127.0.0.1:{self.http_port}\r\n"
                      f"Content-Type: application/json\r\n{token}Content-Length: {len(payload)}\r\n\r\n").encode() + payload)
        data = await reader.read()
        writer.close()
        head, _, content = data.partition(b"\r\n\r\n")
        return int(head.split()[1]), json.loads(content) if content else {}

    async def until(self, condition, timeout, what):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            await asyncio.sleep(.2)
        self.note(f"waiting for {what}", False, f"not within {timeout} s")
        return False

    async def act(self, action, expect=0, label=None, **params):
        """Runs an action the way the page does. `expect` is a result, or a refusal's code."""
        await asyncio.sleep(.6)     # the server's gap between commands
        status, body = await self.post("/api/exec/run", {"action": action, "seq": self.server.seq, "params": params})
        name = label or f"{action} {params if params else ''}".strip()
        if isinstance(expect, str):
            self.note(f"{name}: refused as {expect}", body.get("error") == expect, json.dumps(body)[:160])
        else:
            good = status == 200 and body.get("result") == expect and body.get("effect") is not False
            self.note(name, good, "" if good else json.dumps(body)[:220])
        return body

    def offset(self, north, east):
        lat, lon = self.s["home"][:2]
        return lat + north / 111320, lon + east / (111320 * math.cos(math.radians(lat)))

    def metres_to(self, lat, lon):
        pos = self.s["pos"]
        return math.hypot((lat - pos[0]) * 111320, (lon - pos[1]) * 111320 * math.cos(math.radians(lat)))

    # --- the steps ----------------------------------------------------------

    async def ready(self):
        self.say("Waiting for the simulator to be ready to fly")
        def ready():
            s = self.s
            return (s.get("home") and s.get("ekf") and s["ekf"]["flags"] & L.ESTIMATOR_POS_HORIZ_ABS
                    and (s.get("sens") or (0, 0, 0))[2] & PREARM and s.get("pos"))
        return await self.until(ready, 240, "pre-arm checks, position and home")

    async def places(self):
        """What the map offers for a place on it, on real firmware."""
        self.say("Places on the map")
        spot = self.offset(25, -25)
        await self.act("set_home", label="make a place home", lat=spot[0], lon=spot[1])
        await self.until(lambda: abs(self.s["home"][0] - spot[0]) < 1e-5, 15, "the new home to be reported")
        await self.act("set_home", label="make this place home again")
        await self.until(lambda: abs(self.s["home"][0] - self.s["pos"][0]) < 1e-4, 15, "home to be back")

    async def fly_to_places(self):
        self.say("Flying to places on the map")
        await self.act("mode", mode=BRAKE)
        await self.until(lambda: self.s.get("mode") == BRAKE, 5, "Brake")
        spot = self.offset(30, -20)
        await self.act("goto", expect="not_guided", lat=spot[0], lon=spot[1], alt=12)
        await self.act("goto", label="fly here from another mode", lat=spot[0], lon=spot[1], alt=12, change_mode=True)
        await self.until(lambda: self.s.get("mode") == GUIDED, 5, "the switch to Guided")
        self.note("it switched to Guided by itself", self.s.get("mode") == GUIDED)
        await self.until(lambda: self.metres_to(*spot) < 3, 60, "arriving")
        await self.act("yaw", label="face a place", heading=200, rate=30)
        await self.until(lambda: abs(((self.s["hud"][3] - 200 + 180) % 360) - 180) < 10, 30, "turning to face it")
        spot = self.offset(15, -30)
        await self.act("land_at", label="land there", lat=spot[0], lon=spot[1], alt=12)
        self.note("a landing on arrival is pending", bool(self.s.get("pending")), str(self.s.get("pending")))
        await self.act("land_cancel", label="change of mind")
        self.note("no landing pending now", self.s.get("pending") is None)
        await self.act("land_at", label="land there after all", lat=spot[0], lon=spot[1], alt=12)
        landing = await self.until(lambda: self.s.get("mode") == LAND, 60, "landing on arrival")
        self.note("it switched to Land on arrival", landing)
        self.note("it landed at the place", landing and self.metres_to(*spot) < 4, f"{self.metres_to(*spot):.1f} m away")
        down = await self.until(lambda: self.s.get("armed") is False, 90, "the landing to finish")
        self.note("it landed and disarmed", down)
        return down

    async def plans_round_trip(self):
        self.say("Plans")
        await self.until(lambda: (self.s.get("plan") or {}).get("rally", {}).get("at"), 30, "the first read of the plans")
        self.note("plans read without an error", all(e["err"] is None for e in self.s["plan"].values()))
        a, b, c = self.offset(30, 0), self.offset(30, 30), self.offset(0, 30)
        mission = [{"cmd": plans.NAV_TAKEOFF, "alt": 15},
                   {"cmd": plans.NAV_WAYPOINT, "lat": a[0], "lon": a[1], "alt": 15},
                   {"cmd": plans.NAV_WAYPOINT, "lat": b[0], "lon": b[1], "alt": 20},
                   {"cmd": plans.DO_CHANGE_SPEED, "p": [1, 4, -1, 0]},
                   {"cmd": plans.NAV_WAYPOINT, "lat": c[0], "lon": c[1], "alt": 15},
                   {"cmd": plans.NAV_RTL}]
        await self.act("plan_upload", label="write a mission", kind="mission", items=mission)
        stored = self.s["plan"]["mission"]["items"]
        self.note("mission read back in full", len(stored) == len(mission) + 1, f"{len(stored)} items")
        self.note("mission's first slot still holds home", abs((stored[0]["lat"] or 0) - self.s["home"][0]) < 1e-5)
        self.note("a takeoff has no place of its own", stored[1]["lat"] is None)
        self.note("a speed change has no place of its own", stored[4]["lat"] is None)

        corners = [self.offset(*c) for c in ((400, -400), (400, 400), (-400, 400), (-400, -400))]
        fence = [{"cmd": plans.FENCE_POLY_IN, "lat": lat, "lon": lon, "p": [4, 0, 0, 0]} for lat, lon in corners]
        keep_out = self.offset(250, 250)
        fence.append({"cmd": plans.FENCE_CIRCLE_OUT, "lat": keep_out[0], "lon": keep_out[1], "p": [10, 0, 0, 0]})
        back = self.offset(-5, -5)
        fence.append({"cmd": plans.FENCE_RETURN, "lat": back[0], "lon": back[1]})
        await self.act("plan_upload", label="write a fence", kind="fence", items=fence)
        self.note("fence read back in full", len(self.s["plan"]["fence"]["items"]) == len(fence))
        rally = self.offset(-20, -20)
        await self.act("plan_upload", label="write a rally point", kind="rally", items=[{"lat": rally[0], "lon": rally[1], "alt": 15}])
        self.note("rally point read back", len(self.s["plan"]["rally"]["items"]) == 1)

        await self.act("plan_upload", expect="bad_plan", label="a waypoint with no place", kind="mission", items=[{"cmd": plans.NAV_WAYPOINT}])

    async def settings(self):
        self.say("Settings")
        await self.until(lambda: set(commands.EDITABLE) <= set(self.telemetry.params), 30, "every setting to be read")
        for name in commands.EDITABLE:
            self.note(f"{name} exists on this firmware", name in self.telemetry.params)
        before = self.telemetry.params.get("RTL_ALT_M", 15)
        await self.act("param_set", name="RTL_ALT_M", value=22)
        self.note("RTL_ALT_M reads back", self.telemetry.params.get("RTL_ALT_M") == 22)
        await self.act("param_set", name="RTL_ALT_M", value=before)
        await self.act("param_set", expect="out_of_range", name="RTL_ALT_M", value=1500)

    async def on_the_ground(self):
        self.say("On the ground, disarmed")
        await self.act("takeoff", expect="not_armed")
        await self.act("goto", expect="not_armed", lat=self.s["pos"][0], lon=self.s["pos"][1], alt=10)
        await self.act("kill", expect="not_armed")
        await self.act("set_home")
        await self.act("mission_item", seq=2)
        await self.act("mission_item", expect="no_such_item", seq=99)
        await self.act("mission_item", seq=1)
        await self.act("fence_enable", on=True)
        self.note("fence shows as on", bool(self.s["sens"][1] & commands.FENCE_BIT))
        await self.until(lambda: self.s.get("fence") is not None, 20, "fence status")
        await self.act("fence_enable", on=False)

    async def guided_flight(self):
        self.say("Guided flight")
        await self.act("mode", mode=GUIDED)
        await self.act("takeoff", expect="not_armed", alt=10)
        await self.act("arm")
        await self.act("takeoff", alt=10)
        if not await self.until(lambda: self.s["pos"][3] > 9, 60, "takeoff to 10 m"):
            return False
        await self.until(lambda: self.s.get("landed") == L.MAV_LANDED_STATE_IN_AIR, 20, "being in the air")
        await self.act("disarm", expect="in_air")
        await self.act("takeoff", expect="not_on_ground", alt=10)
        far = self.offset(5000, 0)
        await self.act("goto", expect="too_far", lat=far[0], lon=far[1], alt=10)
        there = self.offset(40, 0)
        await self.act("goto", lat=there[0], lon=there[1], alt=12)
        await self.until(lambda: self.s.get("target"), 8, "the target to be reported")
        self.note("target is where it was sent", self.s.get("target") and abs(self.s["target"][0] - there[0]) < 1e-4, str(self.s.get("target")))
        self.note("target's frame is known", self.s.get("target") and self.s["target"][3] in (0, 3, 5, 6), str(self.s.get("target")))
        await self.until(lambda: self.metres_to(*there) < 3, 60, "arriving 40 m north")
        await self.act("altitude", alt=15)
        await self.until(lambda: self.s["pos"][3] > 14, 30, "climbing to 15 m")
        self.note("a new height kept the position", self.metres_to(*there) < 5, f"{self.metres_to(*there):.1f} m away")
        await self.act("speed", speed=3)
        await self.act("yaw", heading=90)
        await self.until(lambda: abs(((self.s["hud"][3] - 90 + 180) % 360) - 180) < 10, 30, "turning to 90 degrees")
        away = self.offset(40, 60)
        await self.act("goto", lat=away[0], lon=away[1], alt=15)
        await self.until(lambda: self.s["hud"][0] > 1, 15, "moving")
        await self.act("pause")
        stopped = await self.until(lambda: self.s["hud"][0] < .3, 15, "stopping after pause")
        self.note("pause stopped it", stopped)
        await self.act("resume")
        await self.until(lambda: self.s["hud"][0] > 1, 15, "moving again after resume")
        await self.act("mode", mode=BRAKE)
        await self.act("mode", mode=GUIDED)
        await self.stick_modes()
        return True

    async def mission_flight(self):
        self.say("Mission")
        await self.act("mission_item", seq=2)
        await self.act("mission_start")
        self.note("mode is Auto", self.s.get("mode") == AUTO)
        await self.until(lambda: (self.s.get("mission") or (0,))[0] >= 3, 90, "reaching the second item")
        self.note("a target is reported in Auto", bool(self.s.get("target")), str(self.s.get("target")))
        self.note("distance to the next point is reported", bool(self.s.get("nav")), str(self.s.get("nav")))
        await self.act("speed", speed=5)
        await self.act("pause", label="pause in Auto")
        await self.until(lambda: self.s["hud"][0] < .3, 15, "stopping in Auto")
        await self.act("resume", label="resume in Auto")
        self.say("    flying home through the rest of the mission")
        landed = await self.until(lambda: self.s.get("armed") is False, 240, "the mission to finish and land")
        self.note("mission ended on the ground", landed)
        return landed

    async def stick_modes(self):
        self.say("Modes that follow the throttle stick, which sits at the bottom here")
        self.note("the simulated stick is low", self.s["rc"]["ch"][2] < commands.STICK_LOW_PWM, self.s["rc"]["ch"][2])
        for mode in sorted(commands.NEEDS_PILOT):
            await self.act("mode", mode=mode, expect="stick_low")

    async def loiter_in_a_mission(self):
        self.say("Loitering in a mission, the way to do it with no stick")
        await self.until(lambda: (self.s.get("sens") or (0, 0, 0))[2] & PREARM, 60, "pre-arm checks again")
        spot = self.offset(30, 0)
        await self.act("plan_upload", label="write a mission that circles and waits", kind="mission", items=[
            {"cmd": plans.NAV_TAKEOFF, "alt": 12},
            {"cmd": plans.NAV_LOITER_TURNS, "lat": spot[0], "lon": spot[1], "alt": 15, "p": [1, 0, TURNS_RADIUS_M, 0]},
            {"cmd": plans.NAV_LOITER_TIME, "lat": spot[0], "lon": spot[1], "alt": 15, "p": [5, 0, 0, 0]},
            {"cmd": plans.NAV_RTL}])
        await self.act("mission_item", seq=1)
        await self.act("mode", mode=GUIDED)
        await self.act("arm")
        await self.act("mission_start", label="start it on the ground")
        current = lambda: (self.s.get("mission") or (0,))[0]
        if not await self.until(lambda: current() == 2, 40, "the circling item"):
            return
        heights, circle = [], []
        while current() == 2 and self.s.get("armed"):
            heights.append(self.s["pos"][3])
            away = self.metres_to(*spot)
            if away > TURNS_RADIUS_M - 3:      # once it has reached the circle
                circle.append(away)
            await asyncio.sleep(.5)
        self.note("it kept its height while circling", bool(heights) and min(heights) > 11, f"{min(heights, default=0):.1f} to {max(heights, default=0):.1f} m")
        self.note("at the radius asked for", len(circle) > 8 and abs(sum(circle) / len(circle) - TURNS_RADIUS_M) < 3,
                  f"{sum(circle) / max(len(circle), 1):.1f} m over {len(circle)} samples")
        waited = await self.until(lambda: current() == 4 or self.s.get("armed") is False, 60, "the waiting item to end")
        self.note("the wait ended and it went on", waited)
        self.note("it did not fall during the wait", self.s["pos"][3] > 8 or self.s.get("armed") is False, f'{self.s["pos"][3]:.1f} m')
        self.note("it landed and disarmed", await self.until(lambda: self.s.get("armed") is False, 90, "the landing"))

    async def again_in_the_air(self):
        await self.until(lambda: (self.s.get("sens") or (0, 0, 0))[2] & PREARM, 60, "pre-arm checks again")
        await self.act("mode", mode=GUIDED)
        await self.act("arm")
        await self.act("takeoff", alt=10)
        return await self.until(lambda: self.s["pos"][3] > 8, 40, "takeoff to 10 m")

    async def mission_from_the_ground(self):
        self.say("A mission from the ground")
        await self.until(lambda: (self.s.get("sens") or (0, 0, 0))[2] & PREARM, 60, "pre-arm checks again")
        spot = self.offset(15, 15)
        await self.act("plan_upload", label="write a short mission", kind="mission",
                       items=[{"cmd": plans.NAV_TAKEOFF, "alt": 6}, {"cmd": plans.NAV_WAYPOINT, "lat": spot[0], "lon": spot[1], "alt": 6}, {"cmd": plans.NAV_LAND}])
        await self.act("mission_item", seq=1)
        await self.act("mission_start", expect="not_armed")
        await self.act("mode", mode=GUIDED)
        await self.act("arm")
        await self.act("mission_start", label="start the mission on the ground")
        climbed = await self.until(lambda: self.s["pos"][3] > 4, 40, "the mission's takeoff")
        self.note("the mission's takeoff climbed", climbed)
        landed = await self.until(lambda: self.s.get("armed") is False, 120, "the mission to land")
        self.note("it landed and disarmed", landed)

    async def kill_in_the_air(self):
        self.say("Stopping the motors in the air")
        await self.until(lambda: (self.s.get("sens") or (0, 0, 0))[2] & PREARM, 60, "pre-arm checks again")
        await self.act("mode", mode=GUIDED)
        await self.act("arm")
        await self.act("takeoff", alt=6)
        if await self.until(lambda: self.s["pos"][3] > 5, 40, "takeoff to 6 m"):
            await self.act("kill")
            self.note("motors stopped", self.s.get("armed") is False)
        await self.until(lambda: abs(self.s["pos"][3]) < 1 or self.s.get("landed") == GROUND, 30, "reaching the ground")

    async def bench(self):
        self.say("Bench commands")
        await self.until(lambda: self.s.get("landed") == GROUND, 30, "on the ground")
        await self.act("calibrate", what="baro")
        await self.act("calibrate", what="gyro")
        await self.act("calibrate", what="level")
        await self.act("motor_test", motor=1, throttle=10, seconds=1)
        await asyncio.sleep(2)
        for kind in ("mission", "fence", "rally"):
            await self.act("plan_clear", label=f"erase {kind}", kind=kind)
        stored = self.s["plan"]
        self.note("everything is erased", len(stored["mission"]["items"]) <= 1 and not stored["fence"]["items"] and not stored["rally"]["items"],
                  str({k: len(v["items"]) for k, v in stored.items()}))
        before = self.s.get("boot", 0)
        await self.act("reboot")
        await asyncio.sleep(5)
        self.say("    waiting for it to come back")
        await self.until(lambda: self.telemetry.fresh() and self.s.get("boot", before) < before, 60, "the reboot")

    async def run(self):
        http = await asyncio.start_server(self.server.handle, "127.0.0.1", 0, limit=8192)
        self.http_port = http.sockets[0].getsockname()[1]
        tasks = [asyncio.create_task(self.telemetry.run()), asyncio.create_task(self.server.broadcast_loop())]
        reader, writer = await asyncio.open_connection("127.0.0.1", self.http_port)
        writer.write(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.http_port}\r\n\r\n".encode())
        await reader.readuntil(b"event: full\ndata: ")
        viewer = json.loads(await reader.readline())["viewer"]

        async def keep_alive():
            while True:
                await asyncio.sleep(5)
                await self.post("/api/alive", {"viewer": viewer})

        async def drain():
            while await reader.read(65536):
                pass

        tasks += [asyncio.create_task(keep_alive()), asyncio.create_task(drain())]
        try:
            if not await self.ready():
                return
            status, body = await self.post("/api/exec/open", {"viewer": viewer})
            if status != 200:
                self.note("execution opened", False, body)
                return
            self.token = body["token"]
            await self.plans_round_trip()
            await self.settings()
            await self.on_the_ground()
            await self.places()
            if await self.guided_flight() and await self.mission_flight():
                await self.mission_from_the_ground()
                await self.loiter_in_a_mission()
                if await self.again_in_the_air() and await self.fly_to_places():
                    await self.kill_in_the_air()
            await self.bench()
        finally:
            for task in tasks:
                task.cancel()
            writer.close()
            http.close()
            good = sum(1 for _, g in self.results if g)
            self.say(f"\n{good} of {len(self.results)} checks passed")
            for problem in self.problems:
                self.say(f"  FAILED: {problem}")
            self.say("\nCommands on record, newest first:")
            for when, name, params, outcome in list(self.server.commander.record)[:10]:
                self.say(f"  {time.strftime('%H:%M:%S', time.localtime(when))} {name} {params} {outcome}")
            self.say("\nLast messages from the firmware:")
            for _, _, text in list(self.telemetry.messages)[-12:]:
                self.say(f"  {text}")


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mavlink", required=True, help="host:port of the simulator's TCP port")
    args = parser.parse_args()
    host, port = args.mavlink.rsplit(":", 1)
    if int(port) == REAL_LINK_PORT:
        sys.exit(f"{REAL_LINK_PORT} is the port of the real flight controller's link. Stopping.")
    logging.basicConfig(level=logging.ERROR, format="%(message)s")
    await prove_simulator(host, int(port))
    print(f"{args.mavlink} is a simulator.", flush=True)
    check = Check(host, int(port))
    await check.run()
    sys.exit(1 if check.problems else 0)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    asyncio.run(main())
