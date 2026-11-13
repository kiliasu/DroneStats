"""Everything that can be asked of the flight controller, in one table.

The control panel on the page is built from this table, and an MCP server can offer it as tools:
each action has a stable name, a JSON Schema for its input, a risk level, and rules saying when it
may run. It holds no web code. Who may ask, and how that is proved, is the caller's business: for
the page that is the token and live-data check in server.py.

Every rule fails closed. A fact that is not known counts against the action, so nothing goes through
on the absence of evidence. Each command goes to the flight controller once and is never repeated:
if the reply is lost the result says so and whoever asked decides.
"""
import asyncio
import collections
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Callable

import plans
from wire import L

log = logging.getLogger("dronestats")

ROUTINE, CAUTION, DANGER = "routine", "caution", "danger"
HOLD_MS = {ROUTINE: 1000, CAUTION: 1500, DANGER: 2500}     # how long the page wants a button held

STABILIZE, ALT_HOLD, AUTO, GUIDED, LOITER, RTL, CIRCLE, LAND, POSHOLD, BRAKE, SMART_RTL = 0, 2, 3, 4, 5, 6, 7, 9, 16, 17, 21
MODES = [STABILIZE, ALT_HOLD, LOITER, POSHOLD, GUIDED, AUTO, CIRCLE, BRAKE, RTL, SMART_RTL, LAND]
FLIES_ON_POSITION = {AUTO, GUIDED, LOITER, RTL, CIRCLE, POSHOLD, BRAKE, SMART_RTL}
NEEDS_PILOT = {STABILIZE, ALT_HOLD, LOITER, POSHOLD, CIRCLE}    # in the air, their height follows the throttle stick

GROUND_REPORT_S = 6
POSITION_REPORT_S = 5
ESTIMATOR_REPORT_S = 15
RC_REPORT_S = 5
STICK_LOW_PWM = 1400    # below this those modes go down: the stick's middle, 1500, less ArduCopter's THR_DZ of 100
MAX_GOTO_M = 1000
ARRIVED_M = 2.5         # this close counts as having got there, for landing on arrival
PENDING_LIMIT_S = 600   # a landing still waiting after this long is given up, and it stays in Guided
MODE_SETTLE_S = 3       # the telemetry can take this long to show a mode change it has just been told of
MAX_ALT_M = 120
SETTLE_S = 2.5          # how long a command gets to show its effect in the telemetry
EXPLAIN_S = .3          # the flight controller's explanation can arrive just after its refusal
LOG_KEPT = 40
FORCE_DISARM = 21196    # ArduPilot's magic number for disarming regardless of state

RC_BIT = L.MAV_SYS_STATUS_SENSOR_RC_RECEIVER
FENCE_BIT = L.MAV_SYS_STATUS_GEOFENCE
FENCE_ALT_MAX, FENCE_CIRCLE, FENCE_POLYGON = 1, 2, 4    # bits of FENCE_TYPE

# The motor test takes a place in the order the test goes round in, not a motor's number. On a quad X
# that order is clockwise from the front right, which is motors 1, 4, 2, 3 as ArduCopter numbers them
# and as the page labels them (AP_MotorsMatrix, MOTOR_FRAME_TYPE_X). For any other frame the order is
# not known here, so no motor is spun.
QUAD_X = (1, 1)     # FRAME_CLASS, FRAME_TYPE
QUAD_X_TEST_ORDER = {1: 1, 2: 3, 3: 4, 4: 2}

# The actions that give ArduCopter's Guided mode a new destination.
REPOSITIONS = ("goto", "land_at", "altitude")

# Settings the panel may write, with the range it accepts. Names and units are those of ArduCopter
# 4.7.1, which moved several from centimetres to metres and renamed them. The ranges are narrower
# than the firmware's on purpose: 1500 meant for centimetres must not pass as 1500 m. A setting not
# listed cannot be written from here, and telemetry.py reads each of them.
EDITABLE = {
    "RTL_ALT_M": {"minimum": 2, "maximum": 120, "unit": "m"},
    "RTL_SPEED_MS": {"minimum": 0, "maximum": 20, "unit": "m/s"},       # 0 follows WP_SPD
    "WP_SPD": {"minimum": .5, "maximum": 20, "unit": "m/s"},
    "WP_SPD_UP": {"minimum": .1, "maximum": 10, "unit": "m/s"},
    "WP_SPD_DN": {"minimum": .1, "maximum": 10, "unit": "m/s"},
    "LAND_SPD_MS": {"minimum": .3, "maximum": 2, "unit": "m/s"},
    "FENCE_ALT_MAX": {"minimum": 10, "maximum": 1000, "unit": "m"},
    "FENCE_RADIUS": {"minimum": 30, "maximum": 10000, "unit": "m"},
}


class BadParam(ValueError):
    """Input that does not match the action's schema. The argument names the field."""


def _stick_low(t):
    """Whether the throttle stick is where those modes would go down. Not having heard counts as yes."""
    rc = t.state.get("rc")
    channel = int((t.state.get("params") or {}).get("RCMAP_THROTTLE") or 3) - 1
    if not rc or t.age("RC_CHANNELS") >= RC_REPORT_S or not 0 <= channel < len(rc["ch"]):
        return True
    return not STICK_LOW_PWM <= rc["ch"][channel] < 65535


class Facts:
    """What is known right now, for deciding whether something may be asked."""

    def __init__(self, telemetry):
        t = telemetry
        s = t.state
        self.fresh = t.fresh()
        self.armed = bool(s.get("armed"))
        self.mode = s.get("mode")
        landed = s.get("landed") if t.age("EXTENDED_SYS_STATE") < GROUND_REPORT_S else None
        self.on_ground = landed == L.MAV_LANDED_STATE_ON_GROUND
        self.in_air = landed in (L.MAV_LANDED_STATE_IN_AIR, L.MAV_LANDED_STATE_TAKEOFF, L.MAV_LANDED_STATE_LANDING)
        pos = s.get("pos")
        self.place = tuple(pos[:2]) if pos and pos[0] is not None and t.age("GLOBAL_POSITION_INT") < POSITION_REPORT_S else None
        self.height = pos[3] if self.place else None       # above home
        ekf = s.get("ekf")
        self.position = (self.place is not None and ekf is not None and t.age("EKF_STATUS_REPORT") < ESTIMATOR_REPORT_S
                         and bool(ekf["flags"] & L.ESTIMATOR_POS_HORIZ_ABS) and not ekf["flags"] & L.ESTIMATOR_CONST_POS_MODE)
        self.home = s.get("home")
        sens = s.get("sens")
        self.rc = bool(sens and sens[0] & RC_BIT and sens[2] & RC_BIT)
        self.stick_low = _stick_low(t)
        self.waypoints = max(t.plans.waypoints(), (s.get("mission") or (0, 0))[1])
        params = s.get("params") or {}
        self.frame = (params.get("FRAME_CLASS"), params.get("FRAME_TYPE"))
        self.outside_fence = _outside_fence(self.place, self.height, self.home, params, t.plans.entries["fence"]["items"])


# ---- Rules: each returns why not, or None ----------------------------------------

def _armed(f): return None if f.armed else "not_armed"
def _disarmed(f): return "armed" if f.armed else None
def _on_ground(f): return None if f.on_ground else "not_on_ground"
def _in_air(f): return None if f.in_air else "not_in_air"
def _position(f): return None if f.position else "no_position"
def _guided(f): return None if f.mode == GUIDED else "not_guided"
def _steered(f): return None if f.mode in (GUIDED, AUTO) else "not_steered"
def _mission(f): return None if f.waypoints else "no_mission"


def _all(*rules):
    def rule(f):
        for each in rules:
            if reason := each(f):
                return reason
        return None
    return rule


def _mode_rule(f, mode):
    if mode in FLIES_ON_POSITION and not f.position:
        return "no_position"
    if mode in (RTL, SMART_RTL) and not f.home:
        return "no_home"
    if mode == AUTO and not f.waypoints:
        return "no_mission"
    if mode in NEEDS_PILOT and not f.on_ground:
        if not f.rc:
            return "no_rc"      # with no sticks to answer to, these would fall or drift
        if f.stick_low:
            return "stick_low"  # they would go down until they hit the ground, and Stabilize would fall
    return None


def _metres(a, b):
    north = (b[0] - a[0]) * 111320
    east = (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(north, east)


def _inside_polygon(place, points):
    lat, lon = place
    inside = False
    for (ay, ax), (by, bx) in zip(points, points[-1:] + points[:-1]):
        if (ay > lat) != (by > lat) and lon < (bx - ax) * (lat - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def _outside_fence(place, height, home, params, items):
    """Whether the aircraft is outside what its fence would allow were it on, as far as can be told.
    What is not known is left out: the flight controller has the last word."""
    if place is None:
        return False
    types = int(params.get("FENCE_TYPE") or 0)
    if types & FENCE_ALT_MAX and height is not None and params.get("FENCE_ALT_MAX") and height > params["FENCE_ALT_MAX"]:
        return True
    if types & FENCE_CIRCLE and home and params.get("FENCE_RADIUS") and _metres(home[:2], place) > params["FENCE_RADIUS"]:
        return True
    if not types & FENCE_POLYGON:
        return False
    keep_in, inside_one, index = False, False, 0
    while index < len(items):
        item = items[index]
        command, count = item.get("cmd"), int(item["p"][0] or 0) if item.get("p") else 0
        if command in (plans.FENCE_POLY_IN, plans.FENCE_POLY_OUT) and count >= 3:
            points = [(vertex["lat"], vertex["lon"]) for vertex in items[index:index + count]]
            index += count
            if len(points) < count or any(None in point for point in points):
                continue
            within = _inside_polygon(place, points)
            if command == plans.FENCE_POLY_OUT and within:
                return True
            if command == plans.FENCE_POLY_IN:
                keep_in, inside_one = True, inside_one or within
            continue
        if command in (plans.FENCE_CIRCLE_IN, plans.FENCE_CIRCLE_OUT) and item.get("lat") is not None and count > 0:
            within = _metres((item["lat"], item["lon"]), place) <= item["p"][0]
            if within != (command == plans.FENCE_CIRCLE_IN):
                return True
        index += 1
    return keep_in and not inside_one


def _takeoff_check(f, p):
    # ArduCopter takes the height as above home and refuses, without saying why, one that is not above
    # where the aircraft already is.
    return "too_low" if f.height is not None and p["alt"] <= f.height else None


def _fence_check(f, p):
    # In the air, a fence turned on round an aircraft already outside it sets off its action at once.
    return "outside_fence" if p["on"] and f.armed and not f.on_ground and f.outside_fence else None


def _motor_check(f, p):
    return None if f.frame == QUAD_X else "unknown_frame"


def _goto_check(f, p):
    if f.mode != GUIDED and not p.get("change_mode", True):
        return "not_guided"
    return "too_far" if _metres(f.place, (p["lat"], p["lon"])) > MAX_GOTO_M else None


def _home_check(f, p):
    return "bad_place" if (p["lat"] is None) != (p["lon"] is None) else None


def _seq_check(f, p):
    return "no_such_item" if p["seq"] > f.waypoints else None


def _plan_check(f, p):
    try:
        plans.check(p["kind"], p["items"])
    except plans.BadPlan as e:
        log.warning("plan refused: %s", e)
        return "bad_plan"
    return None


def _param_check(f, p):
    limits = EDITABLE[p["name"]]
    return None if limits["minimum"] <= p["value"] <= limits["maximum"] else "out_of_range"


# ---- Sending ----------------------------------------------------------------------

async def _guided_alt(t, p):
    """A new height, on the way to wherever it is going at this moment, or where it is if it is going
    nowhere. The flight controller is asked now: what it said a few seconds ago may be the waypoint of a
    mission or a return it has since left, and the aircraft would set off for that."""
    lat, lon = await t.destination() or t.state["pos"][:2]
    return await t.command_at(L.MAV_CMD_DO_REPOSITION, lat, lon, p["alt"], -1, 0, 0, math.nan)


CALIBRATIONS = {"gyro": (1, 0, 0, 0, 0, 0, 0), "baro": (0, 0, 1, 0, 0, 0, 0), "level": (0, 0, 0, 0, 2, 0, 0)}


def _reposition(t, p, change_mode):
    """Flies to a place, first switching to Guided if asked. Asking is what a ground station's "fly to
    here" does, and it holds in the air with nothing to answer to if it is never told otherwise."""
    return t.command_at(L.MAV_CMD_DO_REPOSITION, p["lat"], p["lon"], p["alt"], -1,
                        L.MAV_DO_REPOSITION_FLAGS_CHANGE_MODE if change_mode else 0, 0, math.nan)


async def _set_home(t, p):
    if p["lat"] is None:
        result = await t.command(L.MAV_CMD_DO_SET_HOME, 1)
    else:
        # The height of a point on the map is not known here, so home keeps the one it has.
        msl = (t.state.get("home") or (0, 0, None))[2]
        if msl is None:
            msl = t.state["pos"][2]
        result = await t.command_at(L.MAV_CMD_DO_SET_HOME, p["lat"], p["lon"], msl, 0, frame=L.MAV_FRAME_GLOBAL)
    if result == L.MAV_RESULT_ACCEPTED:
        t.ask_for(L.MAVLINK_MSG_ID_HOME_POSITION)
    return result


async def _set_item(t, p):
    result = await t.command(L.MAV_CMD_DO_SET_MISSION_CURRENT, p["seq"], 0)
    if result == L.MAV_RESULT_ACCEPTED:
        t.ask_for(L.MAVLINK_MSG_ID_MISSION_CURRENT)
    return result


async def _upload(t, p):
    """Writes a plan, reads it back, and only calls it done if the two agree. The flight controller
    overwrites a stored mission as the items arrive, so one it refuses halfway stays half written:
    the reply says so, and the read-back puts what is really there on the page."""
    prepared = plans.check(p["kind"], p["items"])
    result = await t.plans.link.write(p["kind"], prepared)
    read = await t.plans.read(p["kind"])
    stored = t.plans.entries[p["kind"]]["items"]
    if result == L.MAV_MISSION_ACCEPTED and read and plans.same_plan(p["kind"], prepared, stored):
        return result
    why = "read back differently" if result == L.MAV_MISSION_ACCEPTED else "no reply" if result is None else L.enums["MAV_MISSION_RESULT"][result].name
    t.say_to_listeners(f"{why}, {len(stored)} items now stored" if read else f"{why}, what is now stored is unknown")
    return L.MAV_RESULT_FAILED if result == L.MAV_MISSION_ACCEPTED else result


async def _clear(t, p):
    result = await t.plans.link.clear(p["kind"])
    await t.plans.read(p["kind"])
    return result


async def _write_setting(t, p):
    held = await t.set_param(p["name"], p["value"])
    if held is None:
        return None
    return L.MAV_RESULT_ACCEPTED if abs(held - p["value"]) < 1e-3 * max(1, abs(p["value"])) else L.MAV_RESULT_FAILED


# ---- The table ---------------------------------------------------------------------

def _num(low, high, unit, **more):
    return {"type": "number", "minimum": low, "maximum": high, "unit": unit, **more}


KIND = {"type": "string", "enum": list(plans.KINDS)}


async def _nothing():
    return L.MAV_RESULT_ACCEPTED


@dataclass(frozen=True)
class Action:
    name: str
    group: str
    risk: str
    summary: str
    send: Callable
    params: dict = field(default_factory=dict)
    state: Callable | None = None       # may this run now, whatever its input
    check: Callable | None = None       # and with this input
    settled: Callable | None = None     # has it shown its effect
    ground_report: bool = False         # needs the flight controller to say at this moment that it is on the ground
    keeps_pending: bool = False         # leaves a landing on arrival in place: it does not change where the aircraft goes
    urgent: bool = False                # goes ahead even with another command in progress
    hold_ms: int | None = None
    timeout_s: float = 10
    extra: dict = field(default_factory=dict)


_ACTIONS = [
    Action("arm", "flight", CAUTION, "Arm the motors. The flight controller runs its own pre-arm checks and may refuse.",
           lambda t, p: t.command(L.MAV_CMD_COMPONENT_ARM_DISARM, 1), state=_disarmed,
           settled=lambda s, p: s.get("armed") is True),
    Action("disarm", "flight", CAUTION, "Disarm the motors. Only when the flight controller confirms it is on the ground.",
           lambda t, p: t.command(L.MAV_CMD_COMPONENT_ARM_DISARM, 0), state=_armed, ground_report=True,
           settled=lambda s, p: s.get("armed") is False),
    Action("mode", "flight", ROUTINE, "Change the flight mode.",
           lambda t, p: t.command(L.MAV_CMD_DO_SET_MODE, L.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, p["mode"]),
           params={"mode": {"type": "integer", "enum": MODES}}, check=lambda f, p: _mode_rule(f, p["mode"]),
           settled=lambda s, p: s.get("mode") == p["mode"]),
    Action("takeoff", "flight", CAUTION, "Climb straight up to a height above home. Needs Guided mode, armed, on the ground.",
           lambda t, p: t.command(L.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, p["alt"]),
           params={"alt": _num(1, MAX_ALT_M, "m", default=5)}, state=_all(_armed, _guided, _on_ground, _position),
           check=_takeoff_check),

    Action("goto", "guided", CAUTION, "Fly to a position at a height above home, in the air. Unless change_mode is true this needs Guided mode already.",
           lambda t, p: _reposition(t, p, p["change_mode"]),
           params={"lat": _num(-90, 90, "deg"), "lon": _num(-180, 180, "deg"), "alt": _num(2, MAX_ALT_M, "m"),
                   "change_mode": {"type": "boolean", "default": False}},
           state=_all(_armed, _in_air, _position), check=_goto_check),
    Action("land_at", "guided", CAUTION, "Fly to a position, switching to Guided, and land when there. Any other command that changes where it goes cancels the landing, and so does execution closing.",
           lambda t, p: _reposition(t, p, True),
           params={"lat": _num(-90, 90, "deg"), "lon": _num(-180, 180, "deg"), "alt": _num(2, MAX_ALT_M, "m")},
           state=_all(_armed, _in_air, _position), check=_goto_check),
    Action("land_cancel", "guided", ROUTINE, "Cancel a landing on arrival. It stays in Guided and carries on to the place.",
           lambda t, p: _nothing(), keeps_pending=False),
    Action("altitude", "guided", CAUTION, "Change the height above home, keeping the present destination. Needs Guided mode, in the air.",
           _guided_alt, params={"alt": _num(2, MAX_ALT_M, "m")}, state=_all(_armed, _guided, _in_air, _position)),
    Action("speed", "guided", ROUTINE, "Set the horizontal speed in Guided or Auto. In Guided it holds until the aircraft leaves that mode.",
           lambda t, p: t.command(L.MAV_CMD_DO_CHANGE_SPEED, 1, p["speed"], -1),
           params={"speed": _num(.5, 20, "m/s", default=5)}, state=_all(_armed, _steered), keeps_pending=True),
    Action("yaw", "guided", ROUTINE, "Turn to a compass heading, in Guided or Auto.",
           lambda t, p: t.command(L.MAV_CMD_CONDITION_YAW, p["heading"], p["rate"], 0, 0),
           params={"heading": _num(0, 360, "deg"), "rate": _num(1, 90, "deg/s", default=30)},
           state=_all(_armed, _in_air, _steered), keeps_pending=True),
    Action("pause", "guided", ROUTINE, "Hold position on the way to the next point, in Guided or Auto. A new place to fly to in Guided ends the pause.",
           lambda t, p: t.command(L.MAV_CMD_DO_PAUSE_CONTINUE, 0), state=_all(_armed, _in_air, _steered)),
    Action("resume", "guided", ROUTINE, "Carry on after a pause.",
           lambda t, p: t.command(L.MAV_CMD_DO_PAUSE_CONTINUE, 1), state=_all(_armed, _in_air, _steered)),

    Action("mission_start", "mission", CAUTION, "Switch to Auto and start the stored mission from the current item. Needs armed.",
           lambda t, p: t.command(L.MAV_CMD_MISSION_START, 0, 0), state=_all(_armed, _position, _mission),
           settled=lambda s, p: s.get("mode") == AUTO),
    Action("mission_item", "mission", CAUTION, "Make this item of the stored mission the next one to fly to.",
           _set_item, params={"seq": {"type": "integer", "minimum": 1, "maximum": plans.MAX_ITEMS}}, state=_mission, check=_seq_check,
           settled=lambda s, p: (s.get("mission") or (None,))[0] == p["seq"]),
    Action("plan_upload", "mission", DANGER, "Replace the stored mission, fence or rally points. The plan is read back and compared.",
           _upload, params={"kind": KIND, "items": {"type": "array"}}, state=_disarmed, check=_plan_check, timeout_s=180,
           extra={"mission_commands": sorted(plans.MISSION_COMMANDS)}),
    Action("plan_clear", "mission", DANGER, "Erase the stored mission, fence or rally points.",
           _clear, params={"kind": KIND}, state=_disarmed, timeout_s=20),

    Action("fence_enable", "safety", CAUTION, "Turn the geofence on or off.",
           lambda t, p: t.command(L.MAV_CMD_DO_FENCE_ENABLE, 1 if p["on"] else 0), params={"on": {"type": "boolean"}},
           check=_fence_check,
           settled=lambda s, p: bool((s.get("sens") or (0, 0, 0))[1] & FENCE_BIT) == p["on"], keeps_pending=True),
    Action("set_home", "safety", CAUTION, "Make the present position, or a given one, home: where RTL returns to. Only while disarmed.",
           _set_home, params={"lat": _num(-90, 90, "deg", default=None), "lon": _num(-180, 180, "deg", default=None)},
           state=_all(_disarmed, _position), check=_home_check),
    Action("param_set", "safety", CAUTION, "Write one of a few flight limits. Only while disarmed.",
           _write_setting, params={"name": {"type": "string", "enum": list(EDITABLE)}, "value": {"type": "number"}},
           state=_disarmed, check=_param_check, extra={"limits": EDITABLE}),

    Action("calibrate", "setup", DANGER, "Calibrate the gyros, barometer or level. The aircraft must stay still.",
           lambda t, p: t.command(L.MAV_CMD_PREFLIGHT_CALIBRATION, *CALIBRATIONS[p["what"]], timeout=30),
           params={"what": {"type": "string", "enum": list(CALIBRATIONS)}}, state=_all(_disarmed, _on_ground), timeout_s=40),
    Action("motor_test", "setup", DANGER, "Spin one motor of a quad X briefly, by its number. Its propeller turns: take the propellers off first.",
           lambda t, p: t.command(L.MAV_CMD_DO_MOTOR_TEST, QUAD_X_TEST_ORDER[p["motor"]], L.MOTOR_TEST_THROTTLE_PERCENT,
                                  p["throttle"], p["seconds"], 0, 0),
           params={"motor": {"type": "integer", "minimum": 1, "maximum": 4},
                   "throttle": _num(1, 30, "%", default=10), "seconds": _num(1, 5, "s", default=2)},
           state=_all(_disarmed, _on_ground), check=_motor_check),
    Action("reboot", "setup", DANGER, "Restart the flight controller. Only while disarmed.",
           lambda t, p: t.command(L.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 1), state=_disarmed, hold_ms=2000),

    Action("kill", "emergency", DANGER, "Stop the motors at once, even in the air. The aircraft falls.",
           lambda t, p: t.command(L.MAV_CMD_COMPONENT_ARM_DISARM, 0, FORCE_DISARM), state=_armed, urgent=True, hold_ms=3000,
           settled=lambda s, p: s.get("armed") is False),
]

ACTIONS = {action.name: action for action in _ACTIONS}


def catalog():
    """The table in a form a page or an MCP client can read."""
    out = []
    for a in _ACTIONS:
        required = [key for key, spec in a.params.items() if "default" not in spec]
        out.append({"name": a.name, "group": a.group, "risk": a.risk, "summary": a.summary, "hold_ms": a.hold_ms or HOLD_MS[a.risk],
                    "timeout_s": a.timeout_s, "input_schema": {"type": "object", "properties": a.params, "required": required,
                                                               "additionalProperties": False}, **a.extra})
    return out


def _checked(spec, value, name):
    kind = spec["type"]
    if kind == "number":
        ok = type(value) in (int, float) and math.isfinite(value)
    elif kind == "integer":
        ok = type(value) is int
    elif kind == "boolean":
        ok = type(value) is bool
    elif kind == "string":
        ok = type(value) is str
    elif kind == "array":
        ok = type(value) is list
    else:
        ok = False
    if ok and "enum" in spec:
        ok = value in spec["enum"]
    if ok and "minimum" in spec:
        ok = spec["minimum"] <= value <= spec["maximum"]
    if not ok:
        raise BadParam(name)
    return value


def clean(action, given):
    """The input with defaults filled in, or BadParam. Anything not in the schema is refused."""
    if not isinstance(given, dict):
        raise BadParam("params")
    for name in given:
        if name not in action.params:
            raise BadParam(str(name)[:40])
    out = {}
    for name, spec in action.params.items():
        if name in given:
            out[name] = _checked(spec, given[name], name)
        elif "default" in spec:
            out[name] = spec["default"]
        else:
            raise BadParam(name)
    return out


def _described(params):
    """What was asked, short enough for a log line. Plans are described, not copied."""
    return {key: (f"{len(value)} items" if isinstance(value, list) else value) for key, value in params.items()}


class Commander:
    """Runs actions from the table against one telemetry link, and keeps a record of them."""

    def __init__(self, telemetry):
        self.t = telemetry
        self.record = collections.deque(maxlen=LOG_KEPT)
        self.pending = None     # a landing to do on arrival: {"lat", "lon", "at"}
        self.speed = None       # the speed asked for in Guided, which holds until the aircraft leaves that mode

    def availability(self):
        """Why each action cannot run now, leaving out those that can."""
        f = Facts(self.t)
        if not f.fresh:
            return {"*": "no_link"}
        out = {a.name: reason for a in _ACTIONS if a.state and (reason := a.state(f))}
        modes = {str(mode): reason for mode in MODES if (reason := _mode_rule(f, mode))}
        if modes:
            out["mode"] = modes
        return out

    async def refusal(self, action, params):
        """Why this cannot run now, or None. May ask the flight controller."""
        f = Facts(self.t)
        if not f.fresh:
            return "no_link"
        reason = (action.state and action.state(f)) or (action.check and action.check(f, params))
        if reason:
            return reason
        if action.ground_report and not await self.t.confirmed_on_ground():
            return "in_air"
        return None

    async def send(self, action, params):
        """Sends it once. Returns the result and what the flight controller said meanwhile."""
        if not action.keeps_pending:
            self._set_pending(None)
        heard = self.t.listen()
        try:
            result = await action.send(self.t, params)
            if result != L.MAV_RESULT_ACCEPTED:
                await asyncio.sleep(EXPLAIN_S)
                return result, heard[-3:]
            if action.name == "land_at":
                self._set_pending({"lat": params["lat"], "lon": params["lon"], "at": time.monotonic()})
            if action.name == "speed" and self.t.state.get("mode") == GUIDED:
                self._set_speed(params["speed"])
            if action.name in REPOSITIONS:
                await self._carry_on()
            return result, heard[-3:]
        finally:
            self.t.stop_listening(heard)

    async def _carry_on(self):
        """What ArduCopter has to be told again once Guided has a new destination. A pause outlasts one,
        so the aircraft would stay where it is with the command accepted. And the first destination after
        a takeoff or a change of mode starts again from WP_SPD, whatever speed was asked for before it."""
        if await self.t.command(L.MAV_CMD_DO_PAUSE_CONTINUE, 1) != L.MAV_RESULT_ACCEPTED:
            self.t.say_to_listeners("Could not end a pause: if it does not move, press Resume")
        if self.speed is not None and await self.t.command(L.MAV_CMD_DO_CHANGE_SPEED, 1, self.speed, -1) != L.MAV_RESULT_ACCEPTED:
            self._set_speed(None)
            self.t.say_to_listeners("The speed asked for earlier was not taken again: it flies at WP_SPD")

    def _set_pending(self, pending):
        self.pending = pending
        self.t.publish("pending", {"lat": pending["lat"], "lon": pending["lon"]} if pending else None)

    def _set_speed(self, speed):
        self.speed = speed
        self.t.publish("asked_speed", speed)

    def give_up_landing(self):
        """Execution has closed, and with it the leave to send anything: a landing still to come is given
        up. The aircraft stays in Guided at the place, as it does when anything else has changed."""
        if self.pending:
            self._set_pending(None)
            self.note(ACTIONS["land_at"], {}, "cancelled")

    def tick(self):
        """Carries out a landing on arrival. It gives up rather than guess if anything has changed: the
        aircraft then just stays in Guided at the place, and the person can see that it has."""
        s, now = self.t.state, time.monotonic()
        if self.speed is not None and (not self.t.fresh() or s.get("armed") is False or s.get("mode") != GUIDED):
            self._set_speed(None)       # ArduCopter forgets it on leaving Guided, and so does this
        p = self.pending
        if p is None:
            return
        waited = now - p["at"]
        if not self.t.fresh():
            if waited > PENDING_LIMIT_S:
                self._set_pending(None)
            return      # with no link there is nothing to go on, and it holds at the place by itself
        if s.get("armed") is False or (waited > MODE_SETTLE_S and s.get("mode") != GUIDED) or waited > PENDING_LIMIT_S:
            self._set_pending(None)
            self.note(ACTIONS["land_at"], {}, "cancelled")
            return
        pos = s.get("pos")
        if pos and pos[0] is not None and _metres(pos[:2], (p["lat"], p["lon"])) <= ARRIVED_M:
            self._set_pending(None)
            self.landing = asyncio.create_task(self._land_on_arrival())

    async def _land_on_arrival(self):
        result = await self.t.command(L.MAV_CMD_DO_SET_MODE, L.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, LAND)
        self.note(ACTIONS["land_at"], {}, "landing" if result == L.MAV_RESULT_ACCEPTED else "no_reply" if result is None else "refused")

    async def settle(self, action, params, result):
        """Whether the telemetry came to show the effect: True, False, or None if there is nothing to look at."""
        if action.settled is None or result != L.MAV_RESULT_ACCEPTED:
            return None
        deadline = time.monotonic() + SETTLE_S
        while time.monotonic() < deadline:
            if action.settled(self.t.state, params):
                return True
            await asyncio.sleep(.05)
        return False

    def note(self, action, params, outcome):
        """Records what was asked and how it ended, for the panel and the service's journal."""
        self.record.appendleft([round(time.time()), action.name, _described(params), outcome])
        self.t.publish("cmds", list(self.record))
        log.warning("command %s %s: %s", action.name, _described(params), outcome)
