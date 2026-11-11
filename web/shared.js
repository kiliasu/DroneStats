// State and the facts derived from it, shared by the main view and the expanded pages.

import { STRINGS, MODES, SENSORS, PREARM_BIT, prearmText } from '/i18n.js';

export const $ = id => document.getElementById(id);

export function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  parent?.append(e);
  return e;
}

export const store = {
  S: {},                // everything the server has told us
  online: false,        // the connection to this server, not the aircraft
  lagging: false,       // connected, but the network is too slow to keep this page current
  latency: null,        // milliseconds from this page to the server and back, latest
  latencyLog: [],       // [time, milliseconds]
  messages: [],
  history: [],          // samples, one every 2 s, laid out as in H below
  carried: new Set(),   // values kept from before a reconnection, until the link brings new ones
  carriedSince: null,
  resumingUntil: 0,     // coming back to this page: for this long, reconnecting is not news
  trail: [],            // the flight path: [lat, lon, altitude, time], a point every metre or two
  trailVersion: 0,      // changes whenever the path does
  origin: null,         // the point the world's metres are measured from, fixed for this page's life
  lang: localStorage.getItem('lang') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'),
};

export const H = { TIME: 0, VOLTS: 1, ALT: 2, SPEED: 3, CLIMB: 4, HDOP: 5, SATS: 6, VIB: 7, LOAD: 8, ARMED: 9, AIR: 10, LAT: 11, LON: 12, WIFI: 13 };

export const t = (key, vars) => {
  let s = STRINGS[store.lang][key] ?? key;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  return s;
};
export const put = (el, text) => { if (el.textContent !== text) el.textContent = text; };
// A motor's output in percent: how near it is to leaving no room to steer. Parked, there is nothing to say.
export const motorTone = v => (v >= 90 ? 'bad' : v >= 75 ? 'warn' : '');
export const motorsInUse = S => !!S.motors && (!!S.armed || S.motors.some(v => v > 0));
// A reading that rounds to zero has no sign.
export const fixed = (v, n = 1) => {
  if (v == null) return '–';
  const text = v.toFixed(n);
  return Number(text) === 0 ? text.replace('-', '') : text.replace('-', '−');
};
export const signed = (v, n = 2) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(n)}`);
export const clock = s => {
  const two = n => String(Math.floor(n)).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(s / 60 % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
};
export const distance = m => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
export const joined = list => list.join(store.lang === 'zh' ? '、' : ', ');
// A limit's name on its own line, or inside a sentence. Only English needs the difference.
export const limitName = (key, inSentence = false) => {
  const s = t(key);
  if (store.lang !== 'en') return s;
  return (inSentence ? s[0].toLowerCase() : s[0].toUpperCase()) + s.slice(1);
};

// ---- Aircraft -----------------------------------------------------------------

export const live = () => store.online && !store.lagging && store.S.link === 'ok';
const KEY_OF_MESSAGE = { ATTITUDE: 'att', GLOBAL_POSITION_INT: 'pos', VFR_HUD: 'hud', SYS_STATUS: 'sens', GPS_RAW_INT: 'gps', EKF_STATUS_REPORT: 'ekf', VIBRATION: 'vib' };
export const isOld = kind => (store.S.old ?? []).includes(kind) || store.carried.has(KEY_OF_MESSAGE[kind]);
export const inAir = () => [2, 3, 4].includes(store.S.landed);
export const prearmOk = () => (store.S.sens ? !!(store.S.sens[2] & PREARM_BIT) : null);

export const sensorStates = () => {
  if (!store.S.sens) return [];
  const [present, enabled, health] = store.S.sens;
  return SENSORS.filter(([bit]) => present & bit).map(row => ({
    bit: row[0],
    name: row[store.lang === 'zh' ? 1 : 2],
    state: !(enabled & row[0]) ? 'off' : health & row[0] ? 'ok' : 'bad',
  }));
};
// Being outside the fence is reported as the fence sensor going unhealthy. It is not a fault in
// any sensor, so it is reported as what it is, on its own.
const faults = () => sensorStates().filter(s => s.state === 'bad' && s.bit !== FENCE_BIT);
export const sensorBad = () => faults().map(s => s.name);

export function statusText() {
  const S = store.S;
  let state, tone = '', mode = '', why = '', whyTone = '', timer = '';
  if (!live() && Date.now() < store.resumingUntil) {
    state = t('resuming'); tone = 'soft';
  } else if (!store.online) {
    state = t('serverLost'); tone = 'red-text';
  } else if (store.lagging) {
    state = t('lagging'); tone = 'red-text';
  } else if (S.link === 'no_router') {
    state = t('noRouter'); tone = 'red-text';
  } else if (S.link === 'no_fc') {
    state = t('noFc'); tone = 'amber';
  } else if (S.link === 'stale') {
    state = t('stale'); tone = 'red-text';
    why = t('staleFor', { n: S.age ?? '' });
  } else if (S.link !== 'ok') {
    state = t('connecting');
  } else {
    mode = MODES[store.lang][S.mode] ?? (S.mode == null ? '' : `#${S.mode}`);
    if (S.sys === 5) { state = t('critical'); tone = 'red-text'; }
    else if (S.sys === 6) { state = t('emergency'); tone = 'red-text'; }
    else if (S.armed && S.landed === 3) state = t('takeoff');
    else if (S.armed && S.landed === 4) state = t('landing');
    else if (S.armed && inAir()) state = t('flying');
    else if (S.armed) { state = t('armed'); tone = 'amber'; }
    else state = t('disarmed');
    if (S.armed) {
      if (S.armed_at) timer = clock(Math.max(0, Date.now() / 1000 - S.armed_at));
      const list = alerts();
      if (list.length) {
        why = list.length > 1 ? t('alsoN', { text: list[0].text, n: list.length - 1 }) : list[0].text;
        whyTone = list[0].tone;
      }
    } else {
      if (prearmOk() === true) why = t('canArm');
      else if (prearmOk() === false) {
        // Each reason on its own line, since each is its own thing to put right.
        why = [t('cannotArm'), ...(S.prearm || []).map(r => prearmText(store.lang, r))].join('\n');
        whyTone = 'amber';
      }
      if (S.old?.length) { why = t('valuesOld'); whyTone = 'amber'; }
    }
  }
  return { state, tone, mode, why, whyTone, timer };
}

// Modes that fly on position, in which losing it matters at once.
const NEEDS_POSITION = new Set([3, 4, 5, 6, 7, 16, 17, 21, 23, 27]);

// What needs attention while armed, the most pressing first.
export function alerts() {
  const S = store.S, out = [];
  if (!live() || !S.armed) return out;
  const add = (text, tone) => out.push({ text, tone });
  const rc = rcState();
  if (rc === 'lost') add(t('rcLostAlert'), 'red-text');
  const battery = batteryWarning();
  if (battery) add(battery.text, battery.tone);
  const nav = isOld('EKF_STATUS_REPORT') ? null : navSummary();
  if (nav?.tone === 'red-text') add(t('navBadAlert'), 'red-text');
  else if (nav?.tone === 'amber' && NEEDS_POSITION.has(S.mode)) add(t('navNoPosAlert'), 'amber');
  if (fenceState()?.tone === 'red-text') add(t('fenceBreachAlert'), 'red-text');
  const bad = faults().filter(s => !(rc === 'lost' && s.bit === RC_BIT)).map(s => s.name);
  if (bad.length) add(t('faults', { list: joined(bad) }), 'amber');
  if (!isOld('VIBRATION') && vibSummary()?.tone === 'red-text') add(t('vibAlert'), 'amber');
  if (S.loss >= LOSS_ALERT) add(t('lossAlert', { n: Math.round(S.loss) }), 'amber');
  if (S.old?.length) add(t('valuesOld'), 'amber');
  return out;
}

// ---- Connection ---------------------------------------------------------------

export const LOSS_ALERT = 5;
const LATENCY_FAIR = 300, LATENCY_POOR = 1000;
export const latencyTone = ms => (ms == null ? '' : ms >= LATENCY_POOR ? 'red-text' : ms >= LATENCY_FAIR ? 'amber' : '');

// How many of four bars, and how worried to be.
export function wifiLevel(dbm) {
  if (dbm == null) return { bars: 0, tone: '', word: null };
  if (dbm >= -60) return { bars: 4, tone: '', word: 'wifiStrong' };
  if (dbm >= -67) return { bars: 3, tone: '', word: 'wifiGood' };
  if (dbm >= -75) return { bars: 2, tone: '', word: 'wifiFair' };
  if (dbm >= -85) return { bars: 1, tone: 'amber', word: 'wifiWeak' };
  return { bars: 0, tone: 'red-text', word: 'wifiPoor' };
}

export function tailscalePath() {
  const peers = store.S.ts?.peers;
  if (!peers?.length) return null;
  const relayed = peers.find(p => !p[1]);
  return relayed ? { text: relayed[2] ? t('tsRelayVia', { r: relayed[2] }) : t('tsRelay'), tone: 'amber' } : { text: t('tsDirect'), tone: '' };
}

export function messageText(text) {
  if (text.startsWith('PreArm:')) {
    const reason = prearmText(store.lang, text.slice(7).trim());
    return store.lang === 'zh' ? `解锁检查：${reason}` : `Pre-arm: ${reason}`;
  }
  return text;
}
export const messageTone = severity => (severity <= 3 ? 'red-text' : severity === 4 ? 'amber' : '');
export const timeOf = when => new Date(when * 1000).toLocaleTimeString(store.lang === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false });

export function gpsSummary() {
  const g = store.S.gps;
  if (!g || g.fix < 2) return { text: t('noFix'), tone: 'amber' };
  if (g.fix === 2) return { text: t('fix2d'), tone: 'amber' };
  const good = hdopLimit();
  if (g.hdop == null || g.hdop > good * 2) return { text: t('fixPoor'), tone: 'amber' };
  if (g.hdop > good) return { text: t('fixFair'), tone: '' };
  return { text: t('fixGood'), tone: '' };
}
export const hdopLimit = () => (store.S.params?.GPS_HDOP_GOOD ?? 140) / 100;

// How far and which way a place is from the aircraft.
export function fromHere(place) {
  const S = store.S;
  if (!place || !S.pos || S.pos[0] == null) return null;
  const [lat, lon] = S.pos;
  const north = (place[0] - lat) * 111320;
  const east = (place[1] - lon) * 111320 * Math.cos(lat * Math.PI / 180);
  return { metres: Math.hypot(north, east), bearing: Math.atan2(east, north) };
}
export const fromHome = () => fromHere(store.S.home);

// The fence as the flight controller reports it: nothing if none is set up.
const FENCE_BIT = 0x100000;
export function fenceState() {
  const S = store.S;
  if (!S.sens) return null;
  const on = !!(S.sens[1] & FENCE_BIT);
  if (!on && !S.plan?.fence?.items?.length && !S.params?.FENCE_ENABLE) return null;
  if (on && (S.fence?.breached || !(S.sens[2] & FENCE_BIT))) return { on, text: t('fenceBreached'), tone: 'red-text' };
  return on ? { on, text: t('fenceOn'), tone: '' } : { on, text: t('fenceOff'), tone: 'soft' };
}

export const FENCE_ACTIONS = { 0: 'fenceActReport', 1: 'fenceActRtl', 2: 'fenceActLand', 3: 'fenceActSmart', 4: 'fenceActBrake', 5: 'fenceActSmartLand' };

// A height the flight controller gave with its frame, as a height above home, or null if unknown.
export function aboveHome(alt, frame) {
  if (frame === 3 || frame === 6) return alt;
  return store.S.home ? alt - store.S.home[2] : null;
}

// ArduPilot never resets the RC channel count when the signal is lost, so that count cannot show
// a loss. The RC_RECEIVER bit can: it appears once a receiver has been seen, and its health goes
// false in RC failsafe. With that failsafe off (FS_THR_ENABLE=0) it stays healthy whatever
// happens, so 'ok' needs the failsafe known to be on.
const RC_BIT = 0x10000;
export function rcState() {
  const sens = store.S.sens;
  if (!sens) return null;
  if (!(sens[0] & RC_BIT)) return 'none';
  if (!(sens[2] & RC_BIT)) return 'lost';
  const failsafe = store.S.params?.FS_THR_ENABLE;
  if (failsafe == null) return null;
  return failsafe ? 'ok' : 'unprotected';
}

export function navSummary() {
  const e = store.S.ekf;
  if (!e) return null;
  if (!(e.flags & 1)) return { text: t('navBad'), tone: 'red-text' };
  return e.flags & 0x10 ? { text: t('navOk'), tone: '' } : { text: t('navAttitude'), tone: 'amber' };
}

// ArduPilot's guidance: under 30 m/s/s is good, over 60 is a problem.
export const VIB_MID = 30;
export const VIB_HIGH = 60;
export function vibSummary() {
  const v = store.S.vib;
  if (!v) return null;
  const peak = Math.max(...v.xyz.map(x => x ?? 0));
  if (peak >= VIB_HIGH) return { text: t('vibHigh'), tone: 'red-text', peak };
  if (peak >= VIB_MID) return { text: t('vibMid'), tone: 'amber', peak };
  return { text: t('vibLow'), tone: '', peak };
}

// ---- History ------------------------------------------------------------------

export function series(field, seconds = Infinity) {
  const h = store.history;
  const out = [];
  if (!h.length) return out;
  const newest = h[h.length - 1][H.TIME];
  for (let i = h.length - 1; i >= 0 && newest - h[i][H.TIME] <= seconds; i--) {
    if (h[i][field] != null) out.push([h[i][H.TIME], h[i][field]]);
  }
  return out.reverse();
}

// The most recent armed stretch of the record, as [first, last] indices, or null if none.
export function lastFlight() {
  const h = store.history;
  let end = h.length - 1;
  while (end >= 0 && !h[end][H.ARMED]) end--;
  if (end < 0) return null;
  let i = end;
  while (i > 0 && h[i - 1][H.ARMED] && h[i][H.TIME] - h[i - 1][H.TIME] <= 30) i--;
  return [i, end];
}

// Summary of the most recent armed stretch, or null if none is on record.
export function flightStats() {
  const range = lastFlight();
  if (!range) return null;
  const h = store.history;
  const [start, end] = range;
  let top = null, fastest = null, travelled = 0;
  for (let i = end; i >= start; i--) {
    const s = h[i];
    if (s[H.ALT] != null) top = Math.max(top ?? s[H.ALT], s[H.ALT]);
    if (s[H.SPEED] != null) {
      fastest = Math.max(fastest ?? 0, s[H.SPEED]);
      if (i < end) travelled += s[H.SPEED] * (h[i + 1][H.TIME] - s[H.TIME]);
    }
  }
  const first = h[start], last = h[end];
  return {
    seconds: last[H.TIME] - first[H.TIME], top, fastest, travelled,
    drop: first[H.VOLTS] != null && last[H.VOLTS] != null ? first[H.VOLTS] - last[H.VOLTS] : null,
  };
}

// ---- Flight path ----------------------------------------------------------------

// Positions passed while armed, thinned to a point every metre or two so GPS noise at a hover
// does not pile up. The map draws it flat and the world draws it in three dimensions. It is
// rebuilt from the server's history, so it survives a reload, and live positions extend it.
const TRAIL_STEP_M = 1.5;
const TRAIL_CLIMB_M = 1;
const TRAIL_MAX = 600;
const M_PER_DEG = 111320;

function farEnough(from, lat, lon, alt) {
  const dn = (lat - from[0]) * M_PER_DEG;
  const de = (lon - from[1]) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
  return Math.hypot(dn, de) >= TRAIL_STEP_M || Math.abs((alt ?? 0) - (from[2] ?? 0)) >= TRAIL_CLIMB_M;
}

function addTrailPoint(lat, lon, alt, time) {
  const last = store.trail[store.trail.length - 1];
  if (last && !farEnough(last, lat, lon, alt)) return;
  store.trail.push([lat, lon, alt, time]);
  if (store.trail.length > TRAIL_MAX) {
    const half = store.trail.length >> 1;     // the older half loses every second point
    store.trail = store.trail.filter((_, i) => i >= half || i % 2 === 0);
  }
  store.trailVersion++;
}

export function resetTrail() {
  store.trail = [];
  store.trailVersion++;
}

// Adds the present position, while armed.
export function extendTrail() {
  const S = store.S;
  if (!S.armed || !S.pos || S.pos[0] == null) return;
  addTrailPoint(S.pos[0], S.pos[1], S.pos[3], Date.now() / 1000);
}

// The path of the latest flight on record, then the present position.
export function rebuildTrail() {
  resetTrail();
  const range = lastFlight();
  if (range) {
    const h = store.history;
    for (let i = range[0]; i <= range[1]; i++) {
      const s = h[i];
      if (s[H.LAT] != null) addTrailPoint(s[H.LAT], s[H.LON], s[H.ALT], s[H.TIME]);
    }
  }
  extendTrail();
}

// The world measures in metres from one point, chosen when a position is first known and
// then kept, so nothing on screen jumps when home is set later.
export function localFrame() {
  if (!store.origin) {
    const S = store.S;
    const stored = S.plan?.mission?.items?.find(item => item.lat != null) ?? S.plan?.fence?.items?.[0] ?? S.plan?.rally?.items?.[0];
    const at = S.home ?? (S.pos && S.pos[0] != null ? S.pos : store.trail[0]) ?? (stored ? [stored.lat, stored.lon] : null);
    if (!at) return null;
    store.origin = [at[0], at[1], Math.cos(at[0] * Math.PI / 180)];
  }
  return store.origin;
}

// [north, east] metres of a position from the origin.
export function toLocal(lat, lon) {
  const o = localFrame();
  return [(lat - o[0]) * M_PER_DEG, (lon - o[1]) * M_PER_DEG * o[2]];
}

// ---- Battery ------------------------------------------------------------------

// Reference points per LiPo cell: 3.80 V is about half charged and 3.50 V nearly flat. 3.67 V is a
// point to land at with some reserve left. Packs differ: these are starting points, not limits.
const HALF_CHARGE = 3.80;
const LAND_POINT = 3.67;
const NEARLY_FLAT = 3.50;
const CURVE_FLOOR = 3.30;   // the curve below says nothing useful under this

// The ones marked `forecast` are in the range the discharge curve can speak for. Arming voltage
// only matters on the ground, and the flight controller's low limits sit far below the knee.
export function batteryLimits() {
  const S = store.S;
  const p = S.params || {};
  const cells = S.cells || 2;
  const canForecast = v => v / cells >= CURVE_FLOOR;
  return [
    { key: 'halfCharge', v: HALF_CHARGE * cells, info: true },
    p.BATT_ARM_VOLT && { key: 'armVoltage', v: p.BATT_ARM_VOLT, chart: true, groundOnly: true },
    { key: 'landPoint', v: LAND_POINT * cells, chart: true, forecast: true },
    { key: 'nearlyFlat', v: NEARLY_FLAT * cells, chart: true, forecast: true },
    p.BATT_LOW_VOLT && { key: 'lowVoltage', v: p.BATT_LOW_VOLT, chart: true, severe: true, forecast: canForecast(p.BATT_LOW_VOLT) },
    p.BATT_CRT_VOLT && { key: 'critVoltage', v: p.BATT_CRT_VOLT, severe: true, forecast: canForecast(p.BATT_CRT_VOLT) },
  ].filter(Boolean).sort((a, b) => b.v - a.v);
}

export function batteryLevel() {
  const S = store.S;
  if (S.volts == null) return null;
  const p = S.params || {};
  if (S.volts / (S.cells || 2) < 3) return { tone: 'bad', note: t('batteryVeryLow') };
  if (p.BATT_CRT_VOLT && S.volts < p.BATT_CRT_VOLT) return { tone: 'bad', note: t('critLow') };
  if (p.BATT_LOW_VOLT && S.volts < p.BATT_LOW_VOLT) return { tone: 'bad', note: t('low') };
  if (!S.armed && p.BATT_ARM_VOLT && S.volts < p.BATT_ARM_VOLT) return { tone: 'warn', note: t('belowArm') };
  return { tone: '', note: null };
}

// Typical LiPo resting voltage per cell at each state of charge. At a steady load charge falls in
// a straight line while voltage does not: it drops, sits on a plateau, then falls away at the knee.
// So the forecast fits its line in charge and converts back, rather than extrapolating voltage.
// This is a generic curve, not this pack's, which is why every forecast is given as a range. The
// published 5% table is smoothed here: its small steps would read as changes in the rate of discharge.
const CURVE = [
  [3.27, 0], [3.61, 5], [3.69, 10], [3.73, 20], [3.87, 60], [3.95, 70], [4.02, 80], [4.11, 90], [4.20, 100],
];
const HOVER_SAG = .04;      // V per cell a pack sags by in a hover, measured on one small quad
const MODEL_SPREAD = .2;    // the curve is generic: never claim better than this
const LEVEL_SPREAD = 7;     // % of charge the early end allows, since a pack's level can differ from the curve
const WINDOW_S = 120;
const MIN_WINDOW_S = 30;
const LOAD_STEP_PER_CELL = .04;     // a jump this big between samples means the load changed
const RECORD_GAP_S = 10;            // a longer break means the voltage was not being recorded
const MIN_FLIGHT_S = 60;            // the average since takeoff means little before this
const MIN_CHARGE_PER_MIN = 1;

function across(table, x, from, to) {
  if (x <= table[0][from]) return table[0][to];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][from]) {
      const [a, b] = [table[i - 1], table[i]];
      return a[to] + (b[to] - a[to]) * (x - a[from]) / (b[from] - a[from]);
    }
  }
  return table[table.length - 1][to];
}
const chargeAt = cellVolts => across(CURVE, cellVolts, 0, 1);
const cellAt = charge => across(CURVE, charge, 1, 0);

function lineFit(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  const slope = sxy / sxx;
  const now = my - slope * mx;
  let residual = 0;
  for (const [x, y] of points) residual += (y - (now + slope * x)) ** 2;
  return { slope, now, se: Math.sqrt(residual / (n - 2) / sxx) };
}

// The newest run of samples at one steady load. It stops at takeoff or landing, at arming, at a
// gap in the record, and at a jump in voltage: a line through any of those would mislead.
function steadyStretch(cells) {
  const h = store.history;
  if (!h.length) return null;
  const last = h[h.length - 1];
  const points = [];
  let later = null, laterAt = last[H.TIME];
  for (let i = h.length - 1; i >= 0; i--) {
    const s = h[i];
    if (last[H.TIME] - s[H.TIME] > WINDOW_S || s[H.ARMED] !== last[H.ARMED] || s[H.AIR] !== last[H.AIR]) break;
    if (laterAt - s[H.TIME] > RECORD_GAP_S) break;
    if (s[H.VOLTS] == null) continue;
    if (later != null && Math.abs(later - s[H.VOLTS]) > LOAD_STEP_PER_CELL * cells) break;
    later = s[H.VOLTS];
    laterAt = s[H.TIME];
    points.push([s[H.TIME] - last[H.TIME], s[H.VOLTS]]);
  }
  if (points.length < 8 || -points[points.length - 1][0] < MIN_WINDOW_S) return null;
  return { points, span: -points[points.length - 1][0], inAir: !!last[H.AIR] };
}

// Charge per second used since this stretch of flight began. The local slope alone is not enough:
// on a pack flatter than the curve, the voltage sits on its plateau and the slope says the charge is
// hardly moving. Comparing two points far apart depends much less on the shape of the curve.
function averageRate(cells, sag, chargeNow) {
  const h = store.history;
  const last = h[h.length - 1];
  let first = h.length - 1;
  for (let i = h.length - 2; i >= 0; i--) {
    const s = h[i];
    if (s[H.ARMED] !== last[H.ARMED] || s[H.AIR] !== last[H.AIR] || h[i + 1][H.TIME] - s[H.TIME] > RECORD_GAP_S) break;
    first = i;
  }
  const opening = h.slice(first, first + 5).map(s => s[H.VOLTS]).filter(v => v != null).sort((a, b) => a - b);
  const elapsed = last[H.TIME] - h[first][H.TIME];
  if (elapsed < MIN_FLIGHT_S || !opening.length) return null;
  const middle = opening[opening.length >> 1];     // so a moment of hard throttle cannot set the start
  return Math.max((chargeAt(middle / cells + sag) - chargeNow) / elapsed, 0);
}

// What the record can honestly say: 'collecting', 'stable', 'rising', or 'falling' with a rate.
export function voltageTrend() {
  const cells = store.S.cells || 2;
  const stretch = live() && !isOld('SYS_STATUS') ? steadyStretch(cells) : null;
  if (!stretch) return { state: 'collecting' };
  const sag = stretch.inAir ? HOVER_SAG : 0;
  const volts = lineFit(stretch.points);
  const charge = lineFit(stretch.points.map(([x, v]) => [x, chargeAt(v / cells + sag)]));
  const base = { volts: volts.now, perMin: Math.abs(volts.slope * 60), span: stretch.span, inAir: stretch.inAir };
  const chargePerMin = charge.slope * 60;
  if (charge.slope + 2 * charge.se < 0 && -chargePerMin >= MIN_CHARGE_PER_MIN) {
    const average = averageRate(cells, sag, charge.now);
    return { ...base, state: 'falling', charge: { now: charge.now, perSec: -charge.slope, se: charge.se, average } };
  }
  if (charge.slope - 2 * charge.se > 0 && chargePerMin >= MIN_CHARGE_PER_MIN) return { ...base, state: 'rising' };
  return { ...base, state: 'stable' };
}

// Seconds until the voltage reaches a limit, as a range, or null if that cannot be said. Only in
// the air: on the ground the drain says nothing about how long a flight would last.
export function timeTo(limit, trend) {
  if (trend.state !== 'falling' || !trend.inAir || !limit.forecast) return null;
  const margin = trend.charge.now - chargeAt(limit.v / (store.S.cells || 2) + HOVER_SAG);
  if (margin <= 0) return null;
  const { perSec, se, average } = trend.charge;
  const fastest = Math.max(perSec + 2 * se, average ?? 0);
  const slowest = Math.max(Math.min(perSec - 2 * se, average ?? Infinity), perSec * .25);
  return {
    soonest: Math.max(margin - LEVEL_SPREAD, 0) / fastest * (1 - MODEL_SPREAD),
    latest: margin / slowest * (1 + MODEL_SPREAD),
  };
}

// The expected voltage over the coming seconds, following the curve down through the knee.
export function forecastCurve(trend, now, horizon) {
  if (trend.state !== 'falling' || !trend.inAir) return null;
  const cells = store.S.cells || 2;
  const perSec = Math.max(trend.charge.perSec, trend.charge.average ?? 0);
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const seconds = horizon * i / 24;
    const charge = trend.charge.now - perSec * seconds;
    if (charge <= 0) break;
    points.push([now + seconds, (cellAt(charge) - HOVER_SAG) * cells]);
  }
  return points.length > 1 ? points : null;
}

export function etaText(range) {
  if (!range) return '';
  if (range.latest < 60) return t('etaSoon');
  const a = Math.round(range.soonest / 60), b = Math.max(Math.round(range.latest / 60), 1);
  // Never quote the far end of a range whose near end is already under a minute.
  if (range.soonest < 60) return t('etaUnder', { b });
  if (a >= 120) return t('etaLong', { h: Math.floor(a / 60) });
  if (b > a * 3 && b > 10) return t('etaOver', { a });
  return a === b ? t('etaOne', { a }) : t('etaRange', { a, b });
}

// The next limit worth mentioning below the present voltage.
export function nextLimit() {
  const v = store.S.volts;
  if (v == null) return null;
  return batteryLimits().find(l => !l.info && l.v < v && !(l.groundOnly && store.S.armed)) ?? null;
}

// The highest reading of the last few seconds: a moment of hard throttle sags the voltage without
// using up the pack, and must not read as having crossed a limit.
const settledVolts = () => Math.max(store.S.volts, ...store.history.slice(-3).map(s => s[H.VOLTS] ?? 0));

// What the battery demands attention for while flying, if anything.
function batteryWarning() {
  if (isOld('SYS_STATUS')) return null;
  const level = batteryLevel();
  if (level?.tone === 'bad') return { text: level.note, tone: 'red-text' };
  if (!inAir() || store.S.volts == null) return null;
  const limits = batteryLimits();
  const volts = settledVolts();
  if (volts <= limits.find(l => l.key === 'nearlyFlat').v) return { text: t('belowFlat'), tone: 'red-text' };
  if (volts <= limits.find(l => l.key === 'landPoint').v) return { text: t('belowLand'), tone: 'amber' };
  return null;
}

// The sentence at the top of the battery page.
export function batteryHeadline() {
  if (!live()) {
    const { state, tone } = statusText();
    return { text: state, tone };
  }
  if (isOld('SYS_STATUS')) return { text: t('valuesOld'), tone: 'amber' };
  const level = batteryLevel();
  if (level?.tone === 'bad') return { text: level.note, tone: 'red-text' };
  const trend = voltageTrend();
  const limits = batteryLimits();
  const named = key => limits.find(l => l.key === key);
  const flat = named('nearlyFlat'), land = named('landPoint');
  const volts = store.S.volts == null ? null : settledVolts();
  if (inAir() && volts != null) {
    if (volts <= flat.v) return { text: t('belowFlat'), tone: 'red-text' };
    if (volts <= land.v) {
      const eta = etaText(timeTo(flat, trend));
      return { text: eta ? t('belowLandEta', { eta }) : t('belowLand'), tone: 'amber' };
    }
  }
  if (trend.state === 'falling' && volts != null) {
    const target = limits.find(l => l.forecast && l.v < volts);
    const eta = target ? etaText(timeTo(target, trend)) : '';
    if (eta) return { text: t('reachIn', { eta, what: limitName(target.key, true) }), tone: '' };
  }
  return { text: t({ collecting: 'trendCollecting', stable: 'trendStable', rising: 'trendRising', falling: 'trendFalling' }[trend.state]), tone: '' };
}

// ---- Before flight ------------------------------------------------------------

// One line per thing worth checking before takeoff. `ok` is null while there is no current data,
// so nothing can pass on a stale reading.
export function preflight() {
  const S = store.S;
  const item = (key, ok, detail = '') => ({ key, ok, detail });
  const hasGps = S.gps != null;
  const armVolts = S.params?.BATT_ARM_VOLT;
  const vib = vibSummary();
  const rc = rcState();
  const current = (kind, value) => (isOld(kind) ? null : value);
  const checks = [
    item('checkFc', current('SYS_STATUS', prearmOk())),
    item('checkRc', current('SYS_STATUS', rc == null ? null : rc === 'ok'), rc === 'unprotected' ? t('rcOffShort') : ''),
    item('checkBattery', current('SYS_STATUS', S.volts != null && armVolts ? S.volts >= armVolts : null), S.volts != null ? `${S.volts.toFixed(2)} V` : ''),
    item('checkGps', current('GPS_RAW_INT', hasGps ? S.gps.fix >= 3 && S.gps.hdop != null && S.gps.hdop <= hdopLimit() : null),
      hasGps ? `${t('sats', { n: S.gps.sats ?? '–' })}  HDOP ${S.gps.hdop?.toFixed(1) ?? '–'}` : ''),
    item('checkNav', current('EKF_STATUS_REPORT', S.ekf ? !!(S.ekf.flags & 1 && S.ekf.flags & 0x10) : null)),
    item('checkSensors', current('SYS_STATUS', S.sens ? sensorBad().length === 0 : null)),
    item('checkVib', current('VIBRATION', vib ? vib.peak < VIB_MID : null)),
  ];
  const fence = fenceState();
  if (fence?.on) checks.push(item('checkFence', current('SYS_STATUS', fence.tone !== 'red-text')));
  return live() ? checks : checks.map(c => ({ ...c, ok: null }));
}

export function exportCsv() {
  const head = 'time,volts,altitude_m,speed_ms,climb_ms,hdop,satellites,vibration,link_load,armed,in_air,lat,lon,wifi_dbm';
  const lines = store.history.map(s => [new Date(s[H.TIME] * 1000).toISOString(), ...s.slice(1)].join(','));
  const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dronestats-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
