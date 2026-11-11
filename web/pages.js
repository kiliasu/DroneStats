// The expanded views. Each builds its content once, drawn straight on the dimmed world, and
// returns a function that refreshes it. Everything here runs on the viewer's device.

import { COMPASS } from '/i18n.js';
import { Chart } from '/chart.js';
import { CMD, nextPoint, planShapes } from '/plan.js';
import {
  FENCE_ACTIONS, H, LOSS_ALERT, VIB_HIGH, VIB_MID, batteryHeadline, batteryLimits, clock, distance, el, etaText, exportCsv, fenceState, fixed, flightStats, forecastCurve,
  fromHere, fromHome, gpsSummary, hdopLimit, joined, latencyTone, limitName, messageText, messageTone, navSummary, prearmOk, preflight, put, rcState,
  motorTone, series, signed, store, sensorStates, t, timeOf, timeTo, vibSummary, voltageTrend, wifiLevel, alerts,
} from '/shared.js';
import { CMD_NAMES, MISSION_STATES, prearmText } from '/i18n.js';

const CHART_PAST_S = 900;
const LOGS_RETRY_MS = 4000;

// Labelled values. Rows with no value hide themselves.
export function rows(parent, defs) {
  const dl = el('dl', null, parent);
  const bound = defs.map(([label, read, tone]) => {
    const dt = el('dt', null, dl, typeof label === 'function' ? label() : t(label));
    const dd = el('dd', null, dl);
    return { dt, dd, read, tone };
  });
  return () => {
    for (const { dt, dd, read, tone } of bound) {
      const value = read();
      const has = value != null && value !== '';
      dt.hidden = dd.hidden = !has;
      if (!has) continue;
      put(dd, String(value));
      if (tone) dd.className = tone() || '';
    }
  };
}

export const columns = root => {
  const wrap = el('div', 'columns', root);
  return [el('div', 'main-col', wrap), el('div', 'side-col', wrap)];
};
export const section = (parent, key) => el('h3', null, parent, t(key));

function pastWindow(points) {
  if (!points.length) return { now: Date.now() / 1000, past: 120 };
  const now = points[points.length - 1][0];
  return { now, past: Math.max(Math.min(now - points[0][0], CHART_PAST_S), 120) };
}
const minutesAgo = s => t('minAgo', { n: Math.max(1, Math.round(s / 60)) });
const minutesAhead = s => t('minAhead', { n: Math.max(1, Math.round(s / 60)) });

function rangeOf(points, minSpan) {
  const values = points.map(p => p[1]);
  if (!values.length) return { lo: 0, hi: minSpan };
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((minSpan - (hi - lo)) / 2, (hi - lo) * .08);
  return { lo: lo - pad, hi: hi + pad };
}

function plainChart(host, field, minSpan, seconds = CHART_PAST_S, extra = () => ({}), unit = null) {
  const chart = new Chart(host);
  return () => {
    const points = series(field, seconds);
    const { now, past } = pastWindow(points);
    chart.draw({
      points, now, past, ...rangeOf(points, minSpan), labels: { start: minutesAgo(past), now: t('now') },
      format: unit ? v => `${fixed(v)} ${unit}` : null, ...extra(points),
    });
  };
}

// ---- Battery ------------------------------------------------------------------

function battery(root) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const basis = el('p', 'caption soft', main);
  const chart = new Chart(main, 'tall');
  section(side, 'limits');
  const limitsHost = el('div', 'limits', side);
  const limitRows = new Map();
  let shownOrder = '';
  const more = rows(side, [
    ['cellVoltage', () => (store.S.volts != null ? `${(store.S.volts / store.S.cells).toFixed(2)} V` : null)],
    ['dropRate', () => { const v = voltageTrend(); return v.state === 'falling' ? t('vPerMin', { v: v.perMin.toFixed(3) }) : null; }],
    ['flightDrop', () => { const f = flightStats(); return f?.drop != null ? `${f.drop.toFixed(2)} V` : null; }],
    ['flightTime', () => { const f = flightStats(); return f ? clock(f.seconds) : null; }],
    ['current', () => (store.S.amps != null ? `${fixed(store.S.amps)} A` : null)],
    ['consumed', () => (store.S.batt?.mah != null ? `${store.S.batt.mah} mAh` : null)],
    ['counted', () => (store.S.batt?.pct != null ? `${store.S.batt.pct}%` : null)],
    ['perCellRead', () => (store.S.batt?.cells ? store.S.batt.cells.map(v => v.toFixed(2)).join('  ') : null)],
    ['battTemp', () => (store.S.batt?.temp != null ? `${store.S.batt.temp.toFixed(1)} °C` : null)],
    ['capacity', () => (store.S.params?.BATT_CAPACITY ? `${Math.round(store.S.params.BATT_CAPACITY)} mAh` : null)],
  ]);

  return () => {
    const S = store.S;
    const trend = voltageTrend();
    const limits = batteryLimits();
    const volts = S.volts;
    const said = batteryHeadline();
    put(headline, said.text);
    headline.className = `headline ${said.tone}`;
    put(basis, trend.state === 'falling' && trend.inAir ? t('forecastBasis', { n: Math.round(trend.span) }) : '');

    // Rows for each limit, highest first: how far above it, and when it would be reached.
    // Settings arrive one at a time, so the set of limits can grow after the page opens.
    const order = limits.map(l => l.key).join();
    if (order !== shownOrder) {
      shownOrder = order;
      limitsHost.textContent = '';
      limitRows.clear();
      for (const limit of limits) {
        const box = el('div', 'limit-row', limitsHost);
        limitRows.set(limit.key, { margin: (el('span', null, box, limitName(limit.key)), el('span', 'right', box)), at: el('span', 'small soft', box), eta: el('span', 'small soft right', box) });
      }
    }
    for (const limit of limits) {
      const row = limitRows.get(limit.key);
      put(row.at, `${limit.v.toFixed(2)} V`);
      if (volts == null) {
        put(row.margin, '–');
        put(row.eta, '');
        continue;
      }
      const margin = volts - limit.v;
      put(row.margin, `${signed(margin)} V`);
      row.margin.className = `right ${margin >= 0 ? '' : limit.severe ? 'red-text' : limit.info ? 'soft' : 'amber'}`;
      put(row.eta, etaText(timeTo(limit, trend)));
    }
    more();

    const points = series(H.VOLTS, CHART_PAST_S);
    const { now, past } = pastWindow(points);
    const curve = forecastCurve(trend, now, Math.max(past / 3, 120));
    const future = curve ? curve[curve.length - 1][0] - now : 0;
    const cells = S.cells || 2;
    const values = points.map(p => p[1]);
    const floor = Math.min(3.5 * cells - .15, ...(values.length ? [Math.min(...values) - .1] : []));
    const ceiling = Math.max(4.2 * cells, ...(values.length ? [Math.max(...values) + .05] : []));
    chart.draw({
      points, now, past, future, lo: floor, hi: ceiling,
      limits: limits.filter(l => l.chart && !(l.groundOnly && S.armed))
        .map(l => ({ v: l.v, text: `${limitName(l.key)} ${l.v.toFixed(2)}`, tone: l.severe ? 'red' : '' })),
      forecast: curve,
      labels: { start: minutesAgo(past), now: t('now'), end: minutesAhead(future) },
    });
  };
}

// ---- Altitude and speed -------------------------------------------------------

function altitude(root) {
  const [main, side] = columns(root);
  const redraw = plainChart(el('div', 'chart-host', main), H.ALT, 2, CHART_PAST_S, () => ({}), 'm');
  const list = rows(side, [
    ['relAltitude', () => (store.S.pos ? `${fixed(store.S.pos[3])} m` : null)],
    ['climbRate', () => (store.S.hud ? `${fixed(store.S.hud[1])} m/s` : null)],
    ['agl', () => (store.S.terrain?.[1] != null ? `${fixed(store.S.terrain[1])} m` : null)],
    ['msl', () => (store.S.pos?.[2] != null ? `${fixed(store.S.pos[2])} m` : null)],
    ['terrainHeight', () => (store.S.terrain?.[0] != null ? `${fixed(store.S.terrain[0])} m` : null)],
    ['maxAlt', () => { const f = flightStats(); return f?.top != null ? `${fixed(f.top)} m` : null; }],
    ['altError', () => (store.S.armed && store.S.nav ? `${fixed(store.S.nav[2])} m` : null)],
    ['fenceCeiling', () => (store.S.params?.FENCE_TYPE & 1 && store.S.params?.FENCE_ALT_MAX ? `${Math.round(store.S.params.FENCE_ALT_MAX)} m` : null)],
    ['rtlAlt', () => (store.S.params?.RTL_ALT_M != null ? `${fixed(store.S.params.RTL_ALT_M)} m` : null)],
    ['pressure', () => (store.S.baro ? `${store.S.baro[0].toFixed(1)} hPa` : null)],
    ['baroTemp', () => (store.S.baro ? `${store.S.baro[1].toFixed(1)} °C` : null)],
  ]);
  return () => { redraw(); list(); };
}

function speed(root) {
  const [main, side] = columns(root);
  const redraw = plainChart(el('div', 'chart-host', main), H.SPEED, 2, CHART_PAST_S, () => ({}), 'm/s');
  const list = rows(side, [
    ['groundSpeed', () => (store.S.hud ? `${fixed(store.S.hud[0])} m/s` : null)],
    ['verticalSpeed', () => (store.S.hud ? `${fixed(store.S.hud[1])} m/s` : null)],
    ['throttle', () => (store.S.hud ? `${store.S.hud[2]}%` : null)],
    ['course', () => courseText()],
    ['headingL', () => (store.S.hud ? `${store.S.hud[3]}°` : null)],
    ['maxSpeed', () => { const f = flightStats(); return f?.fastest != null ? `${fixed(f.fastest)} m/s` : null; }],
    ['flownDist', () => { const f = flightStats(); return f ? distance(f.travelled) : null; }],
    ['relHome', () => { const h = fromHome(); return h ? distance(h.metres) : null; }],
    ['wpSpeed', () => (store.S.params?.WP_SPD != null ? `${fixed(store.S.params.WP_SPD)} m/s` : null)],
    ['offTrack', () => (store.S.armed && store.S.nav?.[0] ? `${fixed(Math.abs(store.S.nav[3]))} m` : null)],
  ]);
  return () => { redraw(); list(); };
}

const courseOf = () => {
  const p = store.S.pos;
  if (!p || Math.hypot(p[4], p[5]) < .3) return null;
  return (Math.atan2(p[5], p[4]) * 180 / Math.PI + 360) % 360;
};
const courseText = () => { const c = courseOf(); return c == null ? null : `${Math.round(c)}°`; };

// ---- Position -----------------------------------------------------------------

// This page is usually served over plain http, where the modern clipboard call is not offered.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Carry on the older way.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.append(area);
  area.select();
  const done = document.execCommand('copy');
  area.remove();
  return done;
}

function buildDial(host) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'dial');
  svg.setAttribute('viewBox', '-130 -130 260 260');
  svg.setAttribute('aria-hidden', 'true');
  const add = (name, cls, attrs = {}) => {
    const e = document.createElementNS(NS, name);
    if (cls) e.setAttribute('class', cls);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.append(e);
    return e;
  };
  add('circle', 'dial-ring', { r: 100 });
  for (let a = 0; a < 360; a += 30) {
    const r = a * Math.PI / 180;
    add('line', 'dial-tick', { x1: 100 * Math.sin(r), y1: -100 * Math.cos(r), x2: 92 * Math.sin(r), y2: -92 * Math.cos(r) });
  }
  COMPASS[store.lang].filter((_, i) => i % 2 === 0).forEach((name, i) => {
    const r = i * Math.PI / 2;
    const label = add('text', 'dial-text', { x: 116 * Math.sin(r), y: -116 * Math.cos(r) + 5 });
    label.textContent = name;
  });
  const craft = add('path', 'dial-craft', { d: 'M0 -30 L18 21 L0 11 L-18 21 Z' });
  const course = add('circle', 'dial-course', { r: 6 });
  const home = add('circle', 'dial-home', { r: 6 });
  host.append(svg);
  const onRing = (node, degrees) => {
    node.setAttribute('visibility', degrees == null ? 'hidden' : 'visible');
    if (degrees == null) return;
    const r = degrees * Math.PI / 180;
    node.setAttribute('cx', (82 * Math.sin(r)).toFixed(1));
    node.setAttribute('cy', (-82 * Math.cos(r)).toFixed(1));
  };
  return () => {
    const S = store.S;
    craft.setAttribute('transform', `rotate(${S.hud ? S.hud[3] : 0})`);
    onRing(course, courseOf());
    const h = fromHome();
    onRing(home, h && h.metres >= 3 ? (h.bearing * 180 / Math.PI + 360) % 360 : null);
  };
}

function position(root) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const wrap = el('div', 'dial-row', main);
  const dial = buildDial(wrap);
  const legend = el('div', 'legend', wrap);
  const lines = rows(legend, [
    ['headingL', () => (store.S.hud ? `${store.S.hud[3]}°` : null)],
    ['course', () => courseText()],
    ['bearingHome', () => { const h = fromHome(); return h && h.metres >= 3 ? `${Math.round((h.bearing * 180 / Math.PI + 360) % 360)}°` : null; }, () => 'amber'],
    ['relPos', () => {
      const h = fromHome();
      if (!h || h.metres < 1) return null;
      const names = COMPASS[store.lang];
      return `${names[0]} ${signed(-h.metres * Math.cos(h.bearing), 0)} m  ${names[2]} ${signed(-h.metres * Math.sin(h.bearing), 0)} m`;
    }],
    ['relHome', () => { const h = fromHome(); return h ? distance(h.metres) : null; }],
    ['heading2Target', () => { const g = store.S.armed ? fromHere(store.S.target) : null; return g ? distance(g.metres) : null; }],
    ['mission', () => (store.S.mission?.[1] ? `${store.S.mission[0]} / ${store.S.mission[1]}` : null)],
    ['stackFence', () => fenceState()?.text, () => fenceState()?.tone],
  ]);
  const copy = el('button', 'tile compact', legend, t('copyPos'));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const p = store.S.pos;
    if (p?.[0] == null) return;
    put(copy, t(await copyText(`${p[0].toFixed(7)}, ${p[1].toFixed(7)}`) ? 'copied' : 'copyFailed'));
    setTimeout(() => put(copy, t('copyPos')), 1500);
  });
  const limit = () => hdopLimit();
  const redraw = plainChart(el('div', 'chart-host short', main), H.HDOP, 2, CHART_PAST_S, points => {
    const values = points.map(p => p[1]);
    return {
      lo: 0, hi: Math.max(limit() * 1.5, ...values) * 1.1,
      limits: [{ v: limit(), text: t('hdopGoodLine', { v: limit().toFixed(1) }) }],
    };
  });

  const fixName = () => { const g = store.S.gps; return g ? (g.fix >= 3 ? '3D' : g.fix === 2 ? '2D' : t('noFix')) : null; };
  section(side, 'secGps');
  const gps = rows(side, [
    ['fixType', fixName],
    ['satellites', () => store.S.gps?.sats],
    ['hdop', () => store.S.gps?.hdop?.toFixed(1)],
    ['hdopMargin', () => { const g = store.S.gps; return g?.hdop != null ? signed(limit() - g.hdop, 1) : null; }, () => (store.S.gps?.hdop > limit() ? 'amber' : '')],
    ['hAcc', () => (store.S.gps?.hacc != null ? `${store.S.gps.hacc.toFixed(1)} m` : null)],
    ['vAcc', () => (store.S.gps?.vacc != null ? `${store.S.gps.vacc.toFixed(1)} m` : null)],
    ['latlon', () => (store.S.pos?.[0] != null ? `${store.S.pos[0].toFixed(6)}, ${store.S.pos[1].toFixed(6)}` : null)],
    ['msl', () => (store.S.pos?.[2] != null ? `${store.S.pos[2].toFixed(1)} m` : null)],
  ]);
  section(side, 'secEstimator');
  const flag = bit => () => (store.S.ekf ? (store.S.ekf.flags & bit ? t('flagOk') : t('flagNo')) : null);
  const flagTone = bit => () => (store.S.ekf && !(store.S.ekf.flags & bit) ? 'amber' : '');
  const estimator = rows(side, [
    ['ekfAttitude', flag(0x1), flagTone(0x1)],
    ['ekfVelH', flag(0x2), flagTone(0x2)],
    ['ekfVelV', flag(0x4), flagTone(0x4)],
    ['ekfPosH', flag(0x10), flagTone(0x10)],
    ['ekfPosV', flag(0x20), flagTone(0x20)],
    ['ekfVariance', () => (store.S.ekf ? `${fixed(store.S.ekf.posh, 2)}  ${fixed(store.S.ekf.posv, 2)}  ${fixed(store.S.ekf.mag, 2)}` : null)],
  ]);
  return () => {
    const g = gpsSummary();
    put(headline, store.S.gps ? g.text : '');
    headline.className = `headline ${g.tone}`;
    copy.hidden = store.S.pos?.[0] == null;
    dial(); lines(); gps(); estimator(); redraw();
  };
}

// ---- Airframe -----------------------------------------------------------------

function airframe(root) {
  const [main, side] = columns(root);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'frame-big');
  svg.setAttribute('viewBox', '-150 -150 300 300');
  svg.setAttribute('aria-hidden', 'true');
  const add = (name, cls, attrs, parent = svg) => {
    const e = document.createElementNS(NS, name);
    e.setAttribute('class', cls);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.append(e);
    return e;
  };
  add('path', 'big-line', { d: 'M-10 -10L-52 -52M10 -10L52 -52M-10 10L-52 52M10 10L52 52M0 -22V-52' });
  add('circle', 'big-hub', { r: 5 });
  // Quad X, as ArduCopter numbers its motors.
  const slots = [[84, -84], [-84, 84], [-84, -84], [84, 84]].map(([x, y]) => {
    const g = add('g', '', { transform: `translate(${x} ${y})` });
    add('circle', 'big-ring', { r: 46 }, g);
    const arc = add('circle', 'big-out', { r: 46 }, g);
    const text = add('text', 'big-text', { y: 6 }, g);
    return { arc, text };
  });
  main.append(svg);
  const balance = rows(main, [
    ['avgOutput', () => { const m = (store.S.motors || []).filter(v => v != null); return m.length ? `${Math.round(m.reduce((a, b) => a + b) / m.length)}%` : null; }],
    ['spread', () => { const m = (store.S.motors || []).filter(v => v != null); return m.length ? `${Math.max(...m) - Math.min(...m)}%` : null; }, () => { const m = (store.S.motors || []).filter(v => v != null); return m.length && Math.max(...m) - Math.min(...m) > 25 ? 'amber' : ''; }],
    ['throttle', () => (store.S.hud ? `${store.S.hud[2]}%` : null)],
  ]);

  section(side, 'vibration');
  const redraw = plainChart(el('div', 'chart-host short', side), H.VIB, 10, CHART_PAST_S, points => ({
    lo: 0, hi: Math.max(VIB_HIGH * 1.15, ...points.map(p => p[1])),
    limits: [{ v: VIB_MID, text: t('vibMid') }, { v: VIB_HIGH, text: t('vibHigh'), tone: 'red' }],
  }));
  const shake = rows(side, [
    ['vibX', () => (store.S.vib ? `${fixed(store.S.vib.xyz[0])} m/s²` : null)],
    ['vibY', () => (store.S.vib ? `${fixed(store.S.vib.xyz[1])} m/s²` : null)],
    ['vibZ', () => (store.S.vib ? `${fixed(store.S.vib.xyz[2])} m/s²` : null)],
    ['clip', () => store.S.vib?.clip],
  ]);
  section(side, 'secAttitude');
  const deg = i => () => (store.S.att ? `${fixed(store.S.att[i] * 180 / Math.PI)}°` : null);
  const rate = i => () => (store.S.att ? `${fixed(store.S.att[i] * 180 / Math.PI)}°/s` : null);
  const attitude = rows(side, [
    ['roll', deg(0)], ['pitch', deg(1)], ['rollRate', rate(3)], ['pitchRate', rate(4)], ['yawRate', rate(5)],
    ['imuTemp', () => (store.S.imu_t != null ? `${store.S.imu_t.toFixed(1)} °C` : null)],
  ]);

  return () => {
    const motors = store.S.motors || [];
    const length = 2 * Math.PI * 46;
    slots.forEach(({ arc, text }, i) => {
      const v = motors[i];
      arc.style.strokeDasharray = `${((v ?? 0) / 100 * length).toFixed(1)} ${length.toFixed(1)}`;
      arc.setAttribute('class', `big-out ${motorTone(v)}`);
      text.setAttribute('class', `big-text ${motorTone(v)}`);
      put(text, v == null ? '–' : `${v}%`);
    });
    balance(); shake(); attitude(); redraw();
  };
}

// ---- Flight controller --------------------------------------------------------

function status(root, actions) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const checks = el('div', 'checks', main);
  const checkRows = new Map();
  const reasonsHost = el('div', 'reasons', main);
  const recheck = el('button', 'tile compact', main, t('recheck'));
  recheck.type = 'button';
  recheck.addEventListener('click', actions.recheck);

  section(main, 'secSensors');
  const grid = el('div', 'sensor-grid', main);

  const pair = el('div', 'pair', main);
  const left = el('div', null, pair), right = el('div', null, pair);
  section(left, 'flightSummary');
  const noFlight = el('p', 'soft', left, t('noFlight'));
  const flight = rows(left, [
    ['duration', () => { const f = flightStats(); return f ? clock(f.seconds) : null; }],
    ['maxAlt', () => { const f = flightStats(); return f?.top != null ? `${fixed(f.top)} m` : null; }],
    ['maxSpeed', () => { const f = flightStats(); return f?.fastest != null ? `${fixed(f.fastest)} m/s` : null; }],
    ['flownDist', () => { const f = flightStats(); return f ? distance(f.travelled) : null; }],
    ['flightDrop', () => { const f = flightStats(); return f?.drop != null ? `${f.drop.toFixed(2)} V` : null; }],
  ]);
  const exportButton = el('button', 'tile compact', left, t('exportCsv'));
  exportButton.type = 'button';
  exportButton.addEventListener('click', exportCsv);
  section(right, 'secVehicle');
  const vehicle = rows(right, [
    ['firmware', () => (store.S.fw ? `ArduCopter ${store.S.fw.join('.')}` : null)],
    ['frame', () => (store.S.params?.FRAME_CLASS === 1 && store.S.params?.FRAME_TYPE === 1 ? t('frameQuadX') : null)],
    ['uptime', () => (store.S.boot != null ? clock(store.S.boot) : null)],
    ['cpu', () => (store.S.load != null ? `${store.S.load}%` : null)],
    ['memory', () => (store.S.mem != null ? `${(store.S.mem / 1024).toFixed(1)} KB` : null)],
    ['boardPower', () => (store.S.power?.vcc != null ? `${store.S.power.vcc.toFixed(2)} V` : null)],
    ['servoPower', () => (store.S.power?.servo != null ? `${store.S.power.servo.toFixed(2)} V` : null)],
    ['usbPower', () => (store.S.power?.usb ? t('online') : null)],
    ['boots', () => (store.S.params?.STAT_BOOTCNT != null ? String(store.S.params.STAT_BOOTCNT) : null)],
    ['flownTotal', () => (store.S.params?.STAT_FLTTIME != null ? clock(store.S.params.STAT_FLTTIME) : null)],
    ['onTotal', () => (store.S.params?.STAT_RUNTIME != null ? clock(store.S.params.STAT_RUNTIME) : null)],
  ]);

  section(side, 'secLogs');
  const logsHost = el('div', 'logs', side);
  put(logsHost, t('logsLoading'));
  // The link may still be coming up, or the aircraft may be armed: keep trying while this is open.
  const loadLogs = () => actions.listLogs().then(logs => {
    if (!logsHost.isConnected) return;
    if (logs == null) {
      put(logsHost, t('logsUnavailable'));
      setTimeout(loadLogs, LOGS_RETRY_MS);
      return;
    }
    logsHost.textContent = '';
    if (!logs.length) el('p', 'soft', logsHost, t('logsNone'));
    for (const [id, size, when] of [...logs].reverse().slice(0, 6)) {
      const row = el('p', 'log-entry', logsHost);
      el('span', null, row, t('logName', { n: id }));
      el('span', size ? '' : 'amber', row, size ? `${(size / 1048576).toFixed(1)} MB` : t('logEmpty'));
      el('span', 'small soft', row, when ? new Date(when * 1000).toLocaleString(store.lang === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false }) : '');
    }
  });
  loadLogs();

  section(side, 'secMessages');
  const log = el('div', 'log', side);
  let shown = '';
  let sensorsShown = '';
  let reasonsShown = '';

  return () => {
    const items = preflight();
    const failing = items.filter(i => i.ok === false).length;
    const waiting = items.filter(i => i.ok == null).length;
    put(headline, failing ? t('checksFailing', { n: failing }) : waiting ? t('checksWaiting') : t('checksPass'));
    headline.className = `headline ${failing ? 'amber' : ''}`;
    for (const item of items) {
      let row = checkRows.get(item.key);
      if (!row) {
        const box = el('p', 'check', checks);
        row = { name: el('span', null, box, t(item.key)), detail: el('span', 'small soft', box), state: el('span', null, box) };
        checkRows.set(item.key, row);
      }
      put(row.detail, item.detail ?? '');
      put(row.state, t(item.ok == null ? 'checkWait' : item.ok ? 'checkOk' : 'checkNo'));
      row.state.className = item.ok === false ? 'amber' : item.ok == null ? 'soft' : '';
    }

    // While armed, what needs attention now. Before that, why it cannot arm.
    const reasons = store.S.armed ? alerts()
      : (prearmOk() === false ? store.S.prearm ?? [] : []).map(reason => ({ text: prearmText(store.lang, reason), tone: 'amber' }));
    const reasonKey = store.lang + JSON.stringify(reasons);
    if (reasonKey !== reasonsShown) {
      reasonsShown = reasonKey;
      reasonsHost.textContent = '';
      for (const { text, tone } of reasons) el('p', tone, reasonsHost, text);
    }
    recheck.hidden = !!store.S.armed;

    const sensors = sensorStates();
    const key = JSON.stringify(sensors) + store.lang;
    if (key !== sensorsShown) {
      sensorsShown = key;
      grid.textContent = '';
      for (const { name, state } of sensors) {
        const row = el('span', 'sensor', grid);
        el('span', null, row, name);
        el('span', state === 'bad' ? 'red-text' : 'soft', row, t({ ok: 'sensorOk', bad: 'sensorBad', off: 'sensorOff' }[state]));
      }
    }
    const f = flightStats();
    noFlight.hidden = !!f;
    exportButton.hidden = !store.history.length;
    flight(); vehicle();

    const list = store.messages;
    const stamp = `${store.lang}${list.length}${list[list.length - 1]?.[0]}${list[list.length - 1]?.[2]}`;
    if (stamp !== shown) {
      shown = stamp;
      log.textContent = '';
      if (!list.length) el('p', 'soft', log, t('none'));
      for (const [when, severity, text] of [...list].reverse()) {
        const p = el('p', null, log);
        el('time', null, p, timeOf(when));
        el('span', messageTone(severity), p, messageText(text));
      }
    }
  };
}

// ---- RC -----------------------------------------------------------------------

function rc(root) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const bars = el('div', 'bars', main);
  const slots = Array.from({ length: 12 }, (_, i) => {
    const row = el('div', 'bar-row', bars);
    const names = ['chRoll', 'chPitch', 'chThrottle', 'chYaw'];
    const label = el('span', null, row, i < 4 ? `${i + 1} ${t(names[i])}` : String(i + 1));
    const value = el('span', 'right', row);
    const track = el('span', 'track', row);
    const fill = el('span', 'fill', track);
    return { row, label, value, fill };
  });
  const list = rows(side, [
    ['rcCount', () => store.S.rc?.count ?? null],
    ['rssi', () => (rcState() === 'ok' && store.S.rc?.rssi != null ? `${Math.round(store.S.rc.rssi / 2.54)}%` : null)],
  ]);
  return () => {
    const r = store.S.rc;
    const state = rcState();
    const has = !!r?.count;
    put(headline, state ? t({ ok: 'rcConnected', none: 'rcMissing', lost: 'rcLost', unprotected: 'rcUnprotected' }[state]) : '');
    headline.className = `headline ${{ none: 'amber', lost: 'red-text', unprotected: 'amber' }[state] ?? ''}`;
    bars.classList.toggle('frozen', state === 'lost');
    slots.forEach(({ row, value, fill }, i) => {
      const pwm = has && i < r.count ? r.ch[i] : 0;
      row.hidden = !pwm;
      if (!pwm) return;
      put(value, String(pwm));
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, (pwm - 1000) / 1000))})`;
    });
    list();
  };
}

// ---- Link and onboard computer ------------------------------------------------

function link(root) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const small = () => el('div', 'chart-host tiny', main);
  section(main, 'chartWifi');
  const wifiChart = plainChart(small(), H.WIFI, 20, CHART_PAST_S, points => {
    const values = points.map(p => p[1]);
    return {
      lo: Math.min(-90, ...values), hi: Math.max(-30, ...values),
      limits: [{ v: -75, text: `${fixed(-75, 0)} dBm` }],
      format: v => `${fixed(v, 0)} dBm`,
    };
  });
  section(main, 'chartLatency');
  const latencyChart = new Chart(small());
  section(main, 'chartLoad');
  const redraw = plainChart(small(), H.LOAD, .2, CHART_PAST_S, points => ({
    lo: 0, hi: Math.max(1, ...points.map(p => p[1])),
    limits: [{ v: .7, text: '70%' }],
  }));
  section(main, 'msgRates');
  const rates = el('div', 'rates', main);

  section(side, 'secWifi');
  const wifi = () => store.S.wifi || {};
  const wifiRows = rows(side, [
    ['ssid', () => wifi().ssid ?? (store.S.wifi ? t('noWifi') : null)],
    ['signal', () => {
      const level = wifiLevel(wifi().dbm);
      return wifi().dbm != null ? `${fixed(wifi().dbm, 0)} dBm  ${t(level.word)}` : null;
    }, () => wifiLevel(wifi().dbm).tone],
    ['band', () => {
      const f = wifi().freq;
      if (!f) return null;
      return t('channelIs', { g: f < 3000 ? '2.4' : f < 5900 ? '5' : '6', c: f === 2484 ? 14 : f < 3000 ? (f - 2407) / 5 : f < 5900 ? (f - 5000) / 5 : (f - 5950) / 5 });
    }],
    ['txRate', () => (wifi().tx != null ? `${Math.round(wifi().tx)} Mbit/s` : null)],
    ['gateway', () => (store.S.gw != null ? `${Math.round(store.S.gw)} ms` : null)],
    ['lanIp', () => store.S.lan],
  ]);
  section(side, 'secTailscale');
  const tsRows = rows(side, [
    ['tsIp', () => store.S.ts?.ip],
  ]);
  const peersHost = el('dl', 'peers', side);
  let peersShown = '';

  section(side, 'secFcLink');
  const linkRows = rows(side, [
    ['rx', () => (store.S.rx ? `${(store.S.rx[0] / 1024).toFixed(1)} KB/s` : null)],
    ['linkLoad', () => (store.S.rx ? `${Math.round(store.S.rx[1] * 100)}%` : null)],
    ['baud', () => store.S.baud],
    ['latency', () => (store.S.rtt != null ? `${store.S.rtt} ms` : null)],
    ['loss', () => (store.S.loss != null ? `${fixed(store.S.loss)}%` : null), () => (store.S.loss >= LOSS_ALERT ? 'amber' : '')],
    ['pps', () => (store.S.rates ? String(Math.round(store.S.rates.reduce((a, r) => a + r[1], 0))) : null)],
    ['heartbeatAge', () => (store.S.age != null ? `${store.S.age} s` : null)],
    ['gcs', () => (store.S.gcs == null ? null : store.S.gcs ? t('online') : t('offline'))],
    ['viewersL', () => store.S.viewers],
  ]);
  section(side, 'secBoard');
  const b = () => store.S.board || {};
  const board = rows(side, [
    ['boardCpu', () => (b().cpu != null ? `${b().cpu}%` : null)],
    ['boardTemp', () => (b().temp != null ? `${b().temp} °C` : null), () => (b().temp >= 75 ? 'amber' : '')],
    ['boardMem', () => (b().mem != null ? `${b().mem}%` : null)],
    ['boardUp', () => (b().up != null ? clock(b().up) : null)],
    ['svcCpu', () => (b().own != null ? `${b().own}%` : null)],
    ['svcMem', () => (b().ownMem != null ? `${b().ownMem} MB` : null)],
  ]);
  let shown = '';
  return () => {
    const S = store.S;
    const delay = v => (v != null ? `${v} ms` : '–');
    put(headline, t('linkSummary', { a: delay(store.latency), b: delay(S.rtt) }));
    headline.className = `headline ${latencyTone(store.latency)}`;

    const points = store.latencyLog;
    const { now, past } = pastWindow(points);
    latencyChart.draw({
      points, now, past, lo: 0, hi: Math.max(100, ...points.map(p => p[1])),
      labels: { start: minutesAgo(past), now: t('now') }, format: v => `${Math.round(v)} ms`,
    });
    wifiChart(); redraw(); wifiRows(); tsRows(); linkRows(); board();

    const peers = S.ts?.peers ?? [];
    const peersKey = store.lang + JSON.stringify(peers);
    if (peersKey !== peersShown) {
      peersShown = peersKey;
      peersHost.textContent = '';
      if (!peers.length && S.ts) el('dd', 'soft wide', peersHost, t('tsNoPeers'));
      for (const [name, direct, relay] of peers) {
        el('dt', null, peersHost, name);
        el('dd', direct ? '' : 'amber', peersHost, direct ? t('tsDirect') : relay ? t('tsRelayVia', { r: relay }) : t('tsRelay'));
      }
    }

    const key = JSON.stringify(S.rates);
    if (key !== shown) {
      shown = key;
      rates.textContent = '';
      for (const [kind, hz] of S.rates ?? []) {
        const row = el('span', 'rate', rates);
        el('span', 'soft', row, kind);
        el('span', null, row, t('hz', { v: hz.toFixed(1) }));
      }
    }
  };
}

// ---- What is stored on the flight controller ----------------------------------

function itemDetail(item) {
  const p = item.p;
  switch (item.cmd) {
    case CMD.LOITER_TIME: return p[0] ? t('itemSeconds', { n: Math.round(p[0]) }) : '';
    case CMD.LOITER_TURNS: return p[0] ? t('itemTurns', { n: Math.round(p[0]) }) : '';
    case CMD.DO_CHANGE_SPEED: return p[1] > 0 ? `${fixed(p[1])} m/s` : '';
    case CMD.DO_JUMP: return t('itemJump', { to: Math.round(p[0]), n: Math.round(p[1]) });
    case CMD.CONDITION_DELAY: return t('itemSeconds', { n: Math.round(p[0]) });
    case CMD.CONDITION_YAW: return `${Math.round(p[0])}°`;
    default: return '';
  }
}

const fenceAltitude = v => (v == null ? null : `${Math.round(v)} m`);

function plan(root, actions) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const caption = el('p', 'caption', main);
  const list = el('div', 'items', main);
  section(side, 'secFence');
  const none = el('p', 'soft', side, t('fenceNone'));
  const fence = rows(side, [
    ['health', () => fenceState()?.text, () => fenceState()?.tone],
    ['fenceAction', () => { const a = store.S.params?.FENCE_ACTION; return a != null ? t(FENCE_ACTIONS[a] ?? 'fenceActOther') : null; }],
    ['fenceCeiling', () => (store.S.params?.FENCE_TYPE & 1 ? fenceAltitude(store.S.params?.FENCE_ALT_MAX) : null)],
    ['fenceRadius', () => (store.S.params?.FENCE_TYPE & 2 ? fenceAltitude(store.S.params?.FENCE_RADIUS) : null)],
    ['fencePolygons', () => {
      const s = planShapes(store.S);
      if (!s.polygons.length) return null;
      const inside = s.polygons.filter(p => p.inside).length, outside = s.polygons.length - inside;
      const parts = [inside && t('polyInside', { n: inside }), outside && t('polyOutside', { n: outside })].filter(Boolean);
      return `${joined(parts)}${s.polygonsOn ? '' : `  ${t('polyUnused')}`}`;
    }],
    ['fenceCircles', () => { const n = planShapes(store.S).circles.length; return n || null; }],
    ['fenceBreaches', () => store.S.fence?.count || null],
  ]);
  section(side, 'secRally');
  const rally = el('div', 'items', side);
  const refresh = el('button', 'tile compact', side, t('planRefresh'));
  refresh.type = 'button';
  refresh.addEventListener('click', actions.refreshPlan);
  const onMap = el('button', 'tile compact', side, t('editOnMap'));
  onMap.type = 'button';
  onMap.addEventListener('click', actions.openPlanEditor);
  let shownKey = '', rallyKey = '';

  return () => {
    const S = store.S;
    const shapes = planShapes(S);
    const mission = S.plan?.mission;
    const items = (mission?.items ?? []).slice(1);
    const current = S.mission?.[0] ?? 0;
    const points = [shapes.route.start, ...shapes.route.points].filter(Boolean);
    let length = 0, top = 0;
    points.forEach((p, i) => {
      top = Math.max(top, p.alt);
      if (!i) return;
      const a = points[i - 1];
      length += Math.hypot((p.lat - a.lat) * 111320, (p.lon - a.lon) * 111320 * Math.cos(p.lat * Math.PI / 180));
    });
    put(headline, S.plan ? (items.length ? t('planSummary', { n: items.length, d: distance(length), h: Math.round(top) }) : t('planNone')) : t('logsLoading'));

    const errors = Object.entries(S.plan ?? {}).filter(([, e]) => e.err);
    const when = mission?.at ? timeOf(mission.at) : null;
    put(caption, S.plan_busy ? t('planReading') : errors.length ? t('planReadFailed') : when ? t('planReadAt', { t: when, state: MISSION_STATES[store.lang][S.mission?.[2]] ?? '' }) : '');
    caption.className = `caption ${errors.length ? 'amber' : 'soft'}`;

    const next = nextPoint(shapes, current);
    const key = store.lang + JSON.stringify(items) + (next?.seq ?? '');
    if (key !== shownKey) {
      shownKey = key;
      list.textContent = '';
      const legs = new Map();
      let last = shapes.route.start;
      for (const p of shapes.route.points) {
        if (p.seq != null && last) legs.set(p.seq, Math.hypot((p.lat - last.lat) * 111320, (p.lon - last.lon) * 111320 * Math.cos(p.lat * Math.PI / 180)));
        last = p;
      }
      const heights = new Map(shapes.route.points.map(p => [p.seq, p.alt]));
      if (items.length) {
        const head = el('p', 'item small soft', list);
        for (const key of ['itemSeq', 'itemWhat', 'itemDetail', 'itemHeight']) el('span', key === 'itemHeight' ? 'right' : null, head, t(key));
      }
      for (const item of items) {
        const row = el('p', `item${next?.seq === item.seq ? ' next' : ''}`, list);
        el('span', 'soft', row, String(item.seq));
        el('span', null, row, CMD_NAMES[store.lang][item.cmd] ?? `#${item.cmd}`);
        el('span', 'soft', row, itemDetail(item) || (legs.has(item.seq) && legs.get(item.seq) >= 1 ? distance(legs.get(item.seq)) : ''));
        el('span', 'right', row, heights.has(item.seq) ? `${Math.round(heights.get(item.seq))} m` : '');
      }
    }
    fence();
    none.hidden = !!fenceState();
    const rallyNow = store.lang + JSON.stringify(shapes.rally);
    if (rallyNow !== rallyKey) {
      rallyKey = rallyNow;
      rally.textContent = '';
      if (!shapes.rally.length) el('p', 'soft', rally, t('rallyNone'));
      for (const r of shapes.rally) {
        const row = el('p', 'item', rally);
        el('span', 'soft', row, `R${r.n}`);
        el('span', null, row, `${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`);
        el('span', 'soft', row, '');
        el('span', 'right', row, `${Math.round(r.alt)} m`);
      }
    }
  };
}

export const PAGES = {
  plan: { title: 'pagePlan', build: plan },
  battery: { title: 'pageBattery', build: battery },
  altitude: { title: 'pageAltitude', build: altitude },
  speed: { title: 'pageSpeed', build: speed },
  position: { title: 'pagePosition', build: position },
  airframe: { title: 'pageAirframe', build: airframe },
  status: { title: 'pageStatus', build: status },
  rc: { title: 'pageRc', build: rc },
  link: { title: 'pageLink', build: link },
};

export { navSummary, vibSummary };
