// What the flight controller has stored, as shapes the map and the world can draw: the route of the
// mission, the fence, and the rally points. Worked out once for each change, on the viewer's device.

export const CMD = {
  WAYPOINT: 16, LOITER_UNLIM: 17, LOITER_TURNS: 18, LOITER_TIME: 19, RTL: 20, LAND: 21, TAKEOFF: 22, SPLINE: 82,
  LOITER_ALT: 31, VTOL_TAKEOFF: 84, VTOL_LAND: 85, DELAY: 93,
  DO_JUMP: 177, DO_CHANGE_SPEED: 178, DO_LAND_START: 189, CONDITION_DELAY: 112, CONDITION_YAW: 115,
  FENCE_RETURN: 5000, FENCE_POLY_IN: 5001, FENCE_POLY_OUT: 5002, FENCE_CIRCLE_IN: 5003, FENCE_CIRCLE_OUT: 5004, RALLY: 5100,
};

const FLOWN_TO = new Set([CMD.WAYPOINT, CMD.LOITER_UNLIM, CMD.LOITER_TURNS, CMD.LOITER_TIME, CMD.SPLINE, CMD.LOITER_ALT, CMD.TAKEOFF, CMD.VTOL_TAKEOFF, CMD.LAND, CMD.VTOL_LAND, CMD.RTL]);
const ABOVE_SEA = new Set([0, 5]);      // MAV_FRAME_GLOBAL and its integer form
const FENCE_ALT = 1, FENCE_CIRCLE = 2, FENCE_POLYGON = 4;
const FENCE_BIT = 0x100000;

let cached = null, cachedKey = null, version = 0;

// Home, from the telemetry or from the mission's first slot, which holds it once it is known.
function homeOf(S) {
  if (S.home) return { lat: S.home[0], lon: S.home[1], msl: S.home[2] };
  const first = S.plan?.mission?.items?.[0];
  return first?.lat != null ? { lat: first.lat, lon: first.lon, msl: first.alt } : null;
}

// The heights in the mission are usually above home. Those above sea level are converted; those
// above terrain are taken as above home, which is the nearest thing known here.
function above(item, home) {
  return ABOVE_SEA.has(item.frame) ? item.alt - (home?.msl ?? 0) : item.alt;
}

// The mission in flight order. An item with no place stays where the last one was, and a height of
// zero keeps the last height, as ArduPilot flies them. It starts from home and ends where it lands.
function routeOf(items, home, rtlAlt) {
  const route = [];
  let lat = home?.lat ?? null, lon = home?.lon ?? null, alt = 0;
  for (const item of items.slice(1)) {
    if (!FLOWN_TO.has(item.cmd)) continue;
    if (item.cmd === CMD.RTL) {
      if (home) {
        route.push({ seq: item.seq, cmd: item.cmd, lat: home.lat, lon: home.lon, alt: Math.max(alt, rtlAlt ?? 0) });
        route.push({ seq: null, cmd: CMD.LAND, lat: home.lat, lon: home.lon, alt: 0 });
      }
      break;
    }
    lat = item.lat ?? lat;
    lon = item.lon ?? lon;
    if (item.cmd === CMD.LAND || item.cmd === CMD.VTOL_LAND) alt = 0;
    else if (item.alt) alt = above(item, home);
    if (lat == null) continue;      // no place known yet, for a takeoff with home not set
    route.push({ seq: item.seq, cmd: item.cmd, lat, lon, alt });
  }
  return { start: home && route.length ? { lat: home.lat, lon: home.lon, alt: 0 } : null, points: route };
}

// Polygons arrive as runs of vertices, each knowing how many are in its polygon.
function fenceOf(items) {
  const polygons = [], circles = [];
  let back = null;
  for (let i = 0; i < items.length;) {
    const item = items[i];
    if (item.cmd === CMD.FENCE_POLY_IN || item.cmd === CMD.FENCE_POLY_OUT) {
      const count = Math.max(1, item.p[0] ?? 1);
      polygons.push({ inside: item.cmd === CMD.FENCE_POLY_IN, points: items.slice(i, i + count).map(v => [v.lat, v.lon]) });
      i += count;
      continue;
    }
    if (item.cmd === CMD.FENCE_CIRCLE_IN || item.cmd === CMD.FENCE_CIRCLE_OUT) {
      circles.push({ inside: item.cmd === CMD.FENCE_CIRCLE_IN, at: [item.lat, item.lon], radius: item.p[0] });
    } else if (item.cmd === CMD.FENCE_RETURN) {
      back = [item.lat, item.lon];
    }
    i++;
  }
  return { polygons, circles, back };
}

// Everything worth drawing, or null if nothing is stored. The same object comes back until something
// changes, and `version` says when it has.
export function planShapes(S) {
  const p = S.params ?? {};
  const sens = S.sens?.[1] ?? 0;
  const key = S.plan;
  const home = homeOf(S);
  const stamp = `${home?.lat},${home?.lon},${home?.msl},${p.FENCE_TYPE},${p.FENCE_ALT_MAX},${p.FENCE_RADIUS},${p.RTL_ALT_M},${sens & FENCE_BIT}`;
  if (cached && cachedKey === key && cached.stamp === stamp) return cached;
  cachedKey = key;
  version++;
  const missionItems = S.plan?.mission?.items ?? [];
  const types = p.FENCE_TYPE ?? 0;
  const enabled = !!(sens & FENCE_BIT);
  const fence = fenceOf(S.plan?.fence?.items ?? []);
  const rally = (S.plan?.rally?.items ?? []).map((item, i) => ({ n: i + 1, lat: item.lat, lon: item.lon, alt: item.alt }));
  cached = {
    version, stamp, home,
    route: routeOf(missionItems, home, p.RTL_ALT_M),
    ...fence,
    rally,
    enabled,
    polygonsOn: !!(types & FENCE_POLYGON),
    // Only when on: the firmware's defaults describe a circle even on an aircraft with no fence at all.
    cylinder: enabled && types & FENCE_CIRCLE && home && p.FENCE_RADIUS ? { at: [home.lat, home.lon], radius: p.FENCE_RADIUS } : null,
    ceiling: types & FENCE_ALT && p.FENCE_ALT_MAX ? p.FENCE_ALT_MAX : null,
    counts: { plan: Math.max(missionItems.length - 1, 0), fence: S.plan?.fence?.items?.length ?? 0, rally: rally.length },
  };
  return cached;
}

// The short label of a point on the route.
export const pointLabel = p => (p.cmd === CMD.RTL ? 'H' : p.cmd === CMD.TAKEOFF ? 'T' : p.cmd === CMD.LAND ? 'L' : String(p.seq));

// The first mission item at or after the current one that the aircraft actually flies to.
export function nextPoint(shapes, current) {
  return shapes?.route.points.find(p => p.seq != null && p.seq >= current) ?? null;
}

// Every place in the shapes that are switched on, for fitting them on the map.
export function placesOf(shapes, show) {
  if (!shapes) return [];
  const out = [];
  if (show.plan) {
    for (const p of shapes.route.points) out.push([p.lat, p.lon]);
  }
  if (show.rally) {
    for (const r of shapes.rally) out.push([r.lat, r.lon]);
  }
  if (show.fence) {
    for (const polygon of shapes.polygons) out.push(...polygon.points);
    const edge = c => {
      const dlat = c.radius / 111320, dlon = dlat / Math.cos(c.at[0] * Math.PI / 180);
      out.push([c.at[0] + dlat, c.at[1]], [c.at[0] - dlat, c.at[1]], [c.at[0], c.at[1] + dlon], [c.at[0], c.at[1] - dlon]);
    };
    shapes.circles.forEach(edge);
    if (shapes.cylinder) edge(shapes.cylinder);
  }
  return out;
}

// ---- Drafts --------------------------------------------------------------------------

// A mission being edited: its items in flight order, without the home slot, with heights above home.
export function seedDraft(S) {
  const home = S.home ?? null;
  return (S.plan?.mission?.items ?? []).slice(1).map(item => ({
    cmd: item.cmd,
    ...(item.lat != null ? { lat: item.lat, lon: item.lon } : {}),
    alt: ABOVE_SEA.has(item.frame) && item.alt ? item.alt - (home?.[2] ?? S.plan?.mission?.items?.[0]?.alt ?? 0) : item.alt,
    p: [...item.p],
  }));
}

// The route of a draft, in the same form as a stored one. Every height in a draft is above home.
export function routeOfDraft(items, home, rtlAlt) {
  return routeOf([{}, ...items.map((item, i) => ({ ...item, seq: i + 1, frame: 3 }))], home, rtlAlt);
}

const SPEED_DEFAULT = 10;       // WP_SPD as it comes, for when it has not been read
const CLIMB_FACTOR = 1.15;      // starting, stopping and climbing take a little longer than the distance suggests

export function routeStats(route, items, speed) {
  const points = [route.start, ...route.points].filter(Boolean);
  let metres = 0, top = 0;
  points.forEach((p, i) => {
    top = Math.max(top, p.alt);
    if (i) metres += Math.hypot((p.lat - points[i - 1].lat) * 111320, (p.lon - points[i - 1].lon) * 111320 * Math.cos(p.lat * Math.PI / 180));
  });
  let wait = 0;
  for (const item of items) {
    if (item.cmd === CMD.LOITER_TIME || item.cmd === CMD.DELAY || item.cmd === CMD.CONDITION_DELAY) wait += item.p?.[0] ?? 0;
  }
  return { metres, top, seconds: metres / (speed > 0 ? speed : SPEED_DEFAULT) * CLIMB_FACTOR + wait };
}

function insidePolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ay, ax] = points[i], [by, bx] = points[j];
    if ((ay > lat) !== (by > lat) && lon < (bx - ax) * (lat - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

const metresApart = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));

// Whether a place is outside what the fence allows, whichever fence is in force.
export function outsideFence(lat, lon, shapes) {
  if (!shapes?.enabled) return false;
  if (shapes.polygonsOn) {
    const keepIn = shapes.polygons.filter(p => p.inside);
    if (keepIn.length && !keepIn.some(p => insidePolygon(lat, lon, p.points))) return true;
    if (shapes.polygons.some(p => !p.inside && insidePolygon(lat, lon, p.points))) return true;
    for (const c of shapes.circles) {
      const within = metresApart([lat, lon], c.at) <= c.radius;
      if (within !== c.inside) return true;
    }
  }
  return !!shapes.cylinder && metresApart([lat, lon], shapes.cylinder.at) > shapes.cylinder.radius;
}

// What is worth knowing before writing a draft. None of it stops the writing: the flight controller
// and the server have the last word, and a fence may be about to change too.
export function draftWarnings(items, route, S, allowed) {
  const out = [];
  if (!items.length) return out;
  if (items[0].cmd !== CMD.TAKEOFF) out.push({ key: 'warnNoTakeoff' });
  const last = items[items.length - 1].cmd;
  if (last !== CMD.RTL && last !== CMD.LAND) out.push({ key: 'warnNoEnd' });
  const shapes = planShapes(S);
  for (const p of route.points) {
    if (p.seq == null) continue;
    if (outsideFence(p.lat, p.lon, shapes)) out.push({ key: 'warnOutside', vars: { n: p.seq } });
    if (shapes.enabled && shapes.ceiling != null && p.alt > shapes.ceiling) out.push({ key: 'warnCeiling', vars: { n: p.seq, h: Math.round(shapes.ceiling) } });
  }
  if (allowed) {
    items.forEach((item, i) => {
      if (!allowed.includes(item.cmd)) out.push({ key: 'warnCannotWrite', vars: { n: i + 1 } });
    });
  }
  return out;
}

// A mission as Mission Planner writes it, so it can go back there.
export function toWaypointsFile(items, home) {
  const lines = ['QGC WPL 110', [0, 1, 0, CMD.WAYPOINT, 0, 0, 0, 0, home?.lat ?? 0, home?.lon ?? 0, home?.msl ?? 0, 1].join('\t')];
  items.forEach((item, i) => {
    const p = item.p ?? [0, 0, 0, 0];
    lines.push([i + 1, 0, 3, item.cmd, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0, item.lat ?? 0, item.lon ?? 0, item.alt ?? 0, 1].join('\t'));
  });
  return `${lines.join('\n')}\n`;
}

// ---- Files from a ground station --------------------------------------------------

// A .waypoints file from Mission Planner, or a .plan file from QGroundControl. Returns the plans it
// holds, as the server wants them, or throws. The server checks every item again.
export function parsePlanFile(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parseQgcPlan(JSON.parse(trimmed));
  if (/^QGC WPL/.test(trimmed)) return { mission: parseWaypoints(trimmed) };
  throw new Error('format');
}

function parseWaypoints(text) {
  const items = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length < 12 || f.some(Number.isNaN)) throw new Error('format');
    const [seq, , frame, cmd, p1, p2, p3, p4, lat, lon, alt] = f;
    if (seq === 0) continue;       // home, which the flight controller keeps for itself
    const placed = lat !== 0 || lon !== 0;
    items.push({ cmd, frame, p: [p1, p2, p3, p4], alt, ...(placed ? { lat, lon } : {}) });
  }
  if (!items.length) throw new Error('empty');
  return items;
}

function parseQgcPlan(file) {
  const out = {};
  const mission = (file.mission?.items ?? []).filter(item => item.type === 'SimpleItem');
  if (mission.length) {
    out.mission = mission.map(item => {
      const [p1, p2, p3, p4, lat, lon, alt] = item.params;
      const placed = lat || lon;
      return { cmd: item.command, frame: item.frame, p: [p1, p2, p3, p4], alt: alt ?? 0, ...(placed ? { lat, lon } : {}) };
    });
  }
  const fence = [];
  for (const polygon of file.geoFence?.polygons ?? []) {
    for (const [lat, lon] of polygon.polygon) {
      fence.push({ cmd: polygon.inclusion ? CMD.FENCE_POLY_IN : CMD.FENCE_POLY_OUT, lat, lon, p: [polygon.polygon.length, 0, 0, 0] });
    }
  }
  for (const { circle, inclusion } of file.geoFence?.circles ?? []) {
    fence.push({ cmd: inclusion ? CMD.FENCE_CIRCLE_IN : CMD.FENCE_CIRCLE_OUT, lat: circle.center[0], lon: circle.center[1], p: [circle.radius, 0, 0, 0] });
  }
  if (fence.length) out.fence = fence;
  const rally = (file.rallyPoints?.points ?? []).map(([lat, lon, alt]) => ({ lat, lon, alt }));
  if (rally.length) out.rally = rally;
  if (!Object.keys(out).length) throw new Error('empty');
  return out;
}
