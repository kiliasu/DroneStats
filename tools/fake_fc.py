#!/usr/bin/env python3
"""A pretend flight controller on a TCP port, standing in for mavlink-router.

For developing the dashboard and for tests: every command goes here instead of to
real hardware. It streams like a flight controller with a ground station attached,
or with --quiet sends only heartbeats and answers requests, like a link nobody has
asked for streams on.

    python tools/fake_fc.py --port 15678 --scenario flight
"""
import argparse
import asyncio
import math
import os
import random
import time

os.environ["MAVLINK20"] = "1"
from pymavlink.dialects.v20 import ardupilotmega as L  # noqa: E402

HOME = (-35.363261, 149.165230)     # ArduPilot SITL's own default home, at Canberra Model Aircraft Club
HOME_MSL = 20
PARAMS = {"RCMAP_THROTTLE": 3, "RTL_LOIT_TIME": 5000, "RTL_CONE_SLOPE": 3, "RTL_CLIMB_MIN_M": 0, "RTL_ALT_FINAL_M": 0,
          "LAND_SPD_HIGH_MS": 0, "LAND_ALT_LOW_M": 10, "RALLY_LIMIT_KM": .3, "RALLY_INCL_HOME": 1, "FS_THR_ENABLE": 1, "BATT_ARM_VOLT": 7.3, "BATT_LOW_VOLT": 6.1, "BATT_CRT_VOLT": 6.0, "GPS_HDOP_GOOD": 140,
          "FRAME_CLASS": 1, "FRAME_TYPE": 1, "FENCE_ENABLE": 0, "FENCE_TYPE": 7, "FENCE_ACTION": 1, "FENCE_ALT_MAX": 100,
          "FENCE_RADIUS": 300, "RTL_ALT_M": 15, "RTL_SPEED_MS": 0, "WP_SPD": 10, "WP_SPD_UP": 2.5, "WP_SPD_DN": 1.5,
          "LAND_SPD_MS": .5, "BATT_CAPACITY": 2200, "STAT_BOOTCNT": 41, "STAT_FLTTIME": 7260, "STAT_RUNTIME": 91800,
          "SIM_SPEEDUP": 1,     # only simulators have this: tools/sitl_check.py looks for it before sending anything
          "SERVO1_FUNCTION": 0, "SERVO2_FUNCTION": 0, "SERVO3_FUNCTION": 0, "SERVO4_FUNCTION": 0,
          "SERVO5_FUNCTION": 33, "SERVO6_FUNCTION": 34, "SERVO7_FUNCTION": 35, "SERVO8_FUNCTION": 36,
          "SERVO9_FUNCTION": 0, "SERVO10_FUNCTION": 0, "SERVO11_FUNCTION": 0, "SERVO12_FUNCTION": 0}
SENSORS = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000
PREARM_BIT = L.MAV_SYS_STATUS_PREARM_CHECK
DRAIN_V_PER_S = 0.0015
MISSION, FENCE, RALLY = L.MAV_MISSION_TYPE_MISSION, L.MAV_MISSION_TYPE_FENCE, L.MAV_MISSION_TYPE_RALLY
GUIDED, AUTO, RTL, LAND, BRAKE = 4, 3, 6, 9, 17
REACHED_M = 1.0
USUAL_SPEED = 5.0           # what it flies at until told otherwise, as WP_SPD is to the firmware
# The motor test takes a place in the order the test goes round in, and this is the motor at each place
# on a quad X: clockwise from the front right (AP_MotorsMatrix, MOTOR_FRAME_TYPE_X).
MOTOR_AT_TEST_PLACE = {1: 1, 2: 4, 3: 2, 4: 3}
CAPABILITIES = (L.MAV_PROTOCOL_CAPABILITY_MISSION_INT | L.MAV_PROTOCOL_CAPABILITY_COMMAND_INT | L.MAV_PROTOCOL_CAPABILITY_MISSION_FENCE
                | L.MAV_PROTOCOL_CAPABILITY_MISSION_RALLY | L.MAV_PROTOCOL_CAPABILITY_MAVLINK2)
FLIGHT_MESSAGES = ("EKF3 IMU0 is using GPS", "GPS 1: detected u-blox", "Vibration compensation ON",
                   "Field Elevation Set: 20m", "Loiter speed limited by wind")


def _at(north, east):
    return HOME[0] + north / 111320, HOME[1] + east / (111320 * math.cos(math.radians(HOME[0])))


def stored(command, frame, north=None, east=None, alt=0.0, p=(0.0, 0.0, 0.0, 0.0), place=None):
    """An item as the flight controller keeps it. A position in metres from home, or `place` in degrees."""
    lat, lon = place if place else _at(north, east) if north is not None else (0.0, 0.0)
    return {"command": command, "frame": frame, "x": int(round(lat * 1e7)), "y": int(round(lon * 1e7)), "z": float(alt), "p": list(p)}


def home_item(known=True):
    return stored(L.MAV_CMD_NAV_WAYPOINT, L.MAV_FRAME_GLOBAL, place=HOME if known else None, alt=HOME_MSL if known else 0)


def sample_plan():
    """Something to look at: a short mission, a fence with a keep-out circle, and two rally points."""
    rel = L.MAV_FRAME_GLOBAL_RELATIVE_ALT
    poly = [(90, -60), (110, 70), (20, 130), (-70, 80), (-60, -60)]
    return {
        MISSION: [home_item(),
                  stored(L.MAV_CMD_NAV_TAKEOFF, rel, alt=15),
                  stored(L.MAV_CMD_NAV_WAYPOINT, rel, 40, 0, 20),
                  stored(L.MAV_CMD_NAV_WAYPOINT, rel, 60, 60, 25),
                  stored(L.MAV_CMD_DO_CHANGE_SPEED, L.MAV_FRAME_MISSION, p=(1.0, 4.0, -1.0, 0.0)),
                  stored(L.MAV_CMD_NAV_WAYPOINT, rel, 0, 90, 25),
                  stored(L.MAV_CMD_NAV_LOITER_TIME, rel, -30, 40, 18, p=(10.0, 0.0, 0.0, 0.0)),
                  stored(L.MAV_CMD_NAV_RETURN_TO_LAUNCH, rel)],
        FENCE: [stored(L.MAV_CMD_NAV_FENCE_RETURN_POINT, L.MAV_FRAME_GLOBAL, -10, -10)]
        + [stored(L.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, L.MAV_FRAME_GLOBAL, n, e, p=(float(len(poly)), 0.0, 0.0, 0.0)) for n, e in poly]
        + [stored(L.MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION, L.MAV_FRAME_GLOBAL, 25, 30, p=(12.0, 0.0, 0.0, 0.0))],
        RALLY: [stored(L.MAV_CMD_NAV_RALLY_POINT, rel, -25, -25, 15), stored(L.MAV_CMD_NAV_RALLY_POINT, rel, 70, 20, 15)],
    }


class Sink:
    def __init__(self, writer):
        self.writer = writer

    def write(self, data):
        self.writer.write(bytes(data))


class Vehicle:
    def __init__(self, scenario):
        self.scenario = scenario
        self.t0 = time.monotonic()
        self.armed = scenario in ("flight", "armed", "rclost")
        self.mode = 5 if scenario in ("flight", "rclost") else 0
        self.volts = {"bench": 7.62, "ready": 8.21, "flight": 7.58, "armed": 8.05, "low": 7.02}.get(scenario, 8.0)
        self.alt = 18.4 if scenario in ("flight", "rclost") else 0.0
        self.north, self.east = 0.0, 0.0
        self.prearm_ok = scenario in ("ready", "flight", "armed", "rclost")
        self.grounded = scenario == "armed"     # armed, but stays on the ground
        self.rc_lost = scenario == "rclost"     # the transmitter dropped after being seen
        self.stick = 1500                       # the throttle stick: where a pilot holds it in the air
        self.outs = None                        # the motors' outputs when told, otherwise what flying gives
        self.mute = set()                       # message IDs it will not answer with
        self.logs = [(1, 8_412_160, 1793850000), (2, 12_902_400, 1793855000)]
        self.received = []                      # the type of every message received
        self.commands = []                      # everything received, for tests to inspect
        self.params = dict(PARAMS)
        self.has_home = scenario != "bench"
        self.home_at = None                     # a home set by command
        self.plans = sample_plan() if scenario == "flight" else {MISSION: [home_item(self.has_home)], FENCE: [], RALLY: []}
        if scenario == "flight":
            self.params.update(FENCE_ENABLE=1, FENCE_ALT_MAX=60, FENCE_RADIUS=120)
        self.fence_on = bool(self.params["FENCE_ENABLE"])
        self.breach = False
        self.current = 0                        # the mission item it is flying to
        self.mission_running = False
        self.paused = False
        self.climb_to = None                    # a height asked for by a takeoff
        self.guided = None                      # (north, east, height) asked for in Guided
        self.guided_flying_to = False           # Guided is steering to a place, not climbing out or holding
        self.speed = USUAL_SPEED
        self.heading = None                     # a heading asked for
        self.vn = self.ve = 0.0
        self.consumed = 0.0
        self.upload = None                      # a transfer in progress: {type, count, next, got}
        self.deny_reads = set()                 # plan types it answers "denied" for
        self.drop_items = []                    # item numbers whose next request it ignores
        self.stall_upload_at = None             # it goes quiet when an upload reaches this item
        self.refuse_item = None                 # it refuses this item of an upload, with this result
        self.motor_tests = []
        self.ack_only = set()                   # commands it accepts and then does nothing about
        self.notes = []                         # things it wants to say at its next chance

    @property
    def flying(self):
        return self.armed and self.alt > 0.2

    def enter(self, mode):
        """A change of mode, which starts the new one afresh: no pause, and in Guided no place to go to."""
        self.mode = mode
        if mode != AUTO:
            self.mission_running = False
        self.paused = False
        self.guided_flying_to = False
        if mode == GUIDED:
            self.guided = None
        if mode not in (GUIDED, AUTO):
            self.climb_to = None

    def destination(self):
        """Where it is flying to on its own, as (north, east, height), or None."""
        if self.mode == GUIDED:
            return self.guided
        if self.mode == RTL:
            return (0.0, 0.0, self.alt)
        if self.mode == AUTO and self.mission_running:
            items = self.plans[MISSION]
            if 0 < self.current < len(items):
                item = items[self.current]
                if item["x"] or item["y"]:
                    lat, lon = item["x"] / 1e7, item["y"] / 1e7
                    return ((lat - HOME[0]) * 111320, (lon - HOME[1]) * 111320 * math.cos(math.radians(HOME[0])), item["z"])
        return None

    def advance_mission(self):
        """Works through the stored mission, in Auto."""
        items = self.plans[MISSION]
        while self.current < len(items):
            item = items[self.current]
            if item["command"] == L.MAV_CMD_NAV_TAKEOFF:
                self.climb_to = item["z"]
                if self.alt < item["z"] - REACHED_M:
                    return
            elif item["command"] == L.MAV_CMD_NAV_RETURN_TO_LAUNCH:
                self.mode = RTL
                self.mission_running = False
                return
            elif item["command"] == L.MAV_CMD_NAV_LAND:
                self.mode = LAND
                self.mission_running = False
                return
            elif item["x"] or item["y"]:
                dest = self.destination()
                if dest and math.hypot(dest[0] - self.north, dest[1] - self.east) > REACHED_M:
                    return
                self.notes.append(f"Reached waypoint #{self.current}".encode())
            self.current += 1
        self.mission_running = False

    def step(self, dt):
        t = time.monotonic() - self.t0
        self.vn = self.ve = 0.0
        if self.mode == AUTO and self.mission_running and self.armed and not self.paused:
            self.advance_mission()
        dest = self.destination() if not self.paused else None
        if self.mode == LAND or not self.armed or self.grounded:
            target = 0.0
        elif dest:
            target = dest[2]
        elif self.climb_to is not None:
            target = self.climb_to
        elif self.mode in (GUIDED, AUTO, BRAKE, RTL):
            target = self.alt       # holds, and leaves the ground only when asked to
        else:
            target = 18.4
        self.alt += max(-1.5 * dt, min(1.5 * dt, target - self.alt))
        if self.mode == LAND and self.armed and self.alt < 0.05:
            self.armed = False
        if self.flying:
            if dest:
                dn, de = dest[0] - self.north, dest[1] - self.east
                far = math.hypot(dn, de)
                if far > .05:
                    self.vn, self.ve = dn / far * self.speed, de / far * self.speed
                    step = min(1, far / (self.speed * dt)) if dt else 0
                    self.north += self.vn * dt * step
                    self.east += self.ve * dt * step
                elif self.mode == RTL:
                    self.mode = LAND
            elif self.mode not in (GUIDED, AUTO, BRAKE, RTL, LAND):
                self.vn, self.ve = math.cos(t * 0.12) * 3.2, math.sin(t * 0.12) * 3.2
                self.north += self.vn * dt
                self.east += self.ve * dt
            self.volts = max(6.0, self.volts - DRAIN_V_PER_S * dt)
            self.consumed += 1450 * dt / 3600
        return t

    def attitude(self, t):
        if self.heading is not None:
            return (0.0, 0.0, math.radians(self.heading))
        if self.flying:
            return (math.sin(t * 0.7) * 0.28, math.sin(t * 0.43 + 1) * 0.16 - 0.05,
                    math.atan2(math.sin(t * 0.12), math.cos(t * 0.12)))
        return (-0.012, 0.018, 0.62)


class Connection:
    def __init__(self, vehicle, writer, quiet):
        self.v = vehicle
        self.quiet = quiet
        self.mav = L.MAVLink(Sink(writer), srcSystem=1, srcComponent=1)
        self.mav.robust_parsing = True
        self.boot = time.monotonic()

    def ms(self):
        return int((time.monotonic() - self.boot) * 1000)

    def send(self, msg_id):
        v, mav = self.v, self.mav
        if msg_id in v.mute:
            return
        t = time.monotonic() - v.t0
        roll, pitch, yaw = v.attitude(t)
        lat = HOME[0] + v.north / 111320
        lon = HOME[1] + v.east / (111320 * math.cos(math.radians(HOME[0])))
        speed = math.hypot(v.vn, v.ve) if v.flying else 0.0
        throttle = 58 if v.flying else (8 if v.armed else 0)

        if msg_id == L.MAVLINK_MSG_ID_ATTITUDE:
            mav.attitude_send(self.ms(), roll, pitch, yaw, 0.0, 0.0, 0.0)
        elif msg_id == L.MAVLINK_MSG_ID_GLOBAL_POSITION_INT:
            mav.global_position_int_send(self.ms(), int(lat * 1e7), int(lon * 1e7), int((HOME_MSL + v.alt) * 1000),
                                         int(v.alt * 1000), int(v.vn * 100), int(v.ve * 100), 0,
                                         int(math.degrees(yaw) % 360 * 100))
        elif msg_id == L.MAVLINK_MSG_ID_VFR_HUD:
            mav.vfr_hud_send(0.2, speed, int(math.degrees(yaw) % 360), throttle, HOME_MSL + v.alt,
                             0.0 if not v.flying else 0.3 * math.sin(t))
        elif msg_id == L.MAVLINK_MSG_ID_SYS_STATUS:
            rc = L.MAV_SYS_STATUS_SENSOR_RC_RECEIVER if v.scenario != "bench" else 0
            fence = L.MAV_SYS_STATUS_GEOFENCE
            present = SENSORS | PREARM_BIT | rc | (fence if v.plans[FENCE] or v.fence_on else 0)
            enabled = (present & ~fence) | (fence if v.fence_on else 0)
            health = SENSORS | (PREARM_BIT if v.prearm_ok else 0) | (0 if v.rc_lost else rc) | (0 if v.breach else fence)
            shown = v.volts - (0.04 if v.flying else 0) + random.gauss(0, 0.006)
            mav.sys_status_send(present, enabled, health, 322, int(shown * 1000),
                                1450 if v.flying else 60, -1, 0, 0, 0, 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_GPS_RAW_INT:
            hdop = 90 if v.scenario in ("flight", "ready", "armed", "rclost") else 621
            mav.gps_raw_int_send(self.ms() * 1000, 3, int(lat * 1e7), int(lon * 1e7), int((HOME_MSL + v.alt) * 1000),
                                 hdop, hdop, int(speed * 100), 0, 14 if hdop == 90 else 7)
        elif msg_id == L.MAVLINK_MSG_ID_SERVO_OUTPUT_RAW:
            base = 1000 if not v.armed else (1080 if not v.flying else 1540)
            wobble = (lambda a: int(math.sin(t * 2 + a) * 70)) if v.flying else (lambda a: 0)
            outs = [0, 0, 0, 0, *(v.outs or (base + wobble(0), base + wobble(1.5), base + wobble(3), base + wobble(4.5)))]
            mav.servo_output_raw_send(self.ms() * 1000, 0, *outs)
        elif msg_id == L.MAVLINK_MSG_ID_EXTENDED_SYS_STATE:
            state = L.MAV_LANDED_STATE_IN_AIR if v.flying else L.MAV_LANDED_STATE_ON_GROUND
            mav.extended_sys_state_send(0, state)
        elif msg_id == L.MAVLINK_MSG_ID_RC_CHANNELS:
            count = 8 if v.scenario in ("flight", "ready", "armed", "rclost") else 0
            chans = [1500, 1500, v.stick, 1500, 1800, 1000, 1000, 1000] if count else [0] * 8
            mav.rc_channels_send(self.ms(), count, *chans, *([0] * 10), 200 if count else 0)
        elif msg_id == L.MAVLINK_MSG_ID_EKF_STATUS_REPORT:
            flags = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 if v.scenario != "bench" else 0xA7
            mav.ekf_status_report_send(flags, 0.04, 0.03, 0.05, 0.02, 0.0)
        elif msg_id == L.MAVLINK_MSG_ID_VIBRATION:
            mav.vibration_send(self.ms() * 1000, 8.1 if v.flying else 0.0, 7.4 if v.flying else 0.0,
                               11.2 if v.flying else 0.0, 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_HOME_POSITION:
            if v.has_home:
                home = v.home_at or (*HOME, HOME_MSL)
                mav.home_position_send(int(home[0] * 1e7), int(home[1] * 1e7), int(home[2] * 1000), 0, 0, 0,
                                       [1, 0, 0, 0], 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_SCALED_PRESSURE:
            mav.scaled_pressure_send(self.ms(), 1007.8, 0.0, 4749)
        elif msg_id == L.MAVLINK_MSG_ID_RAW_IMU:
            mav.raw_imu_send(self.ms() * 1000, 148, 76, -995, 0, -1, 0, 115, -23, 244, 0, 4335)
        elif msg_id == L.MAVLINK_MSG_ID_MEMINFO:
            mav.meminfo_send(0, 20488, 20488)
        elif msg_id == L.MAVLINK_MSG_ID_SYSTEM_TIME:
            mav.system_time_send(0, self.ms())
        elif msg_id == L.MAVLINK_MSG_ID_MISSION_CURRENT:
            total = max(len(v.plans[MISSION]) - 1, 0)
            state = (L.MISSION_STATE_NO_MISSION if not total else L.MISSION_STATE_PAUSED if v.paused
                     else L.MISSION_STATE_ACTIVE if v.mission_running else L.MISSION_STATE_NOT_STARTED)
            mav.mission_current_send(v.current, total, state, 1 if v.mode == AUTO else 0)
        elif msg_id == L.MAVLINK_MSG_ID_BATTERY_STATUS:
            mav.battery_status_send(0, 0, 0, 32767, [int(v.volts * 1000)] + [65535] * 9, 1450 if v.flying else 60,
                                    int(v.consumed), -1, 87, 0, 1, [0] * 4, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_POWER_STATUS:
            mav.power_status_send(5021, 0, 1 | (L.MAV_POWER_STATUS_USB_CONNECTED if v.scenario == "bench" else 0))
        elif msg_id == L.MAVLINK_MSG_ID_FENCE_STATUS:
            if v.fence_on:
                mav.fence_status_send(1 if v.breach else 0, 1 if v.breach else 0, L.FENCE_BREACH_BOUNDARY if v.breach else 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT:
            dest = v.destination() if v.armed else None
            if dest:
                tlat = HOME[0] + dest[0] / 111320
                tlon = HOME[1] + dest[1] / (111320 * math.cos(math.radians(HOME[0])))
                mav.position_target_global_int_send(self.ms(), L.MAV_FRAME_GLOBAL, 0, int(tlat * 1e7), int(tlon * 1e7),
                                                    HOME_MSL + dest[2], 0, 0, 0, 0, 0, 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_TERRAIN_REPORT:
            mav.terrain_report_send(int(lat * 1e7), int(lon * 1e7), 100, 51.3, v.alt + 1.2, 0, 448)
        elif msg_id == L.MAVLINK_MSG_ID_NAV_CONTROLLER_OUTPUT:
            dest = v.destination() if v.armed else None
            far = math.hypot(dest[0] - v.north, dest[1] - v.east) if dest else 0
            bearing = math.degrees(math.atan2(dest[1] - v.east, dest[0] - v.north)) if dest else 0
            mav.nav_controller_output_send(0, 0, int(bearing), int(bearing), min(int(far), 65535), dest[2] - v.alt if dest else 0, 0, 0)
        elif msg_id == L.MAVLINK_MSG_ID_AUTOPILOT_VERSION:
            mav.autopilot_version_send(CAPABILITIES, (4 << 24) | (7 << 16) | (1 << 8) | 255, 0, 0, 69074944, [0] * 8,
                                       [0] * 8, [0] * 8, 0x1209, 0x5741, 0, [0] * 18)

    def heartbeat(self):
        v = self.v
        base = L.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (L.MAV_MODE_FLAG_SAFETY_ARMED if v.armed else 0)
        status = L.MAV_STATE_ACTIVE if v.armed else L.MAV_STATE_STANDBY
        self.mav.heartbeat_send(L.MAV_TYPE_QUADROTOR, L.MAV_AUTOPILOT_ARDUPILOTMEGA, base, v.mode, status)

    def prearm_report(self):
        v = self.v
        if v.prearm_ok:
            return
        self.mav.statustext_send(L.MAV_SEVERITY_CRITICAL, b"PreArm: RC not found")
        if v.volts < 7.3:
            self.mav.statustext_send(L.MAV_SEVERITY_CRITICAL, b"PreArm: Battery 1 below minimum arming voltage")

    def on_message(self, m):
        v = self.v
        kind = m.get_type()
        v.received.append(kind)
        if kind.startswith("MISSION_"):
            self.on_plan_message(m, kind)
        elif kind == "PARAM_SET":
            name = m.param_id
            if name in v.params:
                v.params[name] = m.param_value
                v.commands.append(("PARAM_SET", name, m.param_value))
                self.mav.param_value_send(name.encode(), m.param_value, L.MAV_PARAM_TYPE_REAL32, 1110, 0)
        elif kind == "COMMAND_INT":
            v.commands.append((m.command, m.param1, m.param2))
            result = L.MAV_RESULT_UNSUPPORTED
            if m.command == L.MAV_CMD_DO_REPOSITION:
                if v.mode != GUIDED and not int(m.param2) & 1:
                    result = L.MAV_RESULT_DENIED
                else:
                    if v.mode != GUIDED:
                        v.enter(GUIDED)
                    if not v.guided_flying_to:
                        # Starting to steer to a place sets the speed back to the usual one. Once steering,
                        # another place keeps the speed, and keeps a pause too: it does not move until resumed.
                        v.guided_flying_to = True
                        v.speed = USUAL_SPEED
                    north = (m.x / 1e7 - HOME[0]) * 111320
                    east = (m.y / 1e7 - HOME[1]) * 111320 * math.cos(math.radians(HOME[0]))
                    v.guided = (north, east, m.z)
                    result = L.MAV_RESULT_ACCEPTED
            elif m.command == L.MAV_CMD_DO_SET_HOME:
                if v.armed:
                    result = L.MAV_RESULT_DENIED
                else:
                    v.has_home = True
                    v.home_at = (m.x / 1e7, m.y / 1e7, m.z)
                    result = L.MAV_RESULT_ACCEPTED
            self.ack(m, result)
        elif kind == "LOG_REQUEST_LIST":
            if not v.logs:
                self.mav.log_entry_send(0, 0, 0, 0, 0)
            for log_id, size, when in v.logs:
                self.mav.log_entry_send(log_id, len(v.logs), v.logs[-1][0], when, size)
        elif kind == "PARAM_REQUEST_READ":
            name = m.param_id
            if name in v.params:
                self.mav.param_value_send(name.encode(), v.params[name], L.MAV_PARAM_TYPE_REAL32, 1110, 0)
        elif kind == "COMMAND_LONG":
            v.commands.append((m.command, m.param1, m.param2))
            result = L.MAV_RESULT_ACCEPTED
            if m.command == L.MAV_CMD_REQUEST_MESSAGE:
                self.ack(m, result)
                self.send(int(m.param1))
                return
            if m.command in v.ack_only:
                self.ack(m, result)
                return
            if m.command == L.MAV_CMD_RUN_PREARM_CHECKS:
                self.ack(m, result)
                self.prearm_report()
                return
            if m.command == L.MAV_CMD_COMPONENT_ARM_DISARM:
                if m.param1 == 1 and not v.prearm_ok:
                    result = L.MAV_RESULT_FAILED
                    self.prearm_report()
                else:
                    v.armed = m.param1 == 1
                    self.mav.statustext_send(L.MAV_SEVERITY_INFO, b"Arming motors" if v.armed else b"Disarming motors")
            elif m.command == L.MAV_CMD_DO_SET_MODE:
                if int(m.param2) != v.mode:     # the mode it is already in is left as it is
                    v.enter(int(m.param2))
            elif m.command == L.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN:
                self.boot = time.monotonic()
            elif m.command == L.MAV_CMD_NAV_TAKEOFF:
                if not v.armed or v.mode != GUIDED or v.flying or m.param7 <= v.alt:
                    result = L.MAV_RESULT_FAILED
                else:
                    v.climb_to = m.param7
                    v.guided_flying_to = False
            elif m.command == L.MAV_CMD_DO_CHANGE_SPEED:
                v.speed = m.param2
            elif m.command == L.MAV_CMD_CONDITION_YAW:
                v.heading = m.param1
            elif m.command == L.MAV_CMD_DO_PAUSE_CONTINUE:
                v.paused = m.param1 == 0
            elif m.command == L.MAV_CMD_MISSION_START:
                if not v.armed or len(v.plans[MISSION]) < 2:
                    result = L.MAV_RESULT_FAILED
                    v.notes.append(b"Auto: Missing Takeoff Cmd")
                else:
                    v.mode = AUTO
                    v.mission_running = True
                    v.current = max(v.current, 1)
            elif m.command == L.MAV_CMD_DO_SET_MISSION_CURRENT:
                if 1 <= m.param1 < len(v.plans[MISSION]):
                    v.current = int(m.param1)
                else:
                    result = L.MAV_RESULT_DENIED
            elif m.command == L.MAV_CMD_DO_FENCE_ENABLE:
                v.fence_on = m.param1 == 1
            elif m.command == L.MAV_CMD_DO_SET_HOME:
                v.has_home = True
            elif m.command == L.MAV_CMD_PREFLIGHT_CALIBRATION:
                if v.armed:
                    result = L.MAV_RESULT_DENIED
            elif m.command == L.MAV_CMD_DO_MOTOR_TEST:
                if v.armed:
                    result = L.MAV_RESULT_FAILED
                elif int(m.param1) not in MOTOR_AT_TEST_PLACE:
                    result = L.MAV_RESULT_FAILED
                else:
                    v.motor_tests.append((MOTOR_AT_TEST_PLACE[int(m.param1)], m.param2, m.param3, m.param4))
            self.ack(m, result)

    def on_plan_message(self, m, kind):
        v = self.v
        to = (m.get_srcSystem(), m.get_srcComponent())
        code = getattr(m, "mission_type", MISSION)
        if kind == "MISSION_REQUEST_LIST":
            if code in v.deny_reads or (v.upload and v.upload["type"] == code):
                self.mav.mission_ack_send(*to, L.MAV_MISSION_DENIED, code)
            else:
                self.mav.mission_count_send(*to, len(v.plans[code]), code)
        elif kind == "MISSION_REQUEST_INT":
            if m.seq in v.drop_items:
                v.drop_items.remove(m.seq)
            elif m.seq >= len(v.plans[code]):
                self.mav.mission_ack_send(*to, L.MAV_MISSION_INVALID_SEQUENCE, code)
            else:
                i = v.plans[code][m.seq]
                self.mav.mission_item_int_send(*to, m.seq, i["frame"], i["command"], 0, 1, *i["p"], i["x"], i["y"], i["z"], code)
        elif kind == "MISSION_ACK":
            if m.type == L.MAV_MISSION_OPERATION_CANCELLED:
                v.upload = None
        elif kind == "MISSION_CLEAR_ALL":
            v.plans[code] = [home_item(v.has_home)] if code == MISSION else []
            v.commands.append(("MISSION_CLEAR_ALL", code, 0))
            self.mav.mission_ack_send(*to, L.MAV_MISSION_ACCEPTED, code)
        elif kind == "MISSION_COUNT":
            v.commands.append(("MISSION_COUNT", code, m.count))
            v.upload = {"type": code, "count": m.count, "next": 0, "got": []}
            if code == MISSION:     # as ArduPilot does: what was stored is overwritten as the items arrive
                v.plans[MISSION] = v.plans[MISSION][:m.count]
            self.mav.mission_request_int_send(*to, 0, code)
        elif kind == "MISSION_ITEM_INT":
            up = v.upload
            if not up or up["type"] != code or m.seq != up["next"]:
                return
            item = {"command": m.command, "frame": m.frame, "x": m.x, "y": m.y, "z": m.z,
                    "p": [m.param1, m.param2, m.param3, m.param4]}
            if v.refuse_item and v.refuse_item[0] == m.seq:
                v.upload = None
                self.mav.mission_ack_send(*to, v.refuse_item[1], code)
                return
            up["got"].append(item)
            if code == MISSION and m.seq > 0:
                plan = v.plans[MISSION]
                plan[m.seq:m.seq + 1] = [item]
            up["next"] += 1
            if up["next"] == v.stall_upload_at:
                return
            if up["next"] < up["count"]:
                self.mav.mission_request_int_send(*to, up["next"], code)
            else:
                if code != MISSION:     # the fence and the rally points change only once it is all there
                    v.plans[code] = up["got"]
                v.upload = None
                self.mav.mission_ack_send(*to, L.MAV_MISSION_ACCEPTED, code)

    def ack(self, m, result):
        self.mav.command_ack_send(m.command, result, 0, 0, m.get_srcSystem(), m.get_srcComponent())


STREAMS = (
    (0.25, (L.MAVLINK_MSG_ID_ATTITUDE, L.MAVLINK_MSG_ID_VFR_HUD)),
    (0.5, (L.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, L.MAVLINK_MSG_ID_SYS_STATUS, L.MAVLINK_MSG_ID_GPS_RAW_INT,
           L.MAVLINK_MSG_ID_SERVO_OUTPUT_RAW, L.MAVLINK_MSG_ID_RC_CHANNELS, L.MAVLINK_MSG_ID_EKF_STATUS_REPORT,
           L.MAVLINK_MSG_ID_VIBRATION, L.MAVLINK_MSG_ID_SCALED_PRESSURE, L.MAVLINK_MSG_ID_RAW_IMU,
           L.MAVLINK_MSG_ID_MEMINFO, L.MAVLINK_MSG_ID_SYSTEM_TIME, L.MAVLINK_MSG_ID_MISSION_CURRENT,
           L.MAVLINK_MSG_ID_TERRAIN_REPORT, L.MAVLINK_MSG_ID_NAV_CONTROLLER_OUTPUT, L.MAVLINK_MSG_ID_BATTERY_STATUS,
           L.MAVLINK_MSG_ID_POWER_STATUS, L.MAVLINK_MSG_ID_FENCE_STATUS, L.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT)),
)


async def serve(vehicle, reader, writer, quiet, silent_after):
    conn = Connection(vehicle, writer, quiet)
    started = time.monotonic()
    next_due = {period: 0.0 for period, _ in STREAMS}
    last_beat = 0.0
    last_note = time.monotonic()
    notes = 0

    async def receive():
        while data := await reader.read(4096):
            for m in conn.mav.parse_buffer(data) or ():
                conn.on_message(m)

    receiver = asyncio.create_task(receive())
    last = time.monotonic()
    try:
        while not receiver.done():
            await asyncio.sleep(0.05)
            now = time.monotonic()
            vehicle.step(now - last)
            last = now
            if silent_after and now - started > silent_after:
                continue    # the link stays open but nothing arrives, like a lost serial wire
            if now - last_beat >= 1:
                last_beat = now
                conn.heartbeat()
            while vehicle.notes:
                conn.mav.statustext_send(L.MAV_SEVERITY_INFO, vehicle.notes.pop(0))
            if vehicle.flying and now - last_note >= 12:
                last_note = now
                conn.mav.statustext_send(L.MAV_SEVERITY_INFO, FLIGHT_MESSAGES[notes % len(FLIGHT_MESSAGES)].encode())
                notes += 1
            if not quiet:
                for period, ids in STREAMS:
                    if now >= next_due[period]:
                        next_due[period] = now + period
                        for msg_id in ids:
                            conn.send(msg_id)
            await writer.drain()
    except ConnectionError:
        pass
    finally:
        receiver.cancel()
        writer.close()


async def run(port, scenario, quiet, silent_after=None):
    vehicle = Vehicle(scenario)
    server = await asyncio.start_server(lambda r, w: serve(vehicle, r, w, quiet, silent_after), "127.0.0.1", port)
    return server, vehicle


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=15678)
    parser.add_argument("--scenario", default="bench", choices=("bench", "ready", "armed", "flight", "low", "rclost"))
    parser.add_argument("--quiet", action="store_true", help="heartbeats only, answer requests")
    parser.add_argument("--silent-after", type=float, help="stop sending after this many seconds")
    args = parser.parse_args()
    server, _ = await run(args.port, args.scenario, args.quiet, args.silent_after)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
