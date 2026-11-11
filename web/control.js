// The control panel: every action in the server's table with its input, why it cannot run now, and
// what became of it. Nothing happens here without holding a button down for as long as the table
// says, and the server decides again whether each one may run.

import { MODES } from '/i18n.js';
import { clock, el, fenceState, fixed, gpsSummary, live, messageText, messageTone, navSummary, put, rcState, store, t, timeOf } from '/shared.js';
import { columns, rows, section } from '/pages.js';

const SET_NAMES = ['RTL_ALT_M', 'RTL_SPEED_MS', 'WP_SPD', 'WP_SPD_UP', 'WP_SPD_DN', 'LAND_SPD_MS', 'FENCE_ALT_MAX', 'FENCE_RADIUS'];
const MESSAGES_SHOWN = 8;
const RECORD_SHOWN = 12;

const outcomeText = code => {
  const text = t(`out_${code}`);
  return text === `out_${code}` ? t(`why_${code}`) : text;
};

export function control(root, actions) {
  const [main, side] = columns(root);
  const headline = el('p', 'headline', main);
  const note = el('p', 'danger', main);
  const warning = el('p', 'danger', main, t('execWarning'));
  const enable = el('button', 'hold tile red enable', main);
  enable.type = 'button';
  el('span', null, enable, t('execHold'));
  actions.holdButton(enable, 2000, () => actions.openExec);
  const leave = el('button', 'tile compact', main, t('execOff'));
  leave.type = 'button';
  leave.addEventListener('click', actions.closeExec);
  const body = el('div', 'panel', main);
  put(body, t('logsLoading'));

  const bound = [];
  const reasons = [];
  const prefills = [];    // inputs to fill in once the value they start from is known
  const modeButtons = [];
  let table = null;
  let armButton, disarmButton;

  const reasonOf = (name, mode) => {
    const a = store.S.avail;
    if (!a) return 'no_link';
    if (a['*']) return a['*'];
    return mode != null ? a.mode?.[mode] ?? null : a[name] ?? null;
  };

  // A button that runs an action when pressed. `read` gives its input at the moment of the press, or
  // null to refuse, so what a press sends is what was there when it was pressed.
  const act = (parent, name, label, read = () => ({}), mode = null) => {
    const entry = table.get(name);
    const b = el('button', `hold tile${entry.risk === 'danger' ? ' red' : ''}`, parent);
    b.type = 'button';
    const text = el('span', null, b, label);
    actions.pressButton(b, () => {
      const params = read();
      if (!params) return null;
      return () => actions.run(name, text.textContent, params, entry.timeout_s * 1000 + 3000);
    });
    bound.push({ b, name, mode });
    return b;
  };

  // A number to fill in. Returns a function giving its value, or null after saying what is wrong.
  const field = (parent, name, key, labelKey, value) => {
    const spec = table.get(name).input_schema.properties[key];
    return numberField(parent, labelKey, spec, value ?? spec.default);
  };
  const UNITS = { deg: '°', 'deg/s': '°/s' };
  const numberField = (parent, labelKey, spec, value) => {
    const wrap = el('label', 'field', parent);
    el('span', 'soft', wrap, spec.unit ? `${t(labelKey)} ${UNITS[spec.unit] ?? spec.unit}` : t(labelKey));
    const input = el('input', null, wrap);
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = 'any';
    input.min = spec.minimum;
    input.max = spec.maximum;
    if (value != null) input.value = value;
    return Object.assign(() => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v) || v < spec.minimum || v > spec.maximum) {
        actions.notice(t('errRange', { what: t(labelKey), a: spec.minimum, b: spec.maximum }), 'red-text');
        return null;
      }
      return v;
    }, { input });
  };

  // One line under a group saying why its first unavailable action cannot run.
  const whyLine = (parent, names) => {
    const line = el('p', 'why small soft', parent);
    reasons.push({ line, names });
  };

  const group = (key, names) => {
    const host = el('section', 'act-group', body);
    el('h3', null, host, t(key));
    if (names) whyLine(host, names);
    return host;
  };
  const row = parent => el('div', 'act-row', parent);

  const reading = (fields, build) => () => {
    const values = fields.map(read => read());
    return values.includes(null) ? null : build(...values);
  };

  function build() {
    body.textContent = '';
    const S = store.S;

    // ---- Flight
    const flight = group('groupFlight', []);
    const top = row(flight);
    armButton = act(top, 'arm', t('arm'));
    disarmButton = act(top, 'disarm', t('disarm'));
    const takeoffAlt = field(top, 'takeoff', 'alt', 'fieldAlt');
    act(top, 'takeoff', t('act_takeoff'), reading([takeoffAlt], alt => ({ alt })));
    const grid = el('div', 'mode-grid', flight);
    for (const mode of table.get('mode').input_schema.properties.mode.enum) {
      const b = act(grid, 'mode', MODES[store.lang][mode], () => ({ mode }), mode);
      b.dataset.mode = mode;
      modeButtons.push(b);
    }
    const modeWhy = el('p', 'why small soft', flight);
    reasons.push({ line: modeWhy, modes: true });

    // ---- In the air. Where to go is chosen on the map, where the places are.
    const guided = group('groupInFlight', ['altitude', 'speed', 'pause']);
    const adjust = row(guided);
    const newAlt = field(adjust, 'altitude', 'alt', 'fieldAlt', S.pos?.[3] >= 2 ? Math.round(S.pos[3]) : 10);
    act(adjust, 'altitude', t('act_altitude'), reading([newAlt], a => ({ alt: a })));
    const speed = field(adjust, 'speed', 'speed', 'fieldSpeed');
    act(adjust, 'speed', t('act_speed'), reading([speed], s => ({ speed: s })));
    const turn = row(guided);
    const heading = field(turn, 'yaw', 'heading', 'fieldHeading', S.hud?.[3] ?? 0);
    const rate = field(turn, 'yaw', 'rate', 'fieldRate');
    act(turn, 'yaw', t('act_yaw'), reading([heading, rate], (h, r) => ({ heading: h, rate: r })));
    act(turn, 'pause', t('act_pause'));
    act(turn, 'resume', t('act_resume'));
    const toMap = el('button', 'tile spaced', guided, t('onMap'));
    toMap.type = 'button';
    toMap.addEventListener('click', actions.openMap);

    // ---- Mission
    const mission = group('groupMission', ['mission_start', 'mission_item']);
    const flow = row(mission);
    act(flow, 'mission_start', t('act_mission_start'));
    const seq = field(flow, 'mission_item', 'seq', 'fieldSeq', Math.max(S.mission?.[0] ?? 1, 1));
    act(flow, 'mission_item', t('act_mission_item'), reading([seq], s => (Number.isInteger(s) ? { seq: s } : null)));

    const editor = el('button', 'tile spaced', mission, t('editOnMap'));
    editor.type = 'button';
    editor.addEventListener('click', actions.openPlanEditor);
    const clear = row(mission);
    for (const kind of ['mission', 'fence', 'rally']) act(clear, 'plan_clear', t('act_clear', { what: t(`kind_${kind}`) }), () => ({ kind }));

    // ---- Safety
    const safety = group('groupSafety', ['set_home', 'param_set']);
    const fenceRow = row(safety);
    act(fenceRow, 'fence_enable', t('act_fence_on'), () => ({ on: true }));
    act(fenceRow, 'fence_enable', t('act_fence_off'), () => ({ on: false }));
    act(fenceRow, 'set_home', t('act_set_home'));
    const limits = table.get('param_set').limits;
    const settings = el('div', 'settings', safety);
    for (const name of SET_NAMES.filter(n => limits[n])) {
      const line = row(settings);
      const value = numberField(line, `set_${name}`, limits[name], S.params?.[name]);
      prefills.push([value.input, () => store.S.params?.[name]]);
      act(line, 'param_set', t('act_write'), reading([value], v => ({ name, value: v })));
    }

    // ---- On the bench
    const setup = group('groupSetup', ['calibrate', 'motor_test', 'reboot']);
    const cal = row(setup);
    for (const what of table.get('calibrate').input_schema.properties.what.enum) {
      act(cal, 'calibrate', t(`act_cal_${what}`), () => ({ what }));
    }
    const motor = row(setup);
    const which = field(motor, 'motor_test', 'motor', 'fieldMotor', 1);
    const throttle = field(motor, 'motor_test', 'throttle', 'fieldThrottle');
    const seconds = field(motor, 'motor_test', 'seconds', 'fieldSeconds');
    act(motor, 'motor_test', t('act_motor_test'), reading([which, throttle, seconds], (m, th, s) => (Number.isInteger(m) ? { motor: m, throttle: th, seconds: s } : null)));
    el('p', 'danger', setup, t('motorWarning'));
    const restart = row(setup);
    act(restart, 'reboot', t('reboot'));

    // ---- Emergency
    const emergency = group('groupEmergency', []);
    el('p', 'danger', emergency, t('killWarning'));
    act(row(emergency), 'kill', t('killHold'));
  }

  actions.catalog().then(entries => {
    if (!body.isConnected) return;
    if (!entries) {
      put(body, t('errOther'));
      return;
    }
    table = new Map(entries.map(e => [e.name, e]));
    build();
    refresh();
  });

  section(side, 'secNow');
  const now = rows(side, [
    ['mode', () => (store.S.mode != null ? MODES[store.lang][store.S.mode] ?? `#${store.S.mode}` : null)],
    ['altitude', () => (store.S.pos ? `${fixed(store.S.pos[3])} m` : null)],
    ['speed', () => (store.S.hud ? `${fixed(store.S.hud[0])} m/s` : null)],
    ['voltage', () => (store.S.volts != null ? `${store.S.volts.toFixed(2)} V` : null)],
    ['fixType', () => (store.S.gps ? gpsSummary().text : null)],
    ['ekf', () => navSummary()?.text],
    ['stackRc', () => ({ ok: t('linkOk'), none: t('rcNone'), lost: t('rcLostShort'), unprotected: t('rcOffShort') }[rcState()] ?? null)],
    ['stackFence', () => fenceState()?.text, () => fenceState()?.tone],
    ['mission', () => (store.S.mission?.[1] ? `${store.S.mission[0]} / ${store.S.mission[1]}` : null)],
  ]);
  section(side, 'secRecord');
  const record = el('div', 'log', side);
  section(side, 'secMessages');
  const said = el('div', 'log', side);
  let recordShown = '', saidShown = '';

  function refresh() {
    const S = store.S;
    const mine = actions.execOn();
    const other = !mine && S.exec != null;
    const usable = mine && live();
    put(headline, statusLine(S));
    warning.hidden = enable.hidden = mine || other;
    leave.hidden = !mine;
    enable.disabled = !live();
    put(note, mine ? (S.armed ? t('execNoteArmed') : t('execNotePanel', { t: clock(S.exec ?? 0) })) : other ? t('execOther') : '');
    note.hidden = !note.textContent;
    if (table) {
      for (const { b, name, mode } of bound) {
        if (b.isConnected) b.disabled = !usable || !!reasonOf(name, mode);
      }
      for (const b of modeButtons) b.classList.toggle('on', S.mode === +b.dataset.mode);
      for (const [input, value] of prefills) {
        if (!input.value && document.activeElement !== input && value() != null) input.value = value();
      }
      if (armButton) {
        armButton.hidden = !!S.armed;
        disarmButton.hidden = !S.armed;
      }
      for (const { line, names, modes } of reasons) {
        let text = '';
        if (usable && modes) {
          const list = Object.values(S.avail?.mode ?? {});
          text = [...new Set(list)].map(code => t(`why_${code}`)).join(store.lang === 'zh' ? '，' : ', ');
        } else if (usable && names) {
          const stopped = names.map(name => reasonOf(name)).find(Boolean);
          text = stopped ? t(`why_${stopped}`) : '';
        }
        put(line, text);
      }
    }
    now();

    const entries = (S.cmds ?? []).slice(0, RECORD_SHOWN);
    const recordKey = store.lang + JSON.stringify(entries);
    if (recordKey !== recordShown) {
      recordShown = recordKey;
      record.textContent = '';
      if (!entries.length) el('p', 'soft', record, t('recordNone'));
      for (const [when, name, params, outcome] of entries) {
        const p = el('p', null, record);
        el('time', null, p, timeOf(when));
        const good = outcome === 'accepted' || outcome === 'landing';
        const what = name === 'mode' ? MODES[store.lang][params.mode] ?? name
          : name === 'set_home' && params.lat != null ? t('act_set_home_here')
            : t(`act_${name}`);
        el('span', good ? '' : 'amber', p, `${what}  ${outcomeText(outcome)}`);
      }
    }
    const messages = store.messages.slice(-MESSAGES_SHOWN).reverse();
    const saidKey = store.lang + JSON.stringify(messages);
    if (saidKey !== saidShown) {
      saidShown = saidKey;
      said.textContent = '';
      if (!messages.length) el('p', 'soft', said, t('none'));
      for (const [when, severity, text] of messages) {
        const p = el('p', null, said);
        el('time', null, p, timeOf(when));
        el('span', messageTone(severity), p, messageText(text));
      }
    }
  }
  return refresh;
}

function statusLine(S) {
  if (!live()) return t('linkBad');
  const state = S.armed ? t('armed') : t('disarmed');
  const mode = MODES[store.lang][S.mode];
  return mode ? `${state}${store.lang === 'zh' ? '，' : ', '}${mode}` : state;
}
