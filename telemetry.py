"""Reads MAVLink from mavlink-router and keeps the state the dashboard shows.

Designed to stay out of the way of everything else on the link:

- It connects only while someone is watching, so with no viewer it uses no CPU
  and adds no traffic.
- It sends no heartbeat and uses its own system ID, so it is never mistaken for
  the ground station that failsafes depend on.
- It never changes stream rates. If a message is not arriving by itself (no
  ground station has asked for it) it fetches a single copy with
  MAV_CMD_REQUEST_MESSAGE, at a capped rate, and stops when the page closes.
  REQUEST_DATA_STREAM and SET_MESSAGE_INTERVAL are avoided because they change
  what everyone on the link receives, and that outlasts this connection.
"""
import asyncio
import collections
import logging
import math
import time

import plans
from wire import COMPID, L, SYSID

log = logging.getLogger("dronestats")

GRACE_S = 15            # keep the link this long after the last viewer leaves
HB_STALE_S = 3          # no heartbeat for this long means the link is down
POLL_STEP_S = 0.1       # at most one request per step, so 10 per second
BUSY_FRACTION = 0.7     # stop fetching when the link is this full
PREARM_PERIOD_S = 60    # the reasons are only sent on request while ARMING_OPTIONS=1
PREARM_MIN_GAP_S = 5
TARGET_RELOCK_S = 10    # stay with the first flight controller unless it goes silent
SAMPLE_S = 2            # one history sample this often, while someone is watching
HISTORY_S = 1800        # how much history to keep for charts and the battery forecast
RATES_S = 5             # how often to report message rates
LOG_LIST_REUSE_S = 20
# How long a value may go unrefreshed before it stops counting as current: long enough for one
# lost fetch at the slowest rate in POLLED below.
VALUE_LIMIT_S = {"ATTITUDE": 5, "GLOBAL_POSITION_INT": 5, "VFR_HUD": 5, "SYS_STATUS": 5,
                 "GPS_RAW_INT": 8, "EKF_STATUS_REPORT": 15, "VIBRATION": 15}
SEQUENCE_SILENCE_S = 2
PARAM_RETRY_S = 2
PARAM_TRIES = 3
TARGET_LIMIT_S = 5      # with no word of a target for this long, it has none
FENCE_LIMIT_S = 30

# message, ID, seconds between fetches while disarmed (None: not while disarmed), and while armed
POLLED = (
    ("ATTITUDE", L.MAVLINK_MSG_ID_ATTITUDE, 0.5, 0.25),
    ("GLOBAL_POSITION_INT", L.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 1, 0.5),
    ("VFR_HUD", L.MAVLINK_MSG_ID_VFR_HUD, 1, 0.5),
    ("SYS_STATUS", L.MAVLINK_MSG_ID_SYS_STATUS, 1, 1),
    ("SERVO_OUTPUT_RAW", L.MAVLINK_MSG_ID_SERVO_OUTPUT_RAW, 5, 0.5),
    ("EXTENDED_SYS_STATE", L.MAVLINK_MSG_ID_EXTENDED_SYS_STATE, 2, 1),
    ("GPS_RAW_INT", L.MAVLINK_MSG_ID_GPS_RAW_INT, 2, 1),
    ("NAV_CONTROLLER_OUTPUT", L.MAVLINK_MSG_ID_NAV_CONTROLLER_OUTPUT, None, 1),
    ("POSITION_TARGET_GLOBAL_INT", L.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT, None, 1),
    ("MISSION_CURRENT", L.MAVLINK_MSG_ID_MISSION_CURRENT, 10, 2),
    ("RC_CHANNELS", L.MAVLINK_MSG_ID_RC_CHANNELS, 2, 2),
    ("EKF_STATUS_REPORT", L.MAVLINK_MSG_ID_EKF_STATUS_REPORT, 5, 2),
    ("VIBRATION", L.MAVLINK_MSG_ID_VIBRATION, 5, 2),
    ("BATTERY_STATUS", L.MAVLINK_MSG_ID_BATTERY_STATUS, 5, 2),
    ("FENCE_STATUS", L.MAVLINK_MSG_ID_FENCE_STATUS, 10, 2),
    ("HOME_POSITION", L.MAVLINK_MSG_ID_HOME_POSITION, 10, 5),
    ("SCALED_PRESSURE", L.MAVLINK_MSG_ID_SCALED_PRESSURE, 5, 5),
    ("POWER_STATUS", L.MAVLINK_MSG_ID_POWER_STATUS, 10, 10),
    ("RAW_IMU", L.MAVLINK_MSG_ID_RAW_IMU, 10, 10),
    ("MEMINFO", L.MAVLINK_MSG_ID_MEMINFO, 10, 10),
    ("SYSTEM_TIME", L.MAVLINK_MSG_ID_SYSTEM_TIME, 10, 10),
    ("AUTOPILOT_VERSION", L.MAVLINK_MSG_ID_AUTOPILOT_VERSION, 30, 30),
)

MOTOR_FUNCTIONS = {33: 0, 34: 1, 35: 2, 36: 3}   # SERVOn_FUNCTION value -> motor index
WANTED_PARAMS = (
    "BATT_ARM_VOLT", "BATT_LOW_VOLT", "BATT_CRT_VOLT", "GPS_HDOP_GOOD",
    "FRAME_CLASS", "FRAME_TYPE", "FS_THR_ENABLE",
    "FENCE_ENABLE", "FENCE_TYPE", "FENCE_ACTION", "FENCE_ALT_MAX", "FENCE_RADIUS",
    "RTL_ALT_M", "RTL_SPEED_MS", "WP_SPD", "WP_SPD_UP", "WP_SPD_DN", "LAND_SPD_MS",
    "BATT_CAPACITY", "STAT_BOOTCNT", "STAT_FLTTIME", "STAT_RUNTIME", "RCMAP_THROTTLE",
    # What the page needs to draw the way a command would go.
    "RTL_LOIT_TIME", "RTL_CONE_SLOPE", "RTL_CLIMB_MIN_M", "RTL_ALT_FINAL_M", "LAND_SPD_HIGH_MS", "LAND_ALT_LOW_M",
    "RALLY_LIMIT_KM", "RALLY_INCL_HOME",
) + tuple("SERVO%d_FUNCTION" % n for n in range(1, 13))

class _Sink:
    """Lets pymavlink's *_send helpers write to an asyncio stream."""

    def __init__(self, writer):
        self.writer = writer

    def write(self, data):
        self.writer.write(bytes(data))


def _num(value, places):
    """Rounded, or None for NaN and infinity, which JSON cannot carry."""
    value = float(value)
    return round(value, places) if math.isfinite(value) else None


class Telemetry:
    def __init__(self, host, port, baud=57600, cells=2):
        self.host, self.port = host, port
        self.bytes_per_s_full = baud / 10
        self.viewers = 0
        self.watching = asyncio.Event()
        self.last_viewer_at = 0.0
        self.state = {"link": "connecting", "age": None, "cells": cells, "exec": None}
        self.dirty = set(self.state)
        self.messages = collections.deque(maxlen=200)
        self.new_messages = []
        # Kept across links: [time, volts, altitude, speed, climb, hdop, satellites, vibration,
        # link load, armed, in the air, latitude, longitude, Wi-Fi signal]. A gap in time means
        # nobody was watching.
        self.history = collections.deque(maxlen=HISTORY_S // SAMPLE_S)
        self.new_samples = []
        self._listeners = []
        self.plans = plans.PlanStore(self)
        self._new_link()

    # --- viewers ------------------------------------------------------------

    def viewer_joined(self):
        self.viewers += 1
        self.watching.set()
        self._prearm_due = True

    def viewer_left(self):
        self.viewers -= 1
        self.last_viewer_at = time.monotonic()

    # --- state --------------------------------------------------------------

    def publish(self, key, value):
        if self.state.get(key) != value:
            self.state[key] = value
            self.dirty.add(key)

    _set = publish

    def _forget_vehicle(self):
        """Nobody is watching any more, so what we knew will be out of date next time."""
        # A stored plan and the viewers' marks do not go out of date by being unwatched: the next viewer
        # sees them at once, with when they were read, and the plan is read again as soon as there is a link.
        kept = {key: self.state[key] for key in ("plan", "marks", "sim") if key in self.state}
        self.state = {"link": "idle", "age": None, "cells": self.state["cells"], "exec": None, **kept}
        self.dirty = set()
        self.plans.forget()

    def take_changes(self):
        """Returns what changed since the last call, or None."""
        if not self.dirty:
            return None
        changes = {key: self.state[key] for key in self.dirty}
        self.dirty.clear()
        return changes

    def take_new_messages(self):
        fresh, self.new_messages = self.new_messages, []
        return fresh

    def take_new_samples(self):
        fresh, self.new_samples = self.new_samples, []
        return fresh

    def fresh(self):
        return self.target is not None and time.monotonic() - self.last_hb < HB_STALE_S

    def armed(self):
        return bool(self.state.get("armed"))

    def age(self, kind):
        """Seconds since this message last arrived, however it came."""
        return time.monotonic() - self.seen.get(kind, float("-inf"))

    def link_busy(self):
        """For example a log download: leave the link alone."""
        return self._rx_rate > self.bytes_per_s_full * BUSY_FRACTION

    # --- commands -----------------------------------------------------------

    async def _acknowledged(self, command, send, timeout):
        future = asyncio.get_running_loop().create_future()
        self.acks[command] = future
        send()
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            return None
        finally:
            if self.acks.get(command) is future:
                del self.acks[command]

    async def command(self, command, *params, timeout=3.0):
        """Sends COMMAND_LONG once. Returns the MAV_RESULT, or None with no reply."""
        args = (tuple(float(p) for p in params) + (0.0,) * 7)[:7]
        return await self._acknowledged(command, lambda: self.mav.command_long_send(*self.target, command, 0, *args), timeout)

    async def command_at(self, command, lat, lon, alt, *params, frame=L.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, timeout=3.0):
        """Sends COMMAND_INT once, for a command that names a place. Returns as command() does."""
        args = (tuple(float(p) for p in params) + (0.0,) * 4)[:4]
        return await self._acknowledged(command, lambda: self.mav.command_int_send(
            *self.target, frame, command, 0, 0, *args, int(round(lat * 1e7)), int(round(lon * 1e7)), float(alt)), timeout)

    async def set_param(self, name, value, timeout=3.0):
        """Writes one setting. The flight controller answers with what it now holds, and that is
        returned, or None with no answer."""
        asked = time.monotonic()
        self.mav.param_set_send(*self.target, name.encode(), float(value), L.MAV_PARAM_TYPE_REAL32)
        while time.monotonic() - asked < timeout:
            heard = self._param_heard.get(name)
            if heard and heard[0] >= asked:
                return heard[1]
            await asyncio.sleep(.05)
        return None

    def ask_for(self, msg_id):
        """Fetches one copy of a message now, rather than at its next turn."""
        self.mav.command_long_send(*self.target, L.MAV_CMD_REQUEST_MESSAGE, 0, msg_id, 0, 0, 0, 0, 0, 0)

    def listen(self):
        """What the flight controller says from now on, which is how it explains a refusal."""
        heard = []
        self._listeners.append(heard)
        return heard

    def stop_listening(self, heard):
        self._listeners.remove(heard)

    def say_to_listeners(self, text):
        """Something this service has to add to what the flight controller said."""
        for heard in self._listeners:
            heard.append(text)

    async def confirmed_on_ground(self, wait=1.5):
        """True only if the flight controller says so now. Asks for a new report and
        refuses without one: no evidence must never read as being on the ground."""
        asked = time.monotonic()
        self.mav.command_long_send(*self.target, L.MAV_CMD_REQUEST_MESSAGE, 0,
                                   L.MAVLINK_MSG_ID_EXTENDED_SYS_STATE, 0, 0, 0, 0, 0, 0)
        while time.monotonic() - asked < wait:
            if self.seen.get("EXTENDED_SYS_STATE", 0) >= asked:
                return self.state.get("landed") == L.MAV_LANDED_STATE_ON_GROUND
            await asyncio.sleep(0.05)
        return False

    async def list_logs(self, wait=4.0):
        """Asks the flight controller which logs it holds. Sends no LOG_REQUEST_END: the list
        finishes by itself, and that message would cancel a download a ground station is running.
        Returns None if it cannot ask now. A recent answer is reused, since a long list fills the link."""
        now = time.monotonic()
        if self._logs_known and now - self._logs_known[0] < LOG_LIST_REUSE_S:
            return self._logs_known[1]
        if self._log_entries is not None or self._rx_rate > self.bytes_per_s_full * BUSY_FRACTION:
            return None     # already asking, or the link is full, for example with a log download
        entries = self._log_entries = {}
        self._log_total = None
        self.mav.log_request_list_send(*self.target, 0, 0xFFFF)
        deadline = now + wait
        while time.monotonic() < deadline and self._log_entries is entries:
            if self._log_total is not None and len(entries) >= self._log_total:
                break
            await asyncio.sleep(0.05)
        if self._log_entries is not entries or self._log_total is None:
            self._log_entries = None
            return None     # no answer, or the link was replaced while waiting
        self._log_entries = None
        logs = sorted(entries.values(), key=lambda e: e[0])
        self._logs_known = (time.monotonic(), logs)
        return logs

    def request_prearm_check(self):
        """Asks the flight controller to report why it cannot arm. Changes nothing."""
        now = time.monotonic()
        if not self.fresh() or self.armed() or now - self._prearm_at < PREARM_MIN_GAP_S:
            return False
        self._prearm_at = now
        self.mav.command_long_send(*self.target, L.MAV_CMD_RUN_PREARM_CHECKS, 0, 0, 0, 0, 0, 0, 0, 0)
        return True

    # --- link ---------------------------------------------------------------

    def _new_link(self):
        self.mav = None
        self.target = None
        self._target_at = 0.0
        self.last_hb = 0.0
        self.seen = {}
        self.asked = {}
        self.acks = {}
        self.params = {}
        self._param_asked = {}
        self._param_tries = {}
        self._param_heard = {}
        self.plans.mark_dirty()
        self._turn = 0
        self._outputs = {}
        self._last_boot_ms = None
        self._prearm_at = 0.0
        self._prearm_due = True
        self._prearm_burst_at = 0.0
        self._gcs_seen_at = None
        self._rx_window = collections.deque()
        self._rx_bytes = 0
        self._rx_rate = 0.0
        self._msg_counts = collections.Counter()
        self._log_entries = None
        self._log_total = None
        self._logs_known = None
        self._asked_at = None
        self._rtt = None
        self._last_seq = None
        self._seq_at = 0.0
        self._seq_got = 0
        self._seq_lost = 0

    def _set_link(self, value):
        self._set("link", value)

    async def run(self):
        while True:
            await self.watching.wait()
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port)
            except OSError:
                self._set_link("no_router")
                await asyncio.sleep(2)
                self._drop_watch_if_idle()
                continue
            try:
                await self._serve_link(reader, writer)
            except Exception:
                log.exception("MAVLink link failed")
            await asyncio.sleep(1)      # never spin against a port that closes at once
            self._drop_watch_if_idle()

    def _drop_watch_if_idle(self):
        if self.viewers == 0 and time.monotonic() - self.last_viewer_at >= GRACE_S:
            self.watching.clear()

    async def _serve_link(self, reader, writer):
        self._new_link()
        self.mav = L.MAVLink(_Sink(writer), srcSystem=SYSID, srcComponent=COMPID)
        self.mav.robust_parsing = True
        self._set_link("no_fc")
        fetcher = asyncio.create_task(self._fetch_loop())
        ticker = asyncio.create_task(self._second_loop(writer))
        reader_of_plans = asyncio.create_task(self.plans.run())
        try:
            while data := await reader.read(4096):
                self._count_rx(len(data))
                for msg in self.mav.parse_buffer(data) or ():
                    self._on_message(msg)
        except ConnectionError:
            pass
        finally:
            fetcher.cancel()
            ticker.cancel()
            reader_of_plans.cancel()
            writer.close()
            self.last_hb = 0.0          # no command may be accepted over a closed link
            if self.viewers:
                self._set_link("connecting")
                self._set("age", None)
            else:
                self._forget_vehicle()

    def _count_rx(self, count):
        self._rx_window.append((time.monotonic(), count))
        self._rx_bytes += count

    async def _second_loop(self, writer):
        """Slow housekeeping: link age and rate, history, and leaving when nobody watches."""
        tick = 0
        while True:
            await asyncio.sleep(1)
            tick += 1
            now = time.monotonic()
            if self.viewers == 0 and now - self.last_viewer_at >= GRACE_S:
                writer.close()      # ends the read loop
                return
            while self._rx_window and now - self._rx_window[0][0] > 2:
                self._rx_bytes -= self._rx_window.popleft()[1]
            self._rx_rate = self._rx_bytes / 2
            if self.target is None:
                continue
            age = now - self.last_hb
            self._set("age", _num(age, 0))
            self._set_link("ok" if age < HB_STALE_S else "stale")
            self._set("rx", [round(self._rx_rate), round(self._rx_rate / self.bytes_per_s_full, 2)])
            self._set("old", [kind for kind in VALUE_LIMIT_S if not self._recent(kind, now)])
            if self.age("POSITION_TARGET_GLOBAL_INT") > TARGET_LIMIT_S:
                self._set("target", None)
            if self.age("FENCE_STATUS") > FENCE_LIMIT_S:
                self._set("fence", None)        # it only reports while the fence is on
            if tick % SAMPLE_S == 0 and age < HB_STALE_S:
                self._sample()
            if tick % RATES_S == 0:
                rates = sorted(self._msg_counts.items(), key=lambda kv: -kv[1])
                self._set("rates", [[kind, _num(count / RATES_S, 1)] for kind, count in rates])
                self._msg_counts.clear()
                total = self._seq_got + self._seq_lost
                self._set("loss", _num(100 * self._seq_lost / total, 1) if total else None)
                self._seq_got = self._seq_lost = 0

    def _recent(self, kind, now=None):
        """Whether a value is current. One not seen yet counts from when the vehicle appeared."""
        return (now or time.monotonic()) - self.seen.get(kind, self._target_at) < VALUE_LIMIT_S[kind]

    def _sample(self):
        s = self.state
        # A value that has stopped updating is a gap in the record, not a steady reading.
        pos = s.get("pos") if self._recent("GLOBAL_POSITION_INT") else None
        hud = s.get("hud") if self._recent("VFR_HUD") else None
        gps = (s.get("gps") or {}) if self._recent("GPS_RAW_INT") else {}
        volts = s.get("volts") if self._recent("SYS_STATUS") else None
        vib = s.get("vib") if self._recent("VIBRATION") else None
        shake = [v for v in vib["xyz"] if v is not None] if vib else []
        in_air = s.get("landed") in (L.MAV_LANDED_STATE_IN_AIR, L.MAV_LANDED_STATE_TAKEOFF, L.MAV_LANDED_STATE_LANDING)
        fix = pos is not None and pos[0] is not None
        sample = [round(time.time()), volts, pos[3] if pos else None, hud[0] if hud else None,
                  hud[1] if hud else None, gps.get("hdop"), gps.get("sats"), max(shake) if shake else None,
                  (s.get("rx") or [0, 0])[1], 1 if s.get("armed") else 0, 1 if in_air else 0,
                  round(pos[0], 6) if fix else None, round(pos[1], 6) if fix else None,
                  (s.get("wifi") or {}).get("dbm")]
        self.history.append(sample)
        self.new_samples.append(sample)

    async def _fetch_loop(self):
        """Fetches single copies of whatever is not already arriving, slowly."""
        while True:
            await asyncio.sleep(POLL_STEP_S)
            if not self.fresh() or self.viewers == 0:
                continue
            now = time.monotonic()
            if self.link_busy():
                continue
            self._turn += 1
            if self._turn % 2 and self._ask_next_param(now):
                continue    # alternate, so startup reads never hold up the display
            self._maybe_check_prearm(now)
            armed = self.armed()
            for name, msg_id, idle_s, armed_s in POLLED:
                period = armed_s if armed else idle_s
                if period is None or (name == "AUTOPILOT_VERSION" and "fw" in self.state):
                    continue
                if now - self.seen.get(name, 0) < period * 1.6:
                    continue    # arriving by itself, or a fetch just answered
                if now - self.asked.get(name, 0) < period:
                    continue
                self.asked[name] = now
                self._asked_at = now
                self.mav.command_long_send(*self.target, L.MAV_CMD_REQUEST_MESSAGE, 0,
                                           msg_id, 0, 0, 0, 0, 0, 0)
                break

    def _ask_next_param(self, now):
        for name in WANTED_PARAMS:
            tries = self._param_tries.get(name, 0)
            if name in self.params or tries >= PARAM_TRIES:
                continue
            if now - self._param_asked.get(name, 0) < PARAM_RETRY_S:
                continue
            self._param_asked[name] = now
            self._param_tries[name] = tries + 1
            self.mav.param_request_read_send(*self.target, name.encode(), -1)
            return True
        return False

    def _maybe_check_prearm(self, now):
        sens = self.state.get("sens")
        if not sens or self.armed() or sens[2] & L.MAV_SYS_STATUS_PREARM_CHECK:
            return
        if (self._prearm_due or now - self._prearm_at >= PREARM_PERIOD_S) and self.request_prearm_check():
            self._prearm_due = False

    # --- messages -----------------------------------------------------------

    def _on_message(self, msg):
        kind = msg.get_type()
        if kind == "BAD_DATA":
            return
        source = (msg.get_srcSystem(), msg.get_srcComponent())
        if source == self.target:
            self._count_sequence(msg.get_seq())
        if kind == "HEARTBEAT":
            self._on_heartbeat(msg, source)
            return
        if source != self.target:
            return
        self.seen[kind] = time.monotonic()
        self._msg_counts[kind] += 1
        handler = getattr(self, "_on_" + kind.lower(), None)
        if handler:
            handler(msg)

    def _count_sequence(self, seq):
        """Each message carries a counter, so a gap shows what the serial link lost. After a
        silence the counter says nothing: the flight controller may have restarted. A counter
        that went backwards is a repeat, not most of the counter's range lost."""
        now = time.monotonic()
        if self._last_seq is not None and now - self._seq_at < SEQUENCE_SILENCE_S:
            gap = (seq - self._last_seq - 1) & 255
            if gap < 128:
                self._seq_lost += gap
        self._last_seq = seq
        self._seq_at = now
        self._seq_got += 1

    def _on_heartbeat(self, m, source):
        now = time.monotonic()
        if m.type == L.MAV_TYPE_GCS:
            self._gcs_seen_at = now
            return
        # Only the autopilot of one vehicle counts: a companion computer's heartbeat
        # must never redirect commands or stand in for the flight controller's.
        if m.autopilot == L.MAV_AUTOPILOT_INVALID or source[1] != L.MAV_COMP_ID_AUTOPILOT1:
            return
        if self.target not in (None, source) and now - self.last_hb < TARGET_RELOCK_S:
            return
        if self.target != source:
            self._target_at = now
        self.target = source
        self.last_hb = now
        self._set_link("ok")
        armed = bool(m.base_mode & L.MAV_MODE_FLAG_SAFETY_ARMED)
        if not armed:
            self._set("armed_at", None)
        elif self.state.get("armed") is False:
            self._set("armed_at", round(time.time()))      # only an arming we saw happen
        self._set("armed", armed)
        self._set("mode", m.custom_mode)
        self._set("vehicle", m.type)
        self._set("sys", m.system_status)
        self._set("gcs", self._gcs_seen_at is not None and now - self._gcs_seen_at < 5)

    def _check_reboot(self, boot_ms):
        if self._last_boot_ms is not None and boot_ms + 5000 < self._last_boot_ms:
            self.params.clear()
            self._param_asked.clear()
            self._param_tries.clear()
            self.plans.mark_dirty()
            self._set("home", None)
            self._set("prearm", None)
        self._last_boot_ms = boot_ms

    def _on_attitude(self, m):
        self._check_reboot(m.time_boot_ms)
        att = [_num(m.roll, 3), _num(m.pitch, 3), _num(m.yaw, 3),
               _num(m.rollspeed, 3), _num(m.pitchspeed, 3), _num(m.yawspeed, 3)]
        if None not in att:
            self._set("att", att)

    def _on_global_position_int(self, m):
        has_position = m.lat != 0 or m.lon != 0
        self._set("pos", [m.lat / 1e7 if has_position else None,
                          m.lon / 1e7 if has_position else None,
                          _num(m.alt / 1000, 2) if has_position else None,
                          _num(m.relative_alt / 1000, 2),
                          _num(m.vx / 100, 2), _num(m.vy / 100, 2), _num(m.vz / 100, 2),
                          _num(m.hdg / 100, 1) if m.hdg != 65535 else None])

    def _on_vfr_hud(self, m):
        self._set("hud", [_num(m.groundspeed, 1), _num(m.climb, 1), m.throttle, m.heading,
                          _num(m.alt, 1)])

    def _on_sys_status(self, m):
        if m.onboard_control_sensors_health & L.MAV_SYS_STATUS_PREARM_CHECK:
            self._set("prearm", None)       # the checks pass, so the old reasons no longer apply
        elif (self.state.get("sens") or (0, 0, 0))[2] & L.MAV_SYS_STATUS_PREARM_CHECK:
            self._prearm_due = True         # they just started failing: find out why
        self._set("sens", [m.onboard_control_sensors_present, m.onboard_control_sensors_enabled,
                           m.onboard_control_sensors_health])
        self._set("load", _num(m.load / 10, 0))
        self._set("volts", _num(m.voltage_battery / 1000, 2) if m.voltage_battery != 65535 else None)
        self._set("amps", _num(m.current_battery / 100, 1) if m.current_battery != -1 else None)

    def _on_gps_raw_int(self, m):
        self._set("gps", {"fix": m.fix_type, "sats": m.satellites_visible if m.satellites_visible != 255 else None,
                          "hdop": _num(m.eph / 100, 1) if m.eph != 65535 else None,
                          "hacc": _num(m.h_acc / 1000, 1) if m.h_acc else None,
                          "vacc": _num(m.v_acc / 1000, 1) if m.v_acc else None})

    def _on_servo_output_raw(self, m):
        if m.port != 0:
            return
        self._outputs = {n: getattr(m, "servo%d_raw" % n, 0) for n in range(1, 13)}
        self._publish_motors()

    def _publish_motors(self):
        motors = [None] * 4
        for n, raw in self._outputs.items():
            motor = MOTOR_FUNCTIONS.get(self.params.get("SERVO%d_FUNCTION" % n))
            if motor is not None:
                motors[motor] = max(0, min(100, round((raw - 1000) / 10))) if raw else None
        self._set("motors", motors)

    def _on_rc_channels(self, m):
        self._set("rc", {"count": m.chancount, "rssi": m.rssi if m.rssi != 255 else None,
                         "ch": [getattr(m, "chan%d_raw" % n) for n in range(1, 13)]})

    def _on_ekf_status_report(self, m):
        self._set("ekf", {"flags": m.flags, "vel": _num(m.velocity_variance, 2),
                          "posh": _num(m.pos_horiz_variance, 2), "posv": _num(m.pos_vert_variance, 2),
                          "mag": _num(m.compass_variance, 2)})

    def _on_vibration(self, m):
        self._set("vib", {"xyz": [_num(m.vibration_x, 1), _num(m.vibration_y, 1), _num(m.vibration_z, 1)],
                          "clip": m.clipping_0 + m.clipping_1 + m.clipping_2})

    def _on_scaled_pressure(self, m):
        baro = [_num(m.press_abs, 1), _num(m.temperature / 100, 1)]
        if None not in baro:
            self._set("baro", baro)

    def _on_raw_imu(self, m):
        if m.id == 0 and m.temperature:
            self._set("imu_t", _num(m.temperature / 100, 1))

    def _on_meminfo(self, m):
        self._set("mem", m.freemem32 or m.freemem)

    def _on_system_time(self, m):
        self._check_reboot(m.time_boot_ms)
        self._set("boot", m.time_boot_ms // 1000)

    def _on_extended_sys_state(self, m):
        self._set("landed", m.landed_state)

    def _on_home_position(self, m):
        self._set("home", [m.latitude / 1e7, m.longitude / 1e7, _num(m.altitude / 1000, 1)])

    def _on_mission_current(self, m):
        known = self.state.get("mission")
        if known and known[1] != m.total:
            self.plans.mark_dirty("mission")    # someone changed it, perhaps a ground station
        self._set("mission", [m.seq, m.total, m.mission_state, m.mission_mode])

    def _on_mission_count(self, m):
        self.plans.link.on_count(m)

    def _on_mission_item_int(self, m):
        self.plans.link.on_item(m)

    def _on_mission_request_int(self, m):
        self.plans.link.on_request(m)

    def _on_mission_request(self, m):
        self.plans.link.on_request(m)

    def _on_mission_ack(self, m):
        self.plans.link.on_ack(m)

    def _on_battery_status(self, m):
        if m.id != 0:
            return
        cells = [v / 1000 for v in m.voltages if v not in (0, 65535)]
        self._set("batt", {"mah": m.current_consumed if m.current_consumed >= 0 else None,
                           "pct": m.battery_remaining if m.battery_remaining >= 0 else None,
                           "temp": _num(m.temperature / 100, 1) if m.temperature != 32767 else None,
                           "cells": cells if len(cells) > 1 else None,
                           "state": m.charge_state})

    def _on_power_status(self, m):
        # Boards with no sensor for it say 0, which is not a reading.
        self._set("power", {"vcc": _num(m.Vcc / 1000, 2) if m.Vcc else None, "servo": _num(m.Vservo / 1000, 2) if m.Vservo else None,
                            "usb": bool(m.flags & L.MAV_POWER_STATUS_USB_CONNECTED)})

    def _on_fence_status(self, m):
        self._set("fence", {"breached": bool(m.breach_status), "count": m.breach_count, "type": m.breach_type})

    def _on_position_target_global_int(self, m):
        # Heights above sea level are converted on the page, which knows where home is.
        self._set("target", [m.lat_int / 1e7, m.lon_int / 1e7, _num(m.alt, 1), m.coordinate_frame])

    def _on_autopilot_version(self, m):
        v = m.flight_sw_version
        self._set("fw", [v >> 24 & 255, v >> 16 & 255, v >> 8 & 255])

    def _on_param_value(self, m):
        if m.param_id not in WANTED_PARAMS:
            return
        if not math.isfinite(m.param_value):
            return
        self.params[m.param_id] = m.param_value
        self._param_heard[m.param_id] = (time.monotonic(), m.param_value)
        if m.param_id.startswith("SERVO"):
            if self._outputs:
                self._publish_motors()
        else:
            self._set("params", {k: _num(v, 2) for k, v in self.params.items()
                                 if not k.startswith("SERVO")})

    def _on_log_entry(self, m):
        if self._log_entries is None:
            return
        self._log_total = m.num_logs
        if m.num_logs:
            self._log_entries[m.id] = [m.id, m.size, m.time_utc]

    def _on_terrain_report(self, m):
        self._set("terrain", [_num(m.terrain_height, 1), _num(m.current_height, 1)])

    def _on_nav_controller_output(self, m):
        self._set("nav", [m.wp_dist, m.target_bearing, _num(m.alt_error, 1), _num(m.xtrack_error, 1)])

    def _on_command_ack(self, m):
        if m.target_system != SYSID or m.target_component not in (COMPID, 0):
            return
        if m.command == L.MAV_CMD_REQUEST_MESSAGE and self._asked_at is not None:
            rtt = (time.monotonic() - self._asked_at) * 1000
            self._asked_at = None
            self._rtt = rtt if self._rtt is None else self._rtt * .8 + rtt * .2
            self._set("rtt", round(self._rtt))
        future = self.acks.get(m.command)
        if future and not future.done() and m.result != L.MAV_RESULT_IN_PROGRESS:
            future.set_result(m.result)

    def _on_statustext(self, m):
        text = m.text.rstrip("\x00").strip()
        item = [round(time.time()), m.severity, text]
        self.messages.append(item)
        self.new_messages.append(item)
        self.say_to_listeners(text)
        if text.startswith("PreArm:"):
            now = time.monotonic()
            reason = text[len("PreArm:"):].strip()
            current = self.state.get("prearm") or []
            if now - self._prearm_burst_at > 2:
                current = []
            self._prearm_burst_at = now
            if reason not in current:
                self._set("prearm", current + [reason])
