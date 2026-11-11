// What a flight command would do, worked out here from what the flight controller has told this page, so
// that it can be looked at before it is sent. Only commands that go somewhere have an answer. Those that
// hold the aircraft where it is, stop it or leave it to the sticks have nothing to draw and are sent at
// once. It is an estimate of how ArduCopter 4.7.1 flies, in still air, and tools/sitl_check.py's firmware
// has flown each of these against it.
import { CMD, outsideFence, planShapes } from '/plan.js';
import { store } from '/shared.js';

const AUTO = 3, RTL = 6, LAND = 9, SMART_RTL = 21;
const ON_GROUND = 1;            // MAV_LANDED_STATE_ON_GROUND
const ACROSS_ACCEL = 2.5;       // m/s², as the firmware's WP_ACC comes
const UPDOWN_ACCEL = 1;         // m/s², as its WP_ACC_Z comes
const TURN_S = 18;              // a turn of a circle in a mission, at CIRCLE_RATE as it comes
const SETTLED_S = 3;            // from touching the ground to knowing it has landed and disarming
const BRAKE_FROM_MS = 1;        // slower than this, it is as good as stopped
const BRAKE_LAG_S = 1.3;        // it goes on this long at full speed first: LOIT_BRK_DELAY and the way there
const SAMPLES = 16;             // points along each leg tested against the fence

const param = (name, otherwise) => store.S.params?.[name] ?? otherwise;
const wpSpeed = () => param('WP_SPD', 10) || 10;

const apart = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

// Time to cover a distance from rest to rest, reaching the speed only if there is room to.
function travel(metres, speed, accel) {
  if (metres <= 0) return 0;
  return metres >= speed * speed / accel ? metres / speed + speed / accel : 2 * Math.sqrt(metres / accel);
}

function legSeconds(a, b, speed = wpSpeed()) {
  const up = b.alt - a.alt;
  const rate = up > 0 ? param('WP_SPD_UP', 2.5) : param('WP_SPD_DN', 1.5);
  return Math.max(travel(apart(a, b), speed, ACROSS_ACCEL), travel(Math.abs(up), rate || 1, UPDOWN_ACCEL));
}

// A landing is quick until LAND_ALT_LOW_M and slow below it.
function landSeconds(alt) {
  const low = param('LAND_ALT_LOW_M', 10);
  const high = param('LAND_SPD_HIGH_MS', 0) || param('WP_SPD_DN', 1.5) || 1.5;
  return Math.max(alt - low, 0) / high + Math.min(Math.max(alt, 0), low) / (param('LAND_SPD_MS', .5) || .5) + SETTLED_S;
}

function flight(points, seconds, lands = false) {
  const shapes = planShapes(store.S);
  let metres = 0, outside = false;
  points.forEach((p, i) => {
    if (i) metres += apart(points[i - 1], p);
    if (!shapes) return;
    if (shapes.ceiling && shapes.enabled && p.alt > shapes.ceiling) outside = true;
    const from = points[Math.max(i - 1, 0)];
    for (let s = 1; s <= SAMPLES && !outside; s++) {
      const k = s / SAMPLES;
      outside = outsideFence(from.lat + (p.lat - from.lat) * k, from.lon + (p.lon - from.lon) * k, shapes);
    }
  });
  return { points, metres, seconds, end: points[points.length - 1], lands, outside };
}

function here() {
  const p = store.S.pos;
  return p && p[0] != null ? { lat: p[0], lon: p[1], alt: p[3] ?? 0 } : null;
}

// Moving, it cannot change course at once: the firmware starts what it is told from where it can stop.
function braking(from) {
  const north = store.S.pos?.[4] ?? 0, east = store.S.pos?.[5] ?? 0;
  const speed = Math.hypot(north, east);
  if (speed < BRAKE_FROM_MS) return { at: from, seconds: 0 };
  const reach = v => v * Math.abs(v) / (2 * ACROSS_ACCEL) + v * BRAKE_LAG_S;
  return {
    at: { lat: from.lat + reach(north) / 111320, lon: from.lon + reach(east) / (111320 * Math.cos(from.lat * Math.PI / 180)), alt: from.alt },
    seconds: speed / ACROSS_ACCEL,
  };
}

// Where a return goes: the nearest rally point unless home is nearer, or that point is out of reach.
function returnTarget(from) {
  const S = store.S;
  const home = S.home ? { lat: S.home[0], lon: S.home[1], alt: 0 } : null;
  let best = null;
  for (const r of planShapes(S)?.rally ?? []) {
    if (r.lat != null && (!best || apart(from, r) < apart(from, best))) best = r;
  }
  if (!best) return home;
  if (!home) return { lat: best.lat, lon: best.lon, alt: best.alt ?? 0 };
  const limit = param('RALLY_LIMIT_KM', .3) * 1000;
  if (limit > 0 && apart(from, best) > limit && apart(from, home) < apart(from, best)) return home;
  if (param('RALLY_INCL_HOME', 1) && apart(from, home) <= apart(from, best)) return home;
  return { lat: best.lat, lon: best.lon, alt: best.alt ?? 0 };
}

// ModeRTL::compute_return_target: up to RTL_ALT_M unless it is that close, never down, then across and down.
function returnPath(from) {
  const target = returnTarget(from);
  if (!target) return null;
  const across = apart(from, target);
  const lowest = from.alt + Math.max(param('RTL_CLIMB_MIN_M', 0), 0);
  let height = Math.max(target.alt, param('RTL_ALT_M', 15), lowest);
  const slope = param('RTL_CONE_SLOPE', 3);
  if (slope >= .5) height = Math.min(height, Math.max(across * slope, lowest));
  const shapes = planShapes(store.S);
  if (shapes?.enabled && shapes.ceiling) height = Math.min(height, shapes.ceiling - 2);
  height = Math.max(height, from.alt);
  const final = Math.max(param('RTL_ALT_FINAL_M', 0), 0);
  const points = [from];
  if (height > from.alt + .5) points.push({ lat: from.lat, lon: from.lon, alt: height });
  points.push({ lat: target.lat, lon: target.lon, alt: height }, { lat: target.lat, lon: target.lon, alt: final });
  const seconds = travel(height - from.alt, param('WP_SPD_UP', 2.5) || 1, UPDOWN_ACCEL)
    + travel(across, param('RTL_SPEED_MS', 0) || wpSpeed(), ACROSS_ACCEL)
    + param('RTL_LOIT_TIME', 5000) / 1000
    + (final ? 0 : landSeconds(height));
  return flight(points, seconds, !final);
}

// Back along the way it came, as far as this page has seen it, then down.
function smartReturnPath(from) {
  const trail = store.trail ?? [];
  if (trail.length < 2) return returnPath(from);
  const back = [from];
  let last = from;
  for (let i = trail.length - 1; i >= 0; i--) {
    const p = { lat: trail[i][0], lon: trail[i][1], alt: Math.max(trail[i][2], 0) };
    if (apart(last, p) >= 1 || Math.abs(last.alt - p.alt) >= 1) {
      back.push(p);
      last = p;
    }
  }
  // It keeps to the height it had on the way out, and slows for each corner of it.
  const speed = wpSpeed(), stop = speed / ACROSS_ACCEL;
  let seconds = stop, heading = null;
  back.forEach((p, i) => {
    if (!i) return;
    const a = back[i - 1], up = p.alt - a.alt;
    seconds += Math.max(apart(a, p) / speed, Math.abs(up) / ((up > 0 ? param('WP_SPD_UP', 2.5) : param('WP_SPD_DN', 1.5)) || 1));
    if (apart(a, p) < 1) return;
    const now = Math.atan2(p.lon - a.lon, p.lat - a.lat);
    const turn = heading == null ? 0 : Math.abs(Math.atan2(Math.sin(now - heading), Math.cos(now - heading)));
    if (turn > Math.PI / 4) seconds += stop;
    heading = now;
  });
  back.push({ lat: last.lat, lon: last.lon, alt: 0 });
  return flight(back, seconds + landSeconds(last.alt), true);
}

// The stored mission from one of its items on. A landing flies there at its height first, then goes down.
function missionPath(from, current) {
  const S = store.S;
  const route = planShapes(S)?.route;
  const first = route?.points.findIndex(p => p.seq != null && p.seq >= current);
  if (first == null || first < 0) return null;
  const points = [from];
  for (const p of route.points.slice(first)) {
    const last = points[points.length - 1];
    if (!p.alt && (last.lat !== p.lat || last.lon !== p.lon)) points.push({ lat: p.lat, lon: p.lon, alt: last.alt });
    points.push({ lat: p.lat, lon: p.lon, alt: p.alt });
  }
  let seconds = 0;
  points.forEach((p, i) => {
    if (!i) return;
    seconds += p.alt === 0 && points[i - 1].alt > 0 ? landSeconds(points[i - 1].alt) : legSeconds(points[i - 1], p);
  });
  for (const item of S.plan?.mission?.items ?? []) {
    if (item.seq < current) continue;
    if (item.cmd === CMD.LOITER_TIME || item.cmd === CMD.DELAY || item.cmd === CMD.CONDITION_DELAY) seconds += item.p?.[0] ?? 0;
    if (item.cmd === CMD.LOITER_TURNS) seconds += (item.p?.[0] ?? 0) * TURN_S;
  }
  return flight(points, seconds, points[points.length - 1].alt === 0);
}

// The way a command would go, or null if it goes nowhere from where the aircraft is now.
export function predictFlight(action, params = {}) {
  const S = store.S;
  const from = here();
  if (!from || !S.armed) return null;
  const onGround = S.landed === ON_GROUND;
  const current = Math.max(S.mission?.[0] ?? 1, 1);
  if (action === 'takeoff') {
    const to = { lat: from.lat, lon: from.lon, alt: params.alt };
    return onGround && params.alt ? flight([from, to], legSeconds(from, to)) : null;
  }
  if (onGround) return action === 'mission_start' ? missionPath(from, current) : null;
  const brake = braking(from);
  const start = brake.at;
  const way = (() => {
    if (action === 'goto' || action === 'land_at') {
      const to = { lat: params.lat, lon: params.lon, alt: params.alt };
      const there = legSeconds(start, to);
      if (action === 'goto') return flight([start, to], there);
      return flight([start, to, { ...to, alt: 0 }], there + landSeconds(params.alt), true);
    }
    if (action === 'altitude') {
      const target = S.target;
      const to = target ? { lat: target[0], lon: target[1], alt: params.alt } : { lat: start.lat, lon: start.lon, alt: params.alt };
      return flight([start, to], legSeconds(start, to));
    }
    if (action === 'mission_start') return missionPath(start, current);
    if (action === 'mission_item') return S.mode === AUTO ? missionPath(start, params.seq) : null;
    if (action !== 'mode') return null;
    if (params.mode === RTL) return returnPath(start);
    if (params.mode === SMART_RTL) return smartReturnPath(start);
    if (params.mode === LAND) return flight([start, { ...start, alt: 0 }], landSeconds(start.alt) - brake.seconds, true);
    if (params.mode === AUTO) return missionPath(start, current);
    return null;
  })();
  if (!way) return null;
  // The way begins where the aircraft is, even though it goes on from where it can stop.
  return start === from ? way : flight([from, ...way.points], way.seconds + brake.seconds, way.lands);
}
