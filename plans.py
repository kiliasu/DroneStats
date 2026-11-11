"""Reading and writing what the flight controller stores: the mission, the fence and the rally points.

The same protocol carries all three. Reading changes nothing on the flight controller, so it runs
by itself while someone watches. Writing and clearing only happen through commands.py.

The flight controller answers one request at a time, so a transfer can never fill the link. It
serves a reader without keeping any state about it, so reading cannot upset a ground station's
transfer: while one is uploading it answers "denied", and we try again later.
"""
import asyncio
import logging
import math
import time

from wire import COMPID, L, SYSID

log = logging.getLogger("dronestats")

KINDS = {"mission": L.MAV_MISSION_TYPE_MISSION, "fence": L.MAV_MISSION_TYPE_FENCE, "rally": L.MAV_MISSION_TYPE_RALLY}

COUNT_TIMEOUT_S = 1.5
ITEM_TIMEOUT_S = 1.0
TRIES = 4
UPLOAD_TIMEOUT_S = 6.0      # the flight controller gives up on an upload after about 8 s of silence
MAX_ITEMS = 1000

NAV_WAYPOINT = L.MAV_CMD_NAV_WAYPOINT
NAV_TAKEOFF = L.MAV_CMD_NAV_TAKEOFF
NAV_LAND = L.MAV_CMD_NAV_LAND
NAV_RTL = L.MAV_CMD_NAV_RETURN_TO_LAUNCH
NAV_LOITER_UNLIM = L.MAV_CMD_NAV_LOITER_UNLIM
NAV_LOITER_TURNS = L.MAV_CMD_NAV_LOITER_TURNS
NAV_LOITER_TIME = L.MAV_CMD_NAV_LOITER_TIME
NAV_SPLINE = L.MAV_CMD_NAV_SPLINE_WAYPOINT
DO_JUMP = L.MAV_CMD_DO_JUMP
DO_LAND_START = L.MAV_CMD_DO_LAND_START
DO_CHANGE_SPEED = L.MAV_CMD_DO_CHANGE_SPEED
CONDITION_DELAY = L.MAV_CMD_CONDITION_DELAY
CONDITION_YAW = L.MAV_CMD_CONDITION_YAW
RALLY_POINT = L.MAV_CMD_NAV_RALLY_POINT
FENCE_RETURN = L.MAV_CMD_NAV_FENCE_RETURN_POINT
FENCE_POLY_IN = L.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
FENCE_POLY_OUT = L.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION
FENCE_CIRCLE_IN = L.MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION
FENCE_CIRCLE_OUT = L.MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION

# What may be written. Anything else in an uploaded plan is refused before it reaches the aircraft.
MISSION_COMMANDS = {NAV_WAYPOINT, NAV_TAKEOFF, NAV_LAND, NAV_RTL, NAV_LOITER_UNLIM, NAV_LOITER_TURNS, NAV_LOITER_TIME,
                    NAV_SPLINE, DO_JUMP, DO_LAND_START, DO_CHANGE_SPEED, CONDITION_DELAY, CONDITION_YAW}
NEEDS_PLACE = {NAV_WAYPOINT, NAV_LOITER_TURNS, NAV_LOITER_TIME, NAV_SPLINE}     # must say where
NEEDS_ALT = NEEDS_PLACE | {NAV_TAKEOFF}     # and how high: a missing height would mean flying into the ground
NO_PLACE_COMMANDS = {DO_JUMP, DO_CHANGE_SPEED, CONDITION_DELAY, CONDITION_YAW, DO_LAND_START}
BLANK_YAW = {NAV_WAYPOINT, NAV_TAKEOFF, NAV_LAND}   # the only ones whose fourth parameter ArduPilot lets be NaN
MIN_ALT_M = 1
MAX_ALT_M = 500
RELATIVE_ALT = L.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
RELATIVE_FRAMES = {L.MAV_FRAME_GLOBAL_RELATIVE_ALT, RELATIVE_ALT}
NO_PLACE = L.MAV_FRAME_MISSION


class BadPlan(ValueError):
    """An uploaded plan that does not make sense. The message says where."""


class Refused(Exception):
    """The flight controller answered no."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Lost(Exception):
    """The flight controller stopped answering, or the link went away."""


def _num(value, places=3):
    value = float(value)
    return round(value, places) if math.isfinite(value) else None


def from_message(m):
    """A stored item, in the form the page and the API use. An item with no place has lat and lon None."""
    placed = m.frame != NO_PLACE and (m.x != 0 or m.y != 0)
    return {"seq": m.seq, "cmd": m.command, "frame": m.frame,
            "lat": m.x / 1e7 if placed else None, "lon": m.y / 1e7 if placed else None, "alt": _num(m.z, 2),
            "p": [_num(m.param1), _num(m.param2), _num(m.param3), _num(m.param4)]}


def _finite(item, key, low, high, where):
    value = item.get(key)
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise BadPlan(f"{where}: {key}")
    return value


def _parameters(item, where, blank_yaw=False):
    """A blank is how a stored NaN reads back, and how ground station files write "no change". The
    flight controller refuses a NaN anywhere but in a few yaws, so other blanks are sent as zero."""
    p = item.get("p", [0, 0, 0, 0])
    if not isinstance(p, list) or len(p) != 4:
        raise BadPlan(f"{where}: p")
    out = []
    for index, value in enumerate(p):
        if value is None:
            out.append(math.nan if blank_yaw and index == 3 else 0.0)
        elif type(value) in (int, float) and math.isfinite(value):
            out.append(float(value))
        else:
            raise BadPlan(f"{where}: p")
    return out


def _place(item, where):
    return _finite(item, "lat", -90, 90, where), _finite(item, "lon", -180, 180, where)


def check_mission(items):
    """Waypoints in flight order, without home, with heights above home. Returns what to send, with a
    placeholder first: the flight controller keeps its own home in that slot and ignores what arrives there."""
    if not items:
        raise BadPlan("empty")
    out = [(NAV_WAYPOINT, RELATIVE_ALT, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.0])]
    for index, item in enumerate(items, 1):
        where = f"item {index}"
        if not isinstance(item, dict):
            raise BadPlan(where)
        command = item.get("cmd")
        if type(command) is not int or command not in MISSION_COMMANDS:
            raise BadPlan(f"{where}: cmd")
        lat, lon = 0.0, 0.0
        if command in NEEDS_PLACE or item.get("lat") is not None or item.get("lon") is not None:
            lat, lon = _place(item, where)
        if command in NEEDS_ALT:
            alt = float(_finite(item, "alt", MIN_ALT_M, MAX_ALT_M, where))
        elif item.get("alt") is not None:
            alt = float(_finite(item, "alt", 0, MAX_ALT_M, where))
        else:
            alt = 0.0
        # Heights above sea level or terrain would read as heights above home here.
        if command not in NO_PLACE_COMMANDS and item.get("frame", RELATIVE_ALT) not in RELATIVE_FRAMES:
            raise BadPlan(f"{where}: frame")
        p = _parameters(item, where, command in BLANK_YAW)
        if command == DO_JUMP and not (1 <= p[0] <= len(items) and p[0] == int(p[0])):
            raise BadPlan(f"{where}: jump")
        out.append((command, NO_PLACE if command in NO_PLACE_COMMANDS else RELATIVE_ALT, lat, lon, alt, p))
    return out


def check_fence(items):
    """Fence shapes as stored: polygon vertices in a run, each saying how many there are in its polygon."""
    if not items:
        raise BadPlan("empty")
    out = []
    index = 0
    returns = 0
    while index < len(items):
        item = items[index]
        where = f"item {index + 1}"
        if not isinstance(item, dict):
            raise BadPlan(where)
        command = item.get("cmd")
        lat, lon = _place(item, where)
        p = _parameters(item, where)
        if command in (FENCE_POLY_IN, FENCE_POLY_OUT):
            count = p[0]
            if not (count >= 3 and count == int(count) and index + int(count) <= len(items)):
                raise BadPlan(f"{where}: vertices")
            for offset in range(int(count)):
                vertex = items[index + offset]
                if not isinstance(vertex, dict) or vertex.get("cmd") != command or _parameters(vertex, where)[0] != count:
                    raise BadPlan(f"{where}: vertices")
                vlat, vlon = _place(vertex, where)
                out.append((command, L.MAV_FRAME_GLOBAL, vlat, vlon, 0.0, [count, 0.0, 0.0, 0.0]))
            index += int(count)
            continue
        if command in (FENCE_CIRCLE_IN, FENCE_CIRCLE_OUT):
            if not 0 < p[0] <= 100000:
                raise BadPlan(f"{where}: radius")
            out.append((command, L.MAV_FRAME_GLOBAL, lat, lon, 0.0, [p[0], 0.0, 0.0, 0.0]))
        elif command == FENCE_RETURN:
            returns += 1
            if returns > 1:
                raise BadPlan(f"{where}: return point")
            out.append((command, L.MAV_FRAME_GLOBAL, lat, lon, 0.0, [0.0, 0.0, 0.0, 0.0]))
        else:
            raise BadPlan(f"{where}: cmd")
        index += 1
    return out


def check_rally(items):
    if not items:
        raise BadPlan("empty")
    out = []
    for index, item in enumerate(items, 1):
        where = f"item {index}"
        if not isinstance(item, dict):
            raise BadPlan(where)
        lat, lon = _place(item, where)
        alt = float(_finite(item, "alt", MIN_ALT_M, MAX_ALT_M, where))
        out.append((RALLY_POINT, RELATIVE_ALT, lat, lon, alt, [0.0, 0.0, 0.0, 0.0]))
    return out


CHECKS = {"mission": check_mission, "fence": check_fence, "rally": check_rally}


def check(kind, items):
    """Raises BadPlan unless these items can be written. Returns them ready to send."""
    if not isinstance(items, list):
        raise BadPlan("items")
    if len(items) > MAX_ITEMS - 1:
        raise BadPlan("too many")
    return CHECKS[kind](items)


def same_plan(kind, prepared, stored):
    """Whether what the flight controller now holds is what was sent. The first mission slot is home."""
    if len(prepared) != len(stored):
        return False
    start = 1 if kind == "mission" else 0
    for sent, got in list(zip(prepared, stored))[start:]:
        command, _, lat, lon, alt, _ = sent
        if command != got["cmd"]:
            return False
        if abs((got["lat"] or 0.0) - lat) > 2e-7 or abs((got["lon"] or 0.0) - lon) > 2e-7:
            return False
        if (command in NEEDS_ALT or kind == "rally") and abs((got["alt"] or 0.0) - alt) > .02:
            return False
    return True


class PlanLink:
    """One transfer at a time over the present connection to the flight controller."""

    def __init__(self, link):
        self.link = link        # gives .mav and .target
        self.lock = asyncio.Lock()
        self.inbox = None       # what the flight controller said, while a transfer is running

    # --- from the flight controller -----------------------------------------

    def _post(self, m, what, value):
        if self.inbox is not None and m.target_system == SYSID and m.target_component in (COMPID, 0):
            self.inbox.put_nowait((what, m.mission_type, value))

    def on_count(self, m):
        self._post(m, "count", m.count)

    def on_item(self, m):
        self._post(m, "item", m)

    def on_request(self, m):
        self._post(m, "request", m.seq)

    def on_ack(self, m):
        self._post(m, "ack", m.type)

    # --- to the flight controller -------------------------------------------

    def _mav(self):
        if self.link.mav is None or self.link.target is None:
            raise Lost()
        return self.link.mav

    async def _next(self, code, accept, timeout):
        """The next thing said about this plan that `accept` wants, or None after that long."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while (left := deadline - loop.time()) > 0:
            try:
                what, kind, value = await asyncio.wait_for(self.inbox.get(), left)
            except TimeoutError:
                return None
            if kind == code and accept(what, value):
                return what, value
        return None

    async def _ask(self, send, code, wanted, timeout):
        """Sends a request, again if nothing comes back. A refusal raises Refused, silence raises Lost."""
        def accept(what, value):
            return wanted(what, value) or (what == "ack" and value != L.MAV_MISSION_ACCEPTED)
        for _ in range(TRIES):
            send(self._mav())
            answer = await self._next(code, accept, timeout)
            if answer is None:
                continue
            what, value = answer
            if what == "ack":
                raise Refused(value)
            return value
        raise Lost()

    async def read(self, kind):
        """The stored items in order. Asks again for anything that goes missing."""
        code = KINDS[kind]
        async with self.lock:
            self.inbox = asyncio.Queue()
            try:
                target = self.link.target
                count = await self._ask(lambda mav: mav.mission_request_list_send(*target, code),
                                        code, lambda what, _: what == "count", COUNT_TIMEOUT_S)
                items = []
                for seq in range(min(count, MAX_ITEMS)):
                    message = await self._ask(lambda mav, seq=seq: mav.mission_request_int_send(*target, seq, code),
                                              code, lambda what, value, seq=seq: what == "item" and value.seq == seq,
                                              ITEM_TIMEOUT_S)
                    items.append(from_message(message))
                self._mav().mission_ack_send(*target, L.MAV_MISSION_ACCEPTED, code)
                return items
            finally:
                self.inbox = None

    # --- writing and clearing, only ever by a command ------------------------

    async def write(self, kind, prepared):
        """Sends a checked plan. Returns the MAV_MISSION_RESULT, or None if the flight controller went
        silent. It overwrites a stored mission as the items arrive, so an interrupted upload can leave
        part of the new plan behind: whoever calls this reads the plan back afterwards."""
        code = KINDS[kind]
        async with self.lock:
            self.inbox = asyncio.Queue()
            try:
                target = self.link.target
                self._mav().mission_count_send(*target, len(prepared), code)
                while True:
                    answer = await self._next(code, lambda what, _: what in ("request", "ack"), UPLOAD_TIMEOUT_S)
                    if answer is None:
                        self._mav().mission_ack_send(*target, L.MAV_MISSION_OPERATION_CANCELLED, code)
                        return None
                    what, value = answer
                    if what == "ack":
                        return value
                    if not 0 <= value < len(prepared):
                        return L.MAV_MISSION_INVALID_SEQUENCE
                    command, frame, lat, lon, alt, p = prepared[value]
                    self._mav().mission_item_int_send(*target, value, frame, command, 0, 1, *p, int(round(lat * 1e7)),
                                                      int(round(lon * 1e7)), float(alt), code)
            except Lost:
                return None
            finally:
                self.inbox = None

    async def clear(self, kind):
        code = KINDS[kind]
        async with self.lock:
            self.inbox = asyncio.Queue()
            try:
                self._mav().mission_clear_all_send(*self.link.target, code)
                answer = await self._next(code, lambda what, _: what == "ack", COUNT_TIMEOUT_S * 2)
                return answer[1] if answer else None
            except Lost:
                return None
            finally:
                self.inbox = None


class PlanStore:
    """Keeps a copy of the three plans for the page, without getting in anyone's way."""

    REFRESH_S = 120         # while disarmed, a ground station may have changed them
    PER_ITEM_S = .5         # a long plan is read less often, so it never takes a noticeable share of the link
    RETRY_S = 15
    START_S = 4             # leaves the first moments of a connection to the readings on the main view
    STEP_S = 1

    def __init__(self, telemetry):
        self.t = telemetry
        self.link = PlanLink(telemetry)
        self.reset()

    def reset(self):
        self.entries = {kind: {"items": [], "at": None, "err": None} for kind in KINDS}
        self.read_at = {kind: None for kind in KINDS}
        self.tried_at = {kind: float("-inf") for kind in KINDS}
        self.dirty = set(KINDS)
        self.reading = None

    def forget(self):
        """Nobody is watching. What was read stays on show, and is read again when somebody is."""
        self.read_at = {kind: None for kind in KINDS}
        self.tried_at = {kind: float("-inf") for kind in KINDS}
        self.dirty = set(KINDS)
        self.reading = None

    def mark_dirty(self, *kinds):
        self.dirty.update(kinds or KINDS)
        for kind in kinds or KINDS:
            self.tried_at[kind] = float("-inf")

    def publish(self):
        self.t.publish("plan", {kind: dict(entry) for kind, entry in self.entries.items()})
        self.t.publish("plan_busy", self.reading)

    def _due(self, kind, now):
        entry = self.entries[kind]
        if now - self.tried_at[kind] < (self.RETRY_S if entry["err"] else self.STEP_S):
            return False
        if kind in self.dirty or self.read_at[kind] is None:
            return True
        if self.t.armed():
            return False    # read once already, and a plan does not change by itself in flight
        return now - self.read_at[kind] >= self.REFRESH_S + len(entry["items"]) * self.PER_ITEM_S

    async def read(self, kind):
        """Reads one plan and publishes it. A failure keeps what was known, and says so."""
        self.tried_at[kind] = time.monotonic()
        self.dirty.discard(kind)
        self.reading = kind
        self.publish()
        entry = self.entries[kind]
        try:
            entry["items"] = await self.link.read(kind)
            entry["at"] = round(time.time())
            entry["err"] = None
            self.read_at[kind] = time.monotonic()
            return True
        except Refused:
            entry["err"] = "denied"     # usually a ground station uploading just now
        except Lost:
            entry["err"] = "no_reply"
        finally:
            self.reading = None
            self.publish()
        self.dirty.add(kind)
        return False

    async def run(self):
        await asyncio.sleep(self.START_S)
        while True:
            await asyncio.sleep(self.STEP_S)
            if not self.t.fresh() or not self.t.viewers or self.t.link_busy():
                continue
            now = time.monotonic()
            for kind in KINDS:
                if self._due(kind, now):
                    await self.read(kind)
                    break

    def count(self, kind):
        return len(self.entries[kind]["items"])

    def waypoints(self):
        """Stored mission items, not counting home in its first slot."""
        return max(self.count("mission") - 1, 0)
