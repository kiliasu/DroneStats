import { Scene } from '/scene.js';
import { TileMap } from '/map.js';
import { spark } from '/chart.js';
import { PAGES, navSummary, vibSummary } from '/pages.js';
import { control } from '/control.js';
import { mapUi } from '/mapui.js';
import { planShapes, pointLabel } from '/plan.js';
import { MODES, COMPASS, STRINGS } from '/i18n.js';
import { predictFlight } from '/predict.js';
import {
  $, H, LOSS_ALERT, aboveHome, batteryLevel, clock, distance, etaText, extendTrail, fenceState, fixed, fromHere, fromHome, gpsSummary, isOld, joined, latencyTone,
  limitName, live, localFrame, messageText, messageTone, motorTone, motorsInUse, nextLimit, put, rcState, rebuildTrail, resetTrail, sensorBad, series,
  statusText, store, t, tailscalePath, timeOf, timeTo, toLocal, voltageTrend, wifiLevel,
} from '/shared.js';

PAGES.control = { title: 'pageControl', build: control };

const params = new URLSearchParams(location.search);
const rad = Math.PI / 180;

let execToken = null;
let viewerId = null;        // this page's identity on the server, renewed with each connection
let lastSeq = 0;            // the newest frame seen, sent with commands as proof of live data
let lastFrameAt = 0;        // by the wall clock, which keeps counting while a phone sleeps
let lastRestart = 0;
let frameLimit = 0;         // how long this page may go without a frame before starting again
let page = null;            // the expanded view on screen, as { id, refresh }

const scene = new Scene($('scene'), $('labels'), $('world'), {
  fixedQuality: params.has('q'),
  fakeTime: params.has('at') ? Date.parse(params.get('at')) : undefined,
});
let ui = null;              // what can be done with the things on the map
let proposal = null;        // a flight command being looked at before it is sent
const map = new TileMap($('map'), {
  onChange: () => renderViewTools(),
  onTap: (at, always) => {
    if (proposal) closeProposal();
    else if (sheetOpen()) setSheet(null);
    else ui.tap(at, always);
  },
  onObject: (ref, type) => {
    if (!proposal) ui.object(ref, type);
    else if (type === 'tap') closeProposal();
  },
  onDrag: (ref, at, phase) => { if (!proposal) ui.drag(ref, at, phase); },
  onMoved: () => ui?.moved(),
});

// ---- Heads-up display -------------------------------------------------------

function renderStatus() {
  const S = store.S;
  const s = statusText();
  const armedEl = $('armed'), reason = $('reason');
  put(armedEl, s.state);
  armedEl.className = s.tone;
  put($('mode'), s.mode);
  put($('sim'), S.sim ? t('simulated') : '');
  put($('timer'), s.timer);
  put(reason, s.why);
  reason.className = s.whyTone;
  const title = S.volts != null && live() ? `${s.state} ${S.volts.toFixed(2)} V` : 'DroneStats';
  document.title = S.sim ? `${t('simulated')} ${title}` : title;
  const resuming = !live() && Date.now() < store.resumingUntil;
  put($('link'), live() ? t('linkOk') : resuming ? t('linkResuming') : t('linkBad'));
  $('link').className = `tap ${live() || resuming ? 'soft' : 'red-text'}`;
  document.documentElement.classList.toggle('stale', !live());
  document.documentElement.classList.toggle('armed', !!S.armed);
}

const VALUE_SOURCES = {
  alt: 'GLOBAL_POSITION_INT', speed: 'VFR_HUD', heading: 'VFR_HUD', volts: 'SYS_STATUS', tilt: 'ATTITUDE',
  sats: 'GPS_RAW_INT', fix: 'GPS_RAW_INT',
};

function renderValues() {
  const S = store.S;
  const hud = S.hud, pos = S.pos, att = S.att;
  put($('alt'), fixed(pos ? pos[3] : null));
  put($('speed'), fixed(hud ? hud[0] : null));
  const hudCurrent = hud && !isOld('VFR_HUD');
  const climb = hud?.[1] ?? 0;
  put($('climb'), !hudCurrent ? '' : Math.abs(climb) < .15 ? t('level') : t(climb > 0 ? 'climbUp' : 'climbDown', { v: `${fixed(Math.abs(climb))} m/s` }));
  put($('throttle'), hudCurrent ? t('throttleIs', { v: hud[2] }) : '');

  put($('volts'), fixed(S.volts, 2));
  const level = batteryLevel();
  const block = $('volts').closest('.metric');
  block.classList.toggle('warn', level?.tone === 'warn');
  block.classList.toggle('bad', level?.tone === 'bad');
  put($('cell'), S.volts == null ? '' : t('perCell', { v: (S.volts / (S.cells || 2)).toFixed(2) }));
  put($('margin'), isOld('SYS_STATUS') ? '' : batteryNote(level));

  const heading = hud ? hud[3] : pos && pos[7] != null ? Math.round(pos[7]) : null;
  put($('heading'), heading == null ? '–' : `${heading}°`);
  put($('cardinal'), heading == null ? '' : COMPASS[store.lang][Math.round(heading / 45) % 8]);
  put($('tilt'), att ? t('tilt', { r: fixed(att[0] * 180 / Math.PI), p: fixed(att[1] * 180 / Math.PI) }) : '');

  const g = S.gps;
  put($('sats'), g?.sats != null ? t('sats', { n: g.sats }) : '');
  const summary = gpsSummary();
  put($('fix'), g ? summary.text : '');
  $('fix').className = summary.tone;
  put($('hdop'), g?.hdop != null && g.fix >= 2 ? `HDOP ${g.hdop.toFixed(1)}` : '');
  // Where home lies, from the way the aircraft is facing.
  const home = fromHome();
  const showHome = home && home.metres >= 3 && att && !isOld('GLOBAL_POSITION_INT');
  $('home-dir').hidden = !showHome;
  if (showHome) {
    $('home-arrow').style.transform = `rotate(${((home.bearing - att[2]) * 180 / Math.PI).toFixed(0)}deg)`;
    put($('home-dist'), t('home', { d: distance(home.metres) }));
  }
  // And where it is heading, while it is flying to something.
  const goal = S.armed && att && !isOld('GLOBAL_POSITION_INT') ? fromHere(S.target) : null;
  const showGoal = goal && goal.metres >= 1;
  $('wp-dir').hidden = !showGoal;
  document.documentElement.classList.toggle('has-goal', !!showGoal);
  if (showGoal) {
    $('wp-arrow').style.transform = `rotate(${((goal.bearing - att[2]) * 180 / Math.PI).toFixed(0)}deg)`;
    put($('wp-dist'), S.pending ? t('toTargetLand', { d: distance(goal.metres) })
      : S.mode === 3 && S.mission ? t('toItem', { n: S.mission[0], d: distance(goal.metres) }) : t('toTarget', { d: distance(goal.metres) }));
  }
  put($('map-nofix'), pos && pos[0] != null ? '' : t('noFixMap'));

  // A value that has stopped updating must not look current.
  for (const [id, kind] of Object.entries(VALUE_SOURCES)) $(id).classList.toggle('old', isOld(kind));

  const motors = S.motors || [];
  const inUse = motorsInUse(S);
  document.querySelectorAll('#reticle .out').forEach(ring => {
    const v = motors[+ring.dataset.motor];
    const length = 2 * Math.PI * 16;
    const on = v == null ? 0 : v / 100;
    ring.style.strokeDasharray = `${(on * length).toFixed(1)} ${length.toFixed(1)}`;
    const number = ring.nextElementSibling;
    ring.setAttribute('class', `out ${motorTone(v)}`);
    number.setAttribute('class', `pct ${motorTone(v)}`);
    put(number, inUse && v != null ? String(v) : '');
  });
}

const narrow = matchMedia('(max-width: 720px)');

function batteryNote(level) {
  const S = store.S;
  if (S.volts == null) return '';
  if (level?.note) return level.note;
  const next = nextLimit();
  if (!next) return '';
  const margin = t('toLimit', { what: limitName(next.key, true), v: (S.volts - next.v).toFixed(2) });
  const eta = narrow.matches ? '' : etaText(timeTo(next, voltageTrend()));
  return eta ? `${margin}${store.lang === 'zh' ? '，' : ', '}${eta}` : margin;
}

function renderStack() {
  const S = store.S;
  const set = (id, text, tone = '', kind) => {
    put($(id), text ?? '–');
    $(id).className = kind && isOld(kind) ? 'soft' : tone;
  };
  const rc = rcState();
  if (rc == null) set('st-rc', null);
  else if (rc === 'none') set('st-rc', t('rcNone'), 'amber', 'SYS_STATUS');
  else if (rc === 'lost') set('st-rc', t('rcLostShort'), 'red-text', 'SYS_STATUS');
  else if (rc === 'unprotected') set('st-rc', t('rcOffShort'), 'amber', 'SYS_STATUS');
  else set('st-rc', S.rc?.rssi != null ? `${Math.round(S.rc.rssi / 2.54)}%` : t('linkOk'), '', 'SYS_STATUS');
  const nav = navSummary();
  set('st-nav', nav?.text, nav?.tone, 'EKF_STATUS_REPORT');
  const vib = vibSummary();
  set('st-vib', vib?.text, vib?.tone, 'VIBRATION');
  const bad = sensorBad();
  if (!S.sens) set('st-sens', null);
  else if (bad.length) set('st-sens', t('faultCount', { n: bad.length }), 'red-text', 'SYS_STATUS');
  else set('st-sens', t('sensorOk'), '', 'SYS_STATUS');
  const temp = S.board?.temp;
  set('st-board', temp != null ? `${temp} °C` : null, temp >= 75 ? 'amber' : '');

  const wifi = S.wifi, level = wifiLevel(wifi?.dbm);
  $('row-wifi').hidden = wifi === null || wifi === false;
  put($('st-ssid'), wifi === undefined ? '–' : wifi?.ssid ?? t('noWifi'));
  put($('st-dbm'), wifi?.dbm != null ? `${fixed(wifi.dbm, 0)} dBm` : '');
  $('st-wifi').className = wifi?.ssid === null ? 'amber' : level.tone;
  $('wifi-bars').toggleAttribute('hidden', wifi?.dbm == null);
  [...$('wifi-bars').children].forEach((bar, i) => bar.classList.toggle('on', i < level.bars));
  const path = tailscalePath();
  $('row-ts').hidden = !path;
  if (path) set('st-ts', path.text, path.tone);
  set('st-latency', store.latency != null ? `${store.latency} ms` : null, latencyTone(store.latency));
  const lost = S.loss >= 1 ? t('lossIs', { n: Math.round(S.loss) }) : '';
  const delay = S.rtt != null ? `${S.rtt} ms` : '';
  set('st-fc', [delay, lost].filter(Boolean).join('  ') || null, S.loss >= LOSS_ALERT ? 'amber' : '');
  $('row-gcs').hidden = !S.gcs;
  if (S.gcs) set('st-gcs', t('online'));

  const fence = fenceState();
  $('row-fence').hidden = !fence;
  $('row-fence').classList.toggle('keep', fence?.tone === 'red-text');    // where room is short, only if it matters
  if (fence) set('st-fence', fence.text, fence.tone);
  const items = Math.max((S.plan?.mission?.items?.length ?? 0) - 1, 0);
  $('row-mission').hidden = !items;
  if (items) set('st-mission', S.armed && S.mission?.[0] ? `${S.mission[0]} / ${items}` : t('itemCount', { n: items }));
}

let trailLocal = null, trailShown = -1;
let planLocal = null, planFor = '';
const NO_NOTES = [];

// What is stored, what is being edited and the viewers' marks, in the world's metres.
function localPlan(s, draft, notes) {
  const key = `${s.version}|${draft?.version}|${JSON.stringify(notes)}`;
  if (planFor === key) return planLocal;
  planFor = key;
  const point = (p, label) => ({ ...p, n: toLocal(p.lat, p.lon)[0], e: toLocal(p.lat, p.lon)[1], label });
  const routeOf = route => [route.start, ...route.points].filter(Boolean).map(p => point(p, p.seq != null ? pointLabel(p) : ''));
  planLocal = {
    route: routeOf(s.route),
    draft: draft?.route ? routeOf(draft.route) : null,
    polygons: s.polygons.map(({ points, inside }) => ({ inside, points: points.map(([lat, lon]) => toLocal(lat, lon)) })),
    circles: s.circles.map(c => ({ inside: c.inside, radius: c.radius, at: toLocal(c.at[0], c.at[1]) })),
    cylinder: s.cylinder ? { radius: s.cylinder.radius, at: toLocal(s.cylinder.at[0], s.cylinder.at[1]) } : null,
    ceiling: s.ceiling, enabled: s.enabled, polygonsOn: s.polygonsOn,
    rally: (draft?.rally ?? s.rally).map(r => point(r, `R${r.n}`)),
    notes: notes.map(m => ({ name: m.name, n: toLocal(m.lat, m.lon)[0], e: toLocal(m.lat, m.lon)[1] })),
  };
  return planLocal;
}

function renderScene() {
  const S = store.S;
  if (S.att) scene.setAttitude(S.att);
  scene.setMotors(motorsInUse(S) ? S.motors.map(v => (v == null ? null : [v, motorTone(v)])) : null);
  if (S.pos) {
    scene.setMotion(S.pos[3], S.pos[4], S.pos[5]);
    scene.setPlace(S.pos[0], S.pos[1]);
  }
  scene.setLive(live() && !isOld('ATTITUDE'));
  const home = fromHome();
  scene.setHome(home && home.metres >= 3 ? home.bearing : null, home ? t('home', { d: distance(home.metres) }) : '');
  const has = S.pos && S.pos[0] != null;
  // The world's own frame: metres from the page's origin.
  const origin = localFrame();
  if (origin && has) scene.setPosition(...toLocal(S.pos[0], S.pos[1]));
  else scene.setPosition(null);
  scene.setHomePoint(origin && S.home ? toLocal(S.home[0], S.home[1]) : null);
  if (origin && trailShown !== store.trailVersion) {
    trailShown = store.trailVersion;
    trailLocal = store.trail.map(p => [...toLocal(p[0], p[1]), p[2], p[3]]);
  }
  scene.setTrail(origin ? trailLocal : null);
  const heading = S.att ? (S.att[2] * 180 / Math.PI + 360) % 360 : 0;
  map.update(has ? S.pos[0] : null, has ? S.pos[1] : null, heading, S.home ? [S.home[0], S.home[1]] : null, store.trail, store.trailVersion);

  const shapes = planShapes(S);
  const draft = ui.draftShapes();
  const notes = shown.notes ? S.marks ?? NO_NOTES : NO_NOTES;
  scene.setPlan(localFrame() ? localPlan(shapes, draft, notes) : null, shown);
  map.setPlan(shapes, shown);
  map.setDraft(draft);
  map.setNotes(notes);
  const target = S.armed ? S.target : null;
  const item = S.mission?.[0] ?? 0;
  map.setProgress(item, target ? [target[0], target[1]] : null);
  scene.setProgress(item, target && localFrame() ? [...toLocal(target[0], target[1]), aboveHome(target[2], target[3])] : null);
  renderPlanCounts(shapes);
}

const SPARK_S = 300;
function renderSparks() {
  spark($('spark-alt'), series(H.ALT, SPARK_S), 1);
  spark($('spark-speed'), series(H.SPEED, SPARK_S), 1);
  spark($('spark-volts'), series(H.VOLTS, SPARK_S), .1);
}

// ---- Messages ---------------------------------------------------------------

const FEED_LINES = 3;
const FEED_AGE_S = 30;

function renderFeed() {
  const now = Date.now() / 1000;
  // Pre-arm reasons already appear beside the state.
  const recent = store.messages
    .filter(([when, , text]) => now - when < FEED_AGE_S && (store.S.armed || !text.startsWith('PreArm:')))
    .slice(-FEED_LINES);
  const feed = $('feed');
  while (feed.children.length > recent.length) feed.firstElementChild.remove();
  while (feed.children.length < recent.length) feed.append(document.createElement('span'));
  recent.forEach(([, severity, text], i) => {
    const line = feed.children[i];
    put(line, messageText(text));
    const tone = messageTone(severity);
    line.className = tone || (i === recent.length - 1 ? '' : 'soft');
  });
}

let noticeTimer;
function showNotice(text, tone) {
  const el = $('message');
  put(el, text);
  el.className = tone;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add('gone'), 6000);
}

// ---- Expanded views ---------------------------------------------------------

const pageActions = {
  recheck: async () => {
    const r = await post('/api/prearm').catch(() => ({}));
    showNotice(r.ok ? t('checking') : t('errBusy'), '');
  },
  listLogs: async () => {
    const r = await post('/api/logs').catch(() => ({}));
    return r.logs ?? null;
  },
  refreshPlan: async () => {
    const r = await post('/api/plan/refresh').catch(() => ({}));
    showNotice(r.ok ? t('planReading') : t('errBusy'), '');
  },
  catalog: () => catalog(),
  run: (...args) => run(...args),
  execOn: () => !!execToken,
  holdButton: (...args) => holdButton(...args),
  pressButton: (...args) => pressButton(...args),
  openExec: () => openExec(),
  closeExec: () => leaveExec(),
  notice: (text, tone) => showNotice(text, tone),
  post: (...args) => post(...args),
  openMap: () => {
    goTo(null);
    if (!mapMain()) setMapMain(true);
  },
  openPlanEditor: () => {
    pageActions.openMap();
    ui.openEditor();
  },
};

// The server's table of actions, asked for once.
let catalogAsked = null;
function catalog() {
  catalogAsked ??= fetch('/api/commands', { signal: AbortSignal.timeout(5000) })
    .then(r => r.json()).then(r => r.commands)
    .catch(() => { catalogAsked = null; return null; });
  return catalogAsked;
}

function showPage(id) {
  const definition = Object.hasOwn(PAGES, id) ? PAGES[id] : null;
  if (definition) closeProposal();
  const root = document.documentElement;
  document.querySelectorAll('[data-page]').forEach(b => {
    const selected = b.dataset.page === id;
    b.classList.toggle('selected', selected);
    b.setAttribute('aria-expanded', String(selected));
  });
  if (!definition) {
    page = null;
    root.classList.remove('focus', 'control-page');
    $('focus').hidden = true;
    $('focus-body').textContent = '';
    scene.setDim(false);
    renderSparks();
    ui?.refresh();
    return;
  }
  setSheet(null);
  root.classList.add('focus');
  root.classList.toggle('control-page', id === 'control');
  $('focus').hidden = false;
  $('focus').scrollTop = 0;
  put($('focus-title'), t(definition.title));
  $('focus-body').textContent = '';
  page = { id, refresh: definition.build($('focus-body'), pageActions) };
  scene.setDim(true);
  page.refresh();
  ui?.refresh();
}

// The address carries the open view, so the back button closes it and a reload keeps it.
const pageFromAddress = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''));
window.addEventListener('hashchange', () => showPage(pageFromAddress()));
const goTo = id => { location.hash = id ? `/${id}` : ''; };

document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-page]');
  if (!trigger) return;
  goTo(page?.id === trigger.dataset.page ? null : trigger.dataset.page);
});
$('focus-close').addEventListener('click', () => goTo(null));
$('focus').addEventListener('click', e => { if (e.target === $('focus') || e.target === $('focus-body')) goTo(null); });

// ---- Details ----------------------------------------------------------------

const S = () => store.S;
const ROWS = [
  ['secVehicle', [
    ['firmware', () => (S().fw ? `ArduCopter ${S().fw.join('.')}` : null)],
    ['frame', () => (S().params?.FRAME_CLASS === 1 && S().params?.FRAME_TYPE === 1 ? t('frameQuadX') : null)],
    ['uptime', () => (S().boot != null ? clock(S().boot) : null)],
    ['cpu', () => (S().load != null ? `${S().load}%` : null)],
    ['memory', () => (S().mem != null ? `${(S().mem / 1024).toFixed(1)} KB` : null)],
    ['mission', () => (S().mission?.[1] ? `${S().mission[0]} / ${S().mission[1]}` : null)],
  ]],
  ['secBattery', [
    ['voltage', () => (S().volts != null ? `${S().volts.toFixed(2)} V` : null)],
    ['cellVoltage', () => (S().volts != null ? `${(S().volts / S().cells).toFixed(2)} V` : null)],
    ['armVoltage', () => (S().params?.BATT_ARM_VOLT ? `${S().params.BATT_ARM_VOLT.toFixed(2)} V` : null)],
    ['lowVoltage', () => (S().params?.BATT_LOW_VOLT ? `${S().params.BATT_LOW_VOLT.toFixed(2)} V` : null)],
    ['critVoltage', () => (S().params?.BATT_CRT_VOLT ? `${S().params.BATT_CRT_VOLT.toFixed(2)} V` : null)],
    ['current', () => (S().amps != null ? `${fixed(S().amps)} A` : null)],
  ]],
  ['secPosition', [
    ['fixType', () => (S().gps ? (S().gps.fix >= 3 ? '3D' : S().gps.fix === 2 ? '2D' : t('noFix')) : null)],
    ['satellites', () => S().gps?.sats],
    ['hdop', () => S().gps?.hdop?.toFixed(1)],
    ['hAcc', () => (S().gps?.hacc != null ? `${S().gps.hacc.toFixed(1)} m` : null)],
    ['vAcc', () => (S().gps?.vacc != null ? `${S().gps.vacc.toFixed(1)} m` : null)],
    ['latlon', () => (S().pos?.[0] != null ? `${S().pos[0].toFixed(6)}, ${S().pos[1].toFixed(6)}` : null)],
    ['msl', () => (S().pos?.[2] != null ? `${S().pos[2].toFixed(1)} m` : null)],
    ['relHome', () => { const h = fromHome(); return h ? distance(h.metres) : null; }],
    ['ekf', () => navSummary()?.text],
  ]],
  ['secSensors', [
    ['health', () => { if (!S().sens) return null; const bad = sensorBad(); return bad.length ? joined(bad) : t('allOk'); }],
    ['roll', () => (S().att ? `${fixed(S().att[0] * 180 / Math.PI)}°` : null)],
    ['pitch', () => (S().att ? `${fixed(S().att[1] * 180 / Math.PI)}°` : null)],
    ['headingL', () => (S().hud ? `${S().hud[3]}°` : null)],
    ['vibration', () => (S().vib ? S().vib.xyz.map(v => fixed(v)).join('  ') : null)],
    ['clip', () => S().vib?.clip],
    ['pressure', () => (S().baro ? `${S().baro[0].toFixed(1)} hPa` : null)],
    ['baroTemp', () => (S().baro ? `${S().baro[1].toFixed(1)} °C` : null)],
    ['imuTemp', () => (S().imu_t != null ? `${S().imu_t.toFixed(1)} °C` : null)],
  ]],
  ['secMotors', [0, 1, 2, 3].map(i => [() => t('motor', { n: i + 1 }), () => (S().motors?.[i] != null ? `${S().motors[i]}%` : null)])],
  ['secRc', [
    ['health', () => ({ ok: t('linkOk'), none: t('rcNone'), lost: t('rcLostShort'), unprotected: t('rcOffShort') }[rcState()] ?? null)],
    ['rcCount', () => (S().rc?.count ? S().rc.count : null)],
    ['rssi', () => (rcState() === 'ok' && S().rc?.rssi != null ? `${Math.round(S().rc.rssi / 2.54)}%` : null)],
  ]],
  ['secLink', [
    ['ssid', () => S().wifi?.ssid],
    ['signal', () => (S().wifi?.dbm != null ? `${fixed(S().wifi.dbm, 0)} dBm` : null)],
    ['stackLatency', () => (store.latency != null ? `${store.latency} ms` : null)],
    ['stackFc', () => (S().rtt != null ? `${S().rtt} ms` : null)],
    ['rx', () => (S().rx ? `${(S().rx[0] / 1024).toFixed(1)} KB/s, ${Math.round(S().rx[1] * 100)}%` : null)],
    ['gcs', () => (S().gcs == null ? null : S().gcs ? t('online') : t('offline'))],
  ]],
];

const rowBindings = [];
let logShown = '';

function buildDetails() {
  const root = $('sections');
  root.textContent = '';
  rowBindings.length = 0;
  for (const [title, rows] of ROWS) {
    const section = document.createElement('section');
    section.className = 'group';
    const h = document.createElement('h2');
    h.textContent = t(title);
    const dl = document.createElement('dl');
    section.append(h, dl);
    for (const [label, read] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = typeof label === 'function' ? label() : t(label);
      const dd = document.createElement('dd');
      dl.append(dt, dd);
      rowBindings.push([dt, dd, read]);
    }
    root.append(section);
  }
  const log = document.createElement('section');
  log.className = 'group';
  const h = document.createElement('h2');
  h.textContent = t('secMessages');
  const list = document.createElement('div');
  list.className = 'log';
  list.id = 'log';
  log.append(h, list);
  root.append(log);
}

function renderDetails() {
  if (!$('details').classList.contains('open')) return;
  for (const [dt, dd, read] of rowBindings) {
    const value = read();
    const has = value != null && value !== '';
    dt.hidden = dd.hidden = !has;
    if (has) put(dd, String(value));
  }
  const messages = store.messages;
  const key = `${store.lang}${messages.length}${messages[messages.length - 1]?.[0]}`;
  if (key !== logShown) {
    logShown = key;
    const list = $('log');
    list.textContent = '';
    if (!messages.length) {
      const p = document.createElement('p');
      p.textContent = t('none');
      p.className = 'soft';
      list.append(p);
    }
    for (const [when, severity, text] of [...messages].reverse().slice(0, 30)) {
      const p = document.createElement('p');
      const time = document.createElement('time');
      time.textContent = timeOf(when);
      const span = document.createElement('span');
      span.textContent = messageText(text);
      span.className = messageTone(severity);
      p.append(time, span);
      list.append(p);
    }
  }
}

// The two sheets that slide in from the side: readings, and settings. One at a time.
const SHEETS = ['details', 'settings'];
function sheetOpen() {
  return SHEETS.some(id => $(id).classList.contains('open'));
}
function setSheet(name) {
  if (name) closeProposal();
  for (const id of SHEETS) {
    const el = $(id), open = id === name;
    el.classList.toggle('open', open);
    el.setAttribute('aria-hidden', String(!open));
    el.inert = !open;
  }
  if (name && page) goTo(null);
  renderDetails();
}

// ---- Execution --------------------------------------------------------------

// Every command runs on a plain press. One that would take the aircraft somewhere is shown on the
// main page first and sent from there by a second press, and that look at it is the confirmation.
// `prepare` runs at the press and fixes what it will do; it may return null to refuse. While what a
// press started is still running, further presses do nothing, so a double tap sends one command.
function pressButton(el, prepare) {
  let busy = false;
  el.addEventListener('click', async e => {
    e.preventDefault();
    if (el.disabled || busy) return;
    const action = prepare();
    if (!action) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  });
}

// Only turning execution on is held, since that is what lets any of the rest reach the aircraft.
// It fires after the button has been held down for the whole of `ms`. The timer decides; the
// animation only shows progress, so a slow screen cannot change what a hold means.
function holdButton(el, ms, prepare) {
  let frame, timer, start, held;
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    start = null;
    el.style.setProperty('--p', 0);
    el.classList.remove('holding');
  };
  const paint = () => {
    if (start == null) return;
    el.style.setProperty('--p', Math.min((performance.now() - start) / held, 1));
    frame = requestAnimationFrame(paint);
  };
  const begin = () => {
    if (el.disabled || start != null) return;
    const action = prepare();
    if (!action) return;
    start = performance.now();
    held = typeof ms === 'function' ? ms() : ms;
    el.classList.add('holding');
    paint();
    timer = setTimeout(() => {
      stop();
      action();
    }, held);
  };
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    begin();
  });
  el.addEventListener('pointermove', e => {
    if (start == null) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) stop();
  });
  // Let go too soon, and it says why nothing happened.
  el.addEventListener('pointerup', () => {
    if (start != null) showNotice(t('holdHint'), '');
    stop();
  });
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(); } });
  el.addEventListener('keyup', stop);
  el.addEventListener('blur', stop);
}

async function post(path, body = {}, timeoutMs = 5000) {
  const headers = { 'Content-Type': 'application/json' };
  if (execToken) headers['X-Exec-Token'] = execToken;
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

const ERRORS = {
  in_air: 'errInAir', armed: 'errArmed', no_link: 'errLink', token: 'errToken', busy: 'errBusy',
  stale: 'errStale', held: 'errHeld', viewer: 'errStale', bad_param: 'errParam',
};
const errorText = code => {
  if (ERRORS[code]) return t(ERRORS[code]);
  return STRINGS[store.lang][`why_${code}`] ?? t('errOther');
};

// Long enough for the flight controller's reply and for the effect to show in the telemetry.
const RUN_TIMEOUT_MS = 15000;

// A command that would take the aircraft somewhere does not leave on the first hold. The main page shows
// the way it would go, and it is sent from there, by a second hold, once that has been looked at.
function run(action, label, params = {}, timeoutMs = RUN_TIMEOUT_MS) {
  if (!predictFlight(action, params)) return send(action, label, params, timeoutMs);
  proposal = { action, label, params, timeoutMs };
  setSheet(null);
  ui.closeCard();
  if (page) goTo(null);
  renderProposal();
  measureHud();
  return Promise.resolve(null);
}

function closeProposal() {
  if (!proposal) return;
  proposal = null;
  map.setPrediction(null);
  scene.setPrediction(null);
  $('predict').hidden = true;
  renderExec();
  measureHud();
}

function renderProposal() {
  if (!proposal) return;
  const flight = execToken ? predictFlight(proposal.action, proposal.params) : null;
  if (!flight) {
    closeProposal();        // execution has closed, or the aircraft is no longer where this could start
    return;
  }
  const end = flight.lands ? t('predictDown') : t('predictEnd', { h: distance(flight.end.alt) });
  const parts = [...(flight.metres >= 1 ? [distance(flight.metres)] : []), t('predictAbout', { t: clock(flight.seconds) }), end];
  const comma = store.lang === 'zh' ? '，' : ', ';
  put($('predict-note'), `${proposal.label}${store.lang === 'zh' ? '：' : ': '}${parts.join(comma)}`);
  const avail = store.S.avail ?? {};
  const why = proposal.action === 'mode' ? avail.mode?.[proposal.params.mode] : avail[proposal.action];
  put($('predict-warn'), why ? t(`why_${why}`) : flight.outside ? t('predictOutside') : '');
  $('predict-go').disabled = !!why;
  put($('predict-go').firstElementChild, t('predictGo'));
  put($('predict-cancel'), t('predictCancel'));
  $('predict').dataset.flight = JSON.stringify(flight);
  $('predict').hidden = false;
  $('dock').hidden = true;
  map.setPrediction(flight, flight.lands ? '' : distance(flight.end.alt));
  scene.setPrediction(localFrame() ? flight.points.map(p => [...toLocal(p.lat, p.lon), p.alt]) : null);
}

async function send(action, label, params = {}, timeoutMs = RUN_TIMEOUT_MS) {
  let r;
  try {
    r = await post('/api/exec/run', { action, seq: lastSeq, params }, timeoutMs);
  } catch {
    // The request may or may not have arrived. Saying "not sent" here could be false.
    showNotice(t('errUnknown', { what: label }), 'red-text');
    return null;
  }
  if (r.error) {
    if (r.error === 'token') closeExec();
    showNotice(errorText(r.error), 'red-text');
  } else if (r.result === 0) {
    if (r.effect === false) showNotice(t('noEffect', { what: label }), 'amber');
    else showNotice(t('sent', { what: label }), '');
  } else if (r.result == null) {
    showNotice(t('noAck', { what: label }), 'red-text');
  } else {
    const why = r.said?.length ? messageText(r.said[r.said.length - 1]) : '';
    showNotice(why ? t('refusedWhy', { what: label, why }) : t('refused', { what: label }), 'red-text');
  }
  return r;
}

function closeExec() {
  execToken = null;
  renderExec();
}

const DOCK_MODES = [0, 2, 5, 6, 9];
const modeWanted = new Map();

pressButton($('predict-go'), () => {
  const { action, label, params, timeoutMs } = proposal ?? {};
  if (!action) return null;
  return async () => {
    const r = await send(action, label, params, timeoutMs);
    if (r?.result === 0) closeProposal();
  };
});
$('predict-cancel').addEventListener('click', closeProposal);

function buildDock() {
  const host = $('do-modes');
  for (const mode of DOCK_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hold';
    b.dataset.mode = mode;
    b.append(document.createElement('span'));
    pressButton(b, () => () => run('mode', MODES[store.lang][mode], { mode }));
    modeWanted.set(b, mode);
    host.append(b);
  }
}

function renderExec() {
  const state = store.S;
  const left = state.exec;
  if (execToken && left == null && store.online) execToken = null;    // closed, expired, or taken away
  $('dock').hidden = !!proposal || (!execToken && left == null);
  document.documentElement.classList.toggle('exec-on', !!execToken);
  $('dock-bar').hidden = !execToken;
  const other = !execToken && left != null;
  const usable = live();
  const avail = state.avail ?? {};
  // Turning on execution and the panel it opens are one thing, wherever it is reached from.
  put($('open-control'), t(execToken ? 'controlOn' : 'control'));
  $('open-control').classList.toggle('red-text', !!execToken);
  $('exec-on').hidden = !!execToken || other;
  $('exec-on').disabled = !usable;
  $('exec-panel').parentElement.hidden = !execToken;
  put($('exec-state'), other ? t('execOther') : !execToken ? t('execWarningShort') : state.armed ? t('execNoteArmed') : t('execNotePanel', { t: clock(left ?? 0) }));
  $('do-arm').disabled = !usable;
  for (const b of $('do-modes').children) {
    const why = avail.mode?.[b.dataset.mode];
    b.disabled = !usable || !!why;
    b.title = why ? t(`why_${why}`) : '';
  }
  put($('do-panel'), t('panel'));
  put($('dock-note'), left == null ? '' : !execToken ? t('execOther') : state.armed ? t('execNoteArmed') : t('execNote', { t: clock(left) }));
  put($('do-arm').firstElementChild, t(state.armed ? 'disarm' : 'arm'));
  for (const b of $('do-modes').children) {
    const m = +b.dataset.mode;
    put(b.firstElementChild, MODES[store.lang][m]);
    b.classList.toggle('on', state.mode === m);
  }
  put($('do-exit'), t('exit'));
}

// ---- Language ---------------------------------------------------------------

function applyLanguage() {
  localStorage.setItem('lang', store.lang);
  document.documentElement.lang = store.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  put($('open'), t('details'));
  put($('open-settings'), t('settings'));
  $('swap').setAttribute('aria-label', t('swapView'));
  for (const [id, name, key] of [['zoom-in', 'zoomIn', '+'], ['zoom-out', 'zoomOut', '-'], ['view-switch', 'viewSwitch', 'V'], ['map-fit', 'mapFit', 'F'], ['map-plan', 'mapPlanTool', 'P']]) nameTool($(id), t(name), key);
  renderViewTools();
  $('frame-open').setAttribute('aria-label', t('pageAirframe'));
  scene.setLabels(COMPASS[store.lang]);
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === store.lang));
  logShown = '';
  buildDetails();
  if (page) showPage(page.id);
  renderAll();
}

// ---- Wiring -----------------------------------------------------------------

function renderAll() {
  renderStatus();
  renderValues();
  renderStack();
  renderScene();
  renderExec();
  renderProposal();
  ui.refresh();
  renderDetails();
  page?.refresh();
}

// The server sends a frame at least every second. The first frame of a connection carries the
// whole history, which takes time on a slow network. The server drops a viewer that has been
// silent for 20 s, and a page cannot report in until that frame arrives, so waiting longer is pointless.
const FRAME_LIMIT_MS = 3500;
const FIRST_FRAME_LIMIT_MS = 20000;

let source;
function connect() {
  if (source) return;
  lastFrameAt = Date.now();
  frameLimit = FIRST_FRAME_LIMIT_MS;
  source = new EventSource('/events');
  source.addEventListener('full', e => {
    const data = JSON.parse(e.data);
    store.messages = data.messages;
    store.history = data.history;
    viewerId = data.viewer;
    lastSeq = data.seq;
    delete data.messages;
    delete data.history;
    delete data.viewer;
    carryOver(store.S, data);
    rebuildTrail();
    store.online = true;
    store.lagging = false;
    lastFrameAt = Date.now();
    frameLimit = FRAME_LIMIT_MS;
    renderAll();
    renderSparks();
    renderFeed();
    reportIn();
  });
  source.addEventListener('d', e => {
    const data = JSON.parse(e.data);
    lastSeq = data.seq ?? lastSeq;
    lastFrameAt = Date.now();
    delete data.seq;
    const wasArmed = store.S.armed;
    Object.assign(store.S, data);
    settleCarried(data);
    if (!wasArmed && store.S.armed) resetTrail();      // a new flight starts a new path
    extendTrail();
    store.online = true;
    renderAll();
  });
  source.addEventListener('m', e => {
    store.messages.push(JSON.parse(e.data));
    if (store.messages.length > 200) store.messages.shift();
    renderFeed();
  });
  source.addEventListener('h', e => {
    store.history.push(JSON.parse(e.data));
    if (store.history.length > 900) store.history.shift();
    renderSparks();
  });
  source.onerror = () => {
    store.online = false;
    renderAll();
  };
}

// Coming back to this page can mean a new connection, and with nobody watching the server will have
// let go of what it knew. Starting from nothing would blank the map and the readings and then bring them
// back in pieces, so what was on screen stays, in the colours of old data, until new values replace it.
const NOT_CARRIED = new Set(['link', 'age', 'old', 'exec', 'viewers', 'avail', 'cmds', 'rx', 'rates', 'loss', 'rtt', 'target', 'nav', 'armed_at', 'plan_busy', 'pending', 'seq', 'baud', 'cells']);
const CARRIED_LIMIT_MS = 10000;     // once linked, whatever has not come back by then is no longer so

function carryOver(before, fresh) {
  store.S = fresh;
  store.carried = new Set();
  store.carriedSince = null;
  for (const [key, value] of Object.entries(before)) {
    if (NOT_CARRIED.has(key) || key in fresh || value == null) continue;
    fresh[key] = value;
    store.carried.add(key);
  }
}

function settleCarried(data) {
  if (!store.carried.size) return;
  for (const key of Object.keys(data)) store.carried.delete(key);
  if (!live()) return;
  store.carriedSince ??= Date.now();
  if (Date.now() - store.carriedSince > CARRIED_LIMIT_MS) {
    for (const key of store.carried) delete store.S[key];
    store.carried.clear();
  }
}

function disconnect() {
  if (!source) return;
  source.close();
  source = null;
  viewerId = null;
}

// Without a frame this page is out of date, whatever the connection appears to be doing, so say
// so and start again.
setInterval(() => {
  if (document.hidden || Date.now() - lastFrameAt < frameLimit) return;
  if (store.online) {
    store.online = false;
    renderAll();
  }
  disconnect();
  connect();
}, 1000);

// Tell the server this page is still here. A phone that goes to sleep stops, and the
// server then lets go of the flight controller link and of any execution this page held.
// The reply says how far along the stream is: on a slow network frames keep arriving, but late,
// and without this check a page minutes behind would still look live.
const LAG_TICKS = 15;           // 3 s of frames
const RESTART_GAP_MS = 30000;   // restarting drops the backlog, but costs a full reload of state
const ALIVE_URL = new URL('/api/alive', location.href).href;
const LATENCY_LOG = 360;

// From the request going out to the first byte back, leaving out setting up the connection.
function noteLatency(started) {
  const entry = performance.getEntriesByName(ALIVE_URL).pop();
  performance.clearResourceTimings();
  const ms = entry?.responseStart > 0 && entry.requestStart > 0 ? entry.responseStart - entry.requestStart : performance.now() - started;
  store.latency = Math.round(ms);
  store.latencyLog.push([Date.now() / 1000, store.latency]);
  if (store.latencyLog.length > LATENCY_LOG) store.latencyLog.shift();
}

async function reportIn() {
  if (!viewerId || document.hidden) return;
  const started = performance.now();
  const r = await post('/api/alive', { viewer: viewerId }).catch(() => null);
  if (r) {
    await new Promise(done => setTimeout(done));     // the timing entry is filed just after the reply
    noteLatency(started);
  } else {
    store.latency = null;
  }
  if (r?.seq == null || r.seq - lastSeq <= LAG_TICKS) {
    if (store.lagging && r?.seq != null) {
      store.lagging = false;
      renderAll();
    }
    return;
  }
  if (!store.lagging) {
    store.lagging = true;
    renderAll();
  }
  if (Date.now() - lastRestart > RESTART_GAP_MS) {
    lastRestart = Date.now();
    disconnect();
    connect();
  }
}
setInterval(reportIn, 5000);

// A hidden tab stops listening, so an idle page costs the server nothing.
const RESUME_CALM_MS = 8000;    // this long after coming back, not yet being connected is not news
let hideTimer;
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hideTimer = setTimeout(disconnect, 15000);
  } else if (!source) {
    store.resumingUntil = Date.now() + RESUME_CALM_MS;
    setTimeout(renderAll, RESUME_CALM_MS + 50);
    store.online = false;
    renderAll();
    connect();
  }
});

setInterval(() => {
  renderFeed();
  if (live() && store.S.armed) renderStatus();
}, 2000);

// Rotors turn while armed, in their real directions, at a pace set by their output.
const rings = [...document.querySelectorAll('#reticle .out')];
const turning = [-1, -1, 1, 1];
const turned = [0, 0, 0, 0];
const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
let lastSpin = 0;

function spinRotors(now) {
  const dt = Math.min(.1, (now - lastSpin) / 1000);
  lastSpin = now;
  if (!store.S.armed || stillMotion.matches || !live() || page) return;
  rings.forEach(ring => {
    const i = +ring.dataset.motor;
    turned[i] += turning[i] * (store.S.motors?.[i] ?? 0) * 7 * dt;
    ring.style.setProperty('--spin', `${(turned[i] - 90).toFixed(1)}deg`);
  });
}

(function animate(now) {
  scene.frame(now);
  spinRotors(now);
  requestAnimationFrame(animate);
})(performance.now());

$('open').addEventListener('click', () => setSheet($('details').classList.contains('open') ? null : 'details'));
$('close').addEventListener('click', () => setSheet(null));
$('open-settings').addEventListener('click', () => setSheet($('settings').classList.contains('open') ? null : 'settings'));
$('settings-close').addEventListener('click', () => setSheet(null));
$('swap').addEventListener('click', () => setMapMain(!mapMain()));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeProposal();
    setSheet(null);
    ui.closeCard();
    if (page) goTo(null);
    return;
  }
  if (page || e.ctrlKey || e.metaKey || e.altKey || sheetOpen() || e.target.matches?.('input')) return;
  const inMap = mapMain();
  const keys = {
    v: () => { if (!inMap) setView(view === 'chase' ? 'fpv' : 'chase'); },
    m: () => setMapMain(!inMap),
    l: () => { if (!inMap && view === 'chase') toggleLock(); },
    r: () => resetView(),
    f: () => { if (inMap) map.fit(); },
    p: () => { if (inMap) ui.toggleDrawer(); },
    delete: () => { if (inMap) ui.deleteSelected(); },
    '+': () => zoomStep(1), '=': () => zoomStep(1), '-': () => zoomStep(-1),
  };
  keys[e.key.toLowerCase()]?.();
});

// ---- Looking around ---------------------------------------------------------

// The world shows the view from the aircraft or from behind it, and a tap or the button switches
// between them; the choice is kept. From behind, a drag turns the view round the aircraft, a pinch
// or the wheel brings it closer or further, and the lock keeps its bearing fixed and stops a stray
// touch from changing it. On the map, a drag moves the map away from the aircraft.
let view = localStorage.getItem('view') === 'chase' ? 'chase' : 'fpv';
function mapMain() { return document.documentElement.classList.contains('map-main'); }

function nameTool(el, text, key) {
  el.title = key ? `${text} (${key})` : text;
  el.setAttribute('aria-label', text);
}

function renderViewTools() {
  const inMap = mapMain(), chase = view === 'chase' && !inMap;
  const o = scene.orbit;
  document.documentElement.classList.toggle('chase', view === 'chase');
  document.documentElement.classList.toggle('view-locked', chase && scene.locked);
  $('view-switch').hidden = inMap;
  put($('view-switch'), t(view === 'chase' ? 'viewChase' : 'viewFpv'));
  $('view-lock').hidden = !chase;
  $('view-lock').classList.toggle('on', scene.locked);
  nameTool($('view-lock'), t(scene.locked ? 'viewUnlock' : 'viewLock'), 'L');
  $('tools').classList.toggle('single', !chase && !inMap);
  $('zoom-in').hidden = $('zoom-out').hidden = !chase && !inMap;
  $('view-reset').hidden = inMap ? map.following : !chase || scene.orbitIsDefault();
  $('map-fit').hidden = !inMap;
  $('map-plan').hidden = !inMap;
  nameTool($('view-reset'), t(inMap ? 'mapCentre' : 'viewReset'), 'R');
  $('view-reset').dataset.orbit = `${o.zoom.toFixed(2)} ${(o.elev / rad).toFixed(0)} ${(o.az / rad).toFixed(0)}`;
}

function saveView() {
  const o = scene.orbit;
  localStorage.setItem('chaseView', JSON.stringify({
    zoom: +o.zoom.toFixed(3),
    lock: scene.locked ? { yaw: +scene.lockYaw.toFixed(3), elev: +o.elev.toFixed(3) } : null,
  }));
}

function setView(next) {
  view = next;
  localStorage.setItem('view', view);
  scene.setView(view);
  renderViewTools();
  measureHud();
}

function setZoom(zoom) {
  scene.setOrbit({ zoom });
  saveView();
  renderViewTools();
}

function zoomStep(direction) {
  if (mapMain()) map.nudge(direction);
  else if (view === 'chase') setZoom(scene.orbit.zoom * 1.25 ** -direction);
}

function toggleLock() {
  scene.setLocked(!scene.locked);
  saveView();
  renderViewTools();
  showNotice(t(scene.locked ? 'viewLockedNote' : 'viewFreeNote'), '');
}

function resetView() {
  if (mapMain()) { map.recentre(); return; }
  if (view !== 'chase') return;
  scene.resetOrbit();
  saveView();
  renderViewTools();
}

function setMapMain(on) {
  document.documentElement.classList.toggle('map-main', on);
  localStorage.setItem('mapMain', on ? '1' : '0');
  scene.setPlain(on);
  map.setMain(on);
  if (!on) {
    map.resetView();
    ui.closePanels();
  }
  renderViewTools();
  measureHud();
  if (!stillMotion.matches) for (const el of [$('map'), $('scene')]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
}

function tapWorld() {
  if (page) goTo(null);
  else if (sheetOpen()) setSheet(null);
  else if (view === 'chase' && scene.locked) showNotice(t('viewLockedNote'), '');
  else setView(view === 'chase' ? 'fpv' : 'chase');
}

const DRAG_PX = 6;
const pointers = new Map();
let press = null;       // the first finger or button: where it went down, and whether it has moved
let pinch = null;       // two fingers: how far apart they began, and the zoom then
const world = $('scene');
world.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  world.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) {
    press = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, at: performance.now() };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { span: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: scene.orbit.zoom };
    press = null;
  }
});
world.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (span > 10 && view === 'chase') setZoom(pinch.zoom * pinch.span / span);
    return;
  }
  if (!press) return;
  const dx = e.clientX - press.lastX, dy = e.clientY - press.lastY;
  press.lastX = e.clientX;
  press.lastY = e.clientY;
  if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
  if (!press.moved && view === 'chase' && !scene.locked) document.documentElement.classList.add('dragging');
  press.moved = true;
  if (view === 'chase' && !scene.locked) {
    scene.turnBy(dx * .5 * rad, dy * .3 * rad);
    renderViewTools();
  }
});
const release = e => {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size < 2) pinch = null;
  if (press && !press.moved && pointers.size === 0 && performance.now() - press.at < 600) tapWorld();
  if (pointers.size === 0) {
    press = null;
    document.documentElement.classList.remove('dragging');
  }
};
world.addEventListener('pointerup', release);
world.addEventListener('pointercancel', release);
world.addEventListener('wheel', e => {
  if (view !== 'chase' || mapMain()) return;
  e.preventDefault();
  setZoom(scene.orbit.zoom * Math.exp(Math.max(-.25, Math.min(.25, e.deltaY * .0012))));
}, { passive: false });
$('zoom-in').addEventListener('click', () => zoomStep(1));
$('zoom-out').addEventListener('click', () => zoomStep(-1));
$('view-switch').addEventListener('click', () => setView(view === 'chase' ? 'fpv' : 'chase'));
$('view-lock').addEventListener('click', toggleLock);
$('view-reset').addEventListener('click', resetView);
$('map-fit').addEventListener('click', () => map.fit());

// Where the readings are, for labels to keep off and lines to fade out before. Checked now and
// then, since messages and alerts change how much room they take.
let hudShown = '';
function measureHud() {
  const box = el => {
    const r = el.getBoundingClientRect();
    return r.width && r.height ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null;
  };
  const avoid = ['status', 'nav', 'side', 'tools', 'feed', 'row', 'swap', 'dock'].map(id => box($(id))).filter(Boolean);
  if (view !== 'chase') {
    const k = MARKERS[shown.marker].reticle;
    avoid.push([innerWidth / 2 - 110 * k, innerHeight / 2 - 96 * k, innerWidth / 2 + 110 * k, innerHeight / 2 + 96 * k]);
  }
  const rowTop = $('row').getBoundingClientRect().top;
  // The aircraft from behind sits in the room left, which the execution bar takes some of.
  const dock = box($('predict')) ?? box($('dock'));
  const roomEnd = dock ? Math.min(rowTop, dock[1]) : rowTop;
  const top = Math.min(Math.max($('status').getBoundingClientRect().bottom, $('side').getBoundingClientRect().bottom), roomEnd - 120);
  const clear = ['stack', 'nav', 'feed', 'status', 'dock', 'predict'].map(id => box($(id))).filter(Boolean);
  const hud = { avoid, clear, fadeTop: 64, fadeBottom: Math.round(rowTop), aimY: Math.round(top + (roomEnd - top) * .68) };
  const key = JSON.stringify(hud);
  if (key !== hudShown) {
    hudShown = key;
    scene.setHud(hud);
  }
}
setInterval(measureHud, 1000);
window.addEventListener('resize', measureHud);

const kept = (() => {
  try { return JSON.parse(localStorage.getItem('chaseView')) ?? {}; } catch { return {}; }
})();
if (kept.zoom) scene.setOrbit({ zoom: kept.zoom });
if (kept.lock) {
  scene.setOrbit({ elev: kept.lock.elev });
  scene.setLocked(true, kept.lock.yaw);
}

// What is shown: the flight path, the distance rings, the imagery under the map, what is stored on
// the flight controller, and how large the aircraft is drawn. The size applies wherever the aircraft
// is: the symbol from behind, the sight in the view from it, and the arrow on the map.
const MARKERS = {
  s: { world: 1, reticle: .75, map: .75 },
  m: { world: 1.5, reticle: 1, map: 1 },
  l: { world: 2.5, reticle: 1.4, map: 1.5 },
};
const SHOW_KEYS = ['trail', 'rings', 'tiles', 'plan', 'fence', 'rally', 'notes'];
const shown = {};
function readDisplay() {
  for (const key of SHOW_KEYS) shown[key] = localStorage.getItem(key) !== '0';
  const marker = localStorage.getItem('marker');
  shown.marker = Object.hasOwn(MARKERS, marker) ? marker : 'm';
}
function applyDisplay() {
  const marker = MARKERS[shown.marker];
  scene.setTrailVisible(shown.trail);
  scene.setRings(shown.rings);
  scene.setMarker(marker.world);
  map.setRings(shown.rings);
  map.setTiles(shown.tiles);
  map.setMarker(marker.map);
  document.documentElement.style.setProperty('--marker', marker.reticle);
  document.documentElement.classList.toggle('no-tiles', !shown.tiles);
  document.documentElement.classList.toggle('no-trail', !shown.trail);
  document.querySelectorAll('[data-show]').forEach(b => {
    b.classList.toggle('on', shown[b.dataset.show]);
    b.setAttribute('aria-checked', String(shown[b.dataset.show]));
  });
  document.querySelectorAll('[data-marker]').forEach(b => b.classList.toggle('on', shown.marker === b.dataset.marker));
  renderScene();
  measureHud();
}
document.querySelectorAll('[data-show]').forEach(b => b.addEventListener('click', () => {
  shown[b.dataset.show] = !shown[b.dataset.show];
  localStorage.setItem(b.dataset.show, shown[b.dataset.show] ? '1' : '0');
  applyDisplay();
}));
document.querySelectorAll('[data-marker]').forEach(b => b.addEventListener('click', () => {
  shown.marker = b.dataset.marker;
  localStorage.setItem('marker', shown.marker);
  applyDisplay();
}));
// Another tab of this page changing a setting changes it here too.
window.addEventListener('storage', e => {
  if (e.key === 'marker' || SHOW_KEYS.includes(e.key)) {
    readDisplay();
    applyDisplay();
  }
});
readDisplay();
setView(view);

// The switches for what is stored say how much there is, so one that changes nothing explains itself.
let countsShown = '';
function renderPlanCounts(shapes) {
  const counts = { ...shapes.counts, notes: store.S.marks?.length ?? 0 };
  const key = `${store.lang}${JSON.stringify(counts)}`;
  if (key === countsShown) return;
  countsShown = key;
  for (const [what, name] of [['plan', 'showPlan'], ['fence', 'showFence'], ['rally', 'showRally'], ['notes', 'showNotes']]) {
    put(document.querySelector(`[data-show="${what}"] span`), t(name, { n: counts[what] }));
  }
}

// ---- The things on the map --------------------------------------------------------

ui = mapUi({ map, actions: pageActions, mapMain, pageOpen: () => !!page, afterChange: () => renderScene() });
applyDisplay();
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => { store.lang = b.dataset.lang; applyLanguage(); }));

async function openExec() {
  const r = await post('/api/exec/open', { viewer: viewerId }).catch(() => ({}));
  if (r.token) {
    execToken = r.token;
    store.S.exec = r.left;
    setSheet(null);
    renderExec();
    ui.refresh();
    page?.refresh();
  } else {
    showNotice(errorText(r.error), 'red-text');
  }
}
holdButton($('exec-on'), 2000, () => async () => {
  await openExec();
  if (execToken) goTo('control');
});
async function leaveExec() {
  await post('/api/exec/close').catch(() => {});
  store.S.exec = null;
  closeExec();
  ui.refresh();
  page?.refresh();
}
$('exec-off').addEventListener('click', leaveExec);
$('do-exit').addEventListener('click', leaveExec);
// What this button does is fixed at the press: arm or disarm, as the aircraft was when it was pressed.
pressButton($('do-arm'), () => {
  const want = store.S.armed ? 'disarm' : 'arm';
  return () => {
    if ((store.S.armed ? 'disarm' : 'arm') === want) return run(want, t(want));
    return null;
  };
});

buildDock();
applyLanguage();
if (localStorage.getItem('mapMain') === '1') setMapMain(true);
connect();
if (pageFromAddress()) showPage(pageFromAddress());
