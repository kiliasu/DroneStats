// What can be done with the things on the map: every point on it opens a card, by hovering with a
// mouse or tapping with a finger, and anywhere else on the map is a place that can become one. Editing
// the mission happens in a draft in this browser, which reaches the flight controller only when it is
// written. Commands in the cards need execution and a hold, like any other, and the server decides.

import { CMD_NAMES, MODES } from '/i18n.js';
import { rows } from '/pages.js';
import {
  CMD, draftWarnings, parsePlanFile, routeOfDraft, routeStats, seedDraft, toWaypointsFile,
} from '/plan.js';
import {
  $, FENCE_ACTIONS, clock, distance, el, fenceState, fixed, fromHere, fromHome, gpsSummary, live, put, store, t,
} from '/shared.js';

const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 300;
const CARD_GAP = 18;
const EDGE = 16;
const ALT_MIN = 1, ALT_MAX = 500;
const DEFAULT_ALT = 20;
const WRITE_GAP_MS = 800;       // the server's gap between commands, between writing one plan and the next
const FACE_RATE = 30;
const TAKEOFF_ALT = 5;
const LOITER_S = 10, LOITER_TURNS = 3, LOITER_RADIUS_M = 10, MAX_RADIUS_M = 255;

const narrow = matchMedia('(max-width: 720px)');

const readDraft = () => {
  try {
    const kept = JSON.parse(localStorage.getItem('draft'));
    return { mission: Array.isArray(kept?.mission) ? kept.mission : null, rally: Array.isArray(kept?.rally) ? kept.rally : null };
  } catch {
    return { mission: null, rally: null };
  }
};

export function mapUi({ map, actions, mapMain, pageOpen, afterChange }) {
  const cardEl = $('card'), bodyEl = $('card-body'), titleEl = $('card-title');
  const drawerEl = $('plan-drawer'), listEl = $('plan-list'), warnEl = $('plan-warn');
  const draft = readDraft();
  let version = 1;
  let card = null;        // { ref, pinned, at(), refresh() }
  let openTimer, closeTimer;
  let table = new Map();
  let adding = false;
  let drawerOpen = false;
  let extras = {};        // fence and rally points from an imported file, waiting to be written
  let shapes = null;
  let listKey = '';

  actions.catalog().then(entries => { if (entries) table = new Map(entries.map(e => [e.name, e])); });

  // ---- The draft ------------------------------------------------------------------

  const stored = () => (store.S.plan?.mission?.items ?? []).slice(1);
  const editing = () => draft.mission !== null;
  const items = () => draft.mission ?? stored();
  const storedRally = () => (store.S.plan?.rally?.items ?? []);
  const rallyList = () => draft.rally ?? storedRally();
  const hasDraft = () => draft.mission !== null || draft.rally !== null;

  function save() {
    localStorage.setItem('draft', JSON.stringify(draft));
  }

  function changed(keep = true) {
    version++;
    shapes = null;
    if (keep) save();
    renderDrawer();
    card?.refresh();
    afterChange();
  }

  function draftShapes() {
    if (!hasDraft()) return null;
    if (shapes?.version === version) return shapes;
    const S = store.S;
    const home = S.home ? { lat: S.home[0], lon: S.home[1], msl: S.home[2] } : null;
    shapes = {
      version,
      route: draft.mission ? routeOfDraft(draft.mission, home, S.params?.RTL_ALT_M) : null,
      rally: draft.rally ? draft.rally.map((r, i) => ({ n: i + 1, lat: r.lat, lon: r.lon, alt: r.alt })) : null,
    };
    return shapes;
  }

  function ensureDraft() {
    if (!draft.mission) draft.mission = seedDraft(store.S);
    return draft.mission;
  }

  function ensureRally() {
    if (!draft.rally) draft.rally = storedRally().map(r => ({ lat: r.lat, lon: r.lon, alt: r.alt }));
    return draft.rally;
  }

  // A jump points at an item by number, so the numbers it points at move with the items.
  function shiftJumps(list, from, by) {
    for (const item of list) {
      if (item.cmd === CMD.DO_JUMP && item.p?.[0] >= from) item.p[0] += by;
    }
  }

  function addPoint(at, cmd, alt, p = [0, 0, 0, 0]) {
    const list = ensureDraft();
    if (!list.length) list.push({ cmd: CMD.TAKEOFF, alt, p: [0, 0, 0, 0] });
    const last = list[list.length - 1];
    const ending = last.cmd === CMD.RTL || last.cmd === CMD.LAND;
    const index = ending ? list.length - 1 : list.length;
    shiftJumps(list, index + 1, 1);
    list.splice(index, 0, { cmd, lat: at[0], lon: at[1], alt, p });
    changed();
    return index + 1;
  }

  function removeItem(seq) {
    const list = ensureDraft();
    list.splice(seq - 1, 1);
    shiftJumps(list, seq + 1, -1);
    closeCard();
    changed();
  }

  function moveItem(seq, by) {
    const list = ensureDraft();
    const to = seq - 1 + by;
    if (to < 0 || to >= list.length) return;
    [list[seq - 1], list[to]] = [list[to], list[seq - 1]];
    openCard(`item:${to + 1}`, true);
    changed();
  }

  function discard() {
    draft.mission = null;
    draft.rally = null;
    extras = {};
    adding = false;
    closeCard();
    changed();
  }

  const defaultAlt = () => {
    const value = Number($('plan-alt').value);
    return value >= ALT_MIN && value <= ALT_MAX ? value : DEFAULT_ALT;
  };

  // ---- Commands from cards ---------------------------------------------------------

  const entryOf = name => table.get(name);
  const reasonOf = (name, mode) => {
    const a = store.S.avail;
    if (!a) return 'no_link';
    if (a['*']) return a['*'];
    return mode != null ? a.mode?.[mode] ?? null : a[name] ?? null;
  };

  function altField(parent, value, labelKey = 'pickAlt') {
    const wrap = el('label', 'field', parent);
    el('span', 'soft', wrap, t(labelKey));
    const input = el('input', null, wrap);
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = 'any';
    input.value = value;
    return input;
  }

  const altOf = (input, low = 2, high = 120) => {
    const v = Number(input.value);
    if (input.value === '' || !Number.isFinite(v) || v < low || v > high) {
      actions.notice(t('errRange', { what: t('fieldAlt'), a: low, b: high }), 'red-text');
      return null;
    }
    return v;
  };

  // A button that sends a command while held. `read` fixes what it will send at the moment of the press.
  function commandButton(parent, bits, name, label, read = () => ({}), { mode = null, after = null } = {}) {
    const b = el('button', `hold tile${entryOf(name)?.risk === 'danger' ? ' red' : ''}`, parent);
    b.type = 'button';
    const text = el('span', null, b, label);
    actions.pressButton(b, () => {
      const params = read();
      if (!params) return null;
      return async () => {
        const r = await actions.run(name, text.textContent, params, (entryOf(name)?.timeout_s ?? 10) * 1000 + 3000);
        if (r?.result === 0) after?.();
      };
    });
    bits.buttons.push({ b, name, mode });
    return b;
  }

  // The commands that make sense for any place. Which can run now is decided as it changes.
  function placeCommands(parent, bits, at, altInput) {
    const fly = () => (store.S.mode === 4 ? t('act_goto') : t('act_goto_switch'));
    const flying = el('div', 'act-row', parent);
    const go = commandButton(flying, bits, 'goto', fly(), () => {
      const alt = altOf(altInput);
      return alt == null ? null : { lat: at[0], lon: at[1], alt, change_mode: true };
    }, { after: () => { if (card?.ref === 'place') closeCard(); } });
    bits.labels.push(() => put(go.firstElementChild, fly()));
    commandButton(flying, bits, 'land_at', t('act_land_at'), () => {
      const alt = altOf(altInput);
      return alt == null ? null : { lat: at[0], lon: at[1], alt };
    }, { after: () => { if (card?.ref === 'place') closeCard(); } });
    const other = el('div', 'act-row', parent);
    commandButton(other, bits, 'yaw', t('act_face'), () => {
      const away = fromHere(at);
      return away ? { heading: Math.round((away.bearing * 180 / Math.PI + 360) % 360) % 360, rate: FACE_RATE } : null;
    });
    const home = commandButton(other, bits, 'set_home', t('act_set_home_here'), () => ({ lat: at[0], lon: at[1] }));
    bits.visible.push(() => { home.hidden = !!store.S.armed; });
  }

  function whyRow(parent, bits) {
    const row = el('div', 'card-why', parent);
    const line = el('p', 'small soft', row);
    const open = el('button', 'plain small', row, t('openControl'));
    open.type = 'button';
    open.dataset.page = 'control';
    bits.why = { line, open };
  }

  function refreshCommands(bits) {
    const mine = actions.execOn();
    const usable = mine && live();
    let stopped = null;
    for (const { b, name, mode } of bits.buttons) {
      if (!b.isConnected) continue;
      const reason = reasonOf(name, mode);
      b.disabled = !usable || !!reason;
      if (reason && !b.hidden && !stopped) stopped = reason;
    }
    for (const update of bits.labels) update();
    for (const update of bits.visible) update();
    if (bits.why) {
      put(bits.why.line, !mine ? t(store.S.exec != null ? 'execOther' : 'needExec') : stopped ? t(`why_${stopped}`) : '');
      bits.why.open.hidden = mine || store.S.exec != null;
      bits.why.line.parentElement.hidden = !bits.why.line.textContent;
    }
  }

  // ---- Cards ------------------------------------------------------------------------

  const placeRows = at => [
    ['fromCraft', () => { const a = fromHere(at()); return a ? distance(a.metres) : null; }],
    ['bearingFrom', () => { const a = fromHere(at()); return a && a.metres >= 1 ? `${Math.round((a.bearing * 180 / Math.PI + 360) % 360)}°` : null; }],
    ['fromHomeL', () => {
      const h = store.S.home, p = at();
      if (!h || !p) return null;
      return distance(Math.hypot((p[0] - h[0]) * 111320, (p[1] - h[1]) * 111320 * Math.cos(p[0] * Math.PI / 180)));
    }],
    ['latlon', () => { const p = at(); return p ? `${p[0].toFixed(6)}, ${p[1].toFixed(6)}` : null; }],
  ];

  function addButtons(parent, at, altInput, after) {
    el('p', 'small soft card-label', parent, t('addAs'));
    const row = el('div', 'act-row', parent);
    const button = (key, action) => {
      const b = el('button', 'tile', row, t(key));
      b.type = 'button';
      b.addEventListener('click', action);
    };
    const alt = () => altOf(altInput, ALT_MIN, ALT_MAX);
    const put_ = (cmd, p) => {
      const value = alt();
      if (value == null) return;
      const seq = addPoint(at(), cmd, value, p);
      after?.();
      openDrawer();
      openCard(`item:${seq}`, true);
    };
    button('typeWaypoint', () => put_(CMD.WAYPOINT));
    button('typeLoiter', () => put_(CMD.LOITER_TIME, [LOITER_S, 0, 0, 0]));
    button('typeLand', () => put_(CMD.LAND));
    button('typeRally', () => {
      const value = alt();
      if (value == null) return;
      const list = ensureRally();
      list.push({ lat: at()[0], lon: at()[1], alt: value });
      changed();
      after?.();
      openDrawer();
      openCard(`rally:${list.length}`, true);
    });
    return button;
  }

  const startAlt = () => {
    const height = store.S.pos?.[3];
    return height >= 2 ? Math.round(height) : defaultAlt();
  };

  function cardForPlace(ref) {
    const here = () => card?.placeAt;
    return {
      title: () => t('cardPlace'),
      build(body, bits) {
        const facts = rows(body, placeRows(here));
        bits.update.push(facts);
        const altInput = altField(body, startAlt());
        const add = addButtons(body, here, altInput, () => map.setPick(null));
        add('typeNote', async () => {
          const at = here();
          const r = await actions.post('/api/marks', { op: 'add', lat: at[0], lon: at[1], name: t('noteName', { n: (store.S.marks?.length ?? 0) + 1 }) }).catch(() => null);
          if (r?.mark) {
            map.setPick(null);
            // The stream will say so too, a moment from now.
            store.S.marks = [...(store.S.marks ?? []), r.mark];
            afterChange();
            openCard(`note:${r.mark.id}`, true);
          } else {
            actions.notice(t('errOther'), 'red-text');
          }
        });
        el('p', 'small soft card-label', body, t('commandsNow'));
        placeCommands(body, bits, here(), altInput);
        whyRow(body, bits);
      },
    };
  }

  function cardForItem(seq) {
    const item = () => items()[seq - 1];
    const placed = () => {
      const list = draft.mission ? routeOfDraft(draft.mission, homeOf(), store.S.params?.RTL_ALT_M) : store.S.plan ? storedRoute() : null;
      return list?.points.find(p => p.seq === seq) ?? null;
    };
    const at = () => { const p = placed(); return p ? [p.lat, p.lon] : null; };
    const types = [['typeWaypoint', CMD.WAYPOINT], ['typeLoiter', CMD.LOITER_TIME], ['typeTurns', CMD.LOITER_TURNS], ['typeLand', CMD.LAND]];
    return {
      title: () => {
        const it = item();
        return it ? `${seq}  ${CMD_NAMES[store.lang][it.cmd] ?? `#${it.cmd}`}` : `${seq}`;
      },
      at,
      build(body, bits) {
        const it = item();
        if (!it) return;
        const below = el('div', 'card-edit');
        const facts = rows(body, [
          ['legFrom', () => {
            const list = (draft.mission ? routeOfDraft(draft.mission, homeOf(), store.S.params?.RTL_ALT_M) : storedRoute());
            const i = list.points.findIndex(p => p.seq === seq);
            if (i < 0) return null;
            const a = i ? list.points[i - 1] : list.start, b = list.points[i];
            return a ? distance(Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos(b.lat * Math.PI / 180))) : null;
          }],
          ...placeRows(at),
        ]);
        bits.update.push(facts);
        const canType = types.some(([, cmd]) => cmd === it.cmd);
        if (canType) {
          const seg = el('div', 'segments', below);
          for (const [key, cmd] of types) {
            const b = el('button', it.cmd === cmd ? 'on' : null, seg, t(key));
            b.type = 'button';
            b.addEventListener('click', () => {
              const list = ensureDraft();
              if (list[seq - 1].cmd === cmd) return;
              list[seq - 1].cmd = cmd;
              // Seconds are not turns: a new type starts from its own defaults.
              list[seq - 1].p = cmd === CMD.LOITER_TIME ? [LOITER_S, 0, 0, 0] : cmd === CMD.LOITER_TURNS ? [LOITER_TURNS, 0, LOITER_RADIUS_M, 0] : [0, 0, 0, 0];
              changed();
              rebuildCard();
            });
          }
        }
        const edit = el('div', 'act-row', below);
        const altInput = it.cmd === CMD.RTL || it.cmd === CMD.LAND ? null : altField(edit, it.alt || startAlt());
        altInput?.addEventListener('change', () => {
          const value = altOf(altInput, ALT_MIN, ALT_MAX);
          if (value == null) return;
          ensureDraft()[seq - 1].alt = value;
          changed();
        });
        if (it.cmd === CMD.LOITER_TIME || it.cmd === CMD.LOITER_TURNS) {
          const amount = altField(edit, it.p?.[0] ?? 0, it.cmd === CMD.LOITER_TIME ? 'fieldHoldS' : 'fieldTurns');
          amount.addEventListener('change', () => {
            // Whole numbers, and turns in one byte: that is how the flight controller keeps them.
            const value = Math.round(Number(amount.value));
            if (value > 0 && value <= (it.cmd === CMD.LOITER_TIME ? 3600 : 255)) {
              ensureDraft()[seq - 1].p[0] = value;
              changed();
            }
            amount.value = item()?.p?.[0] ?? '';    // what it really is now, whatever was typed
          });
        }
        if (it.cmd === CMD.LOITER_TURNS) {
          const radius = altField(edit, it.p?.[2] ?? 0, 'fieldRadius');
          radius.addEventListener('change', () => {
            const value = Math.round(Number(radius.value));
            if (value >= 0 && value <= MAX_RADIUS_M) {
              ensureDraft()[seq - 1].p[2] = value;
              changed();
            }
            radius.value = item()?.p?.[2] ?? '';
          });
        }
        const arrange = el('div', 'act-row', below);
        for (const [key, action] of [['moveEarlier', () => moveItem(seq, -1)], ['moveLater', () => moveItem(seq, 1)], ['deleteIt', () => removeItem(seq)]]) {
          const b = el('button', 'tile', arrange, t(key));
          b.type = 'button';
          b.addEventListener('click', action);
        }
        if (at()) {
          el('p', 'small soft card-label', body, t('commandsNow'));
          const fallback = altInput ?? { value: String(startAlt()) };
          placeCommands(body, bits, at(), fallback);
          if (!editing()) {
            const next = el('div', 'act-row', body);
            commandButton(next, bits, 'mission_item', t('act_mission_item'), () => ({ seq }));
          }
          whyRow(body, bits);
        }
        body.append(below);
      },
    };
  }

  function cardForRally(n) {
    const point = () => rallyList()[n - 1];
    const at = () => { const r = point(); return r ? [r.lat, r.lon] : null; };
    return {
      title: () => `R${n}  ${t('typeRally')}`,
      at,
      build(body, bits) {
        const r = point();
        if (!r) return;
        bits.update.push(rows(body, placeRows(at)));
        const below = el('div', 'card-edit');
        const altInput = altField(below, r.alt);
        altInput.addEventListener('change', () => {
          const value = altOf(altInput, ALT_MIN, ALT_MAX);
          if (value == null) return;
          ensureRally()[n - 1].alt = value;
          changed();
        });
        const arrange = el('div', 'act-row', below);
        const remove = el('button', 'tile', arrange, t('deleteIt'));
        remove.type = 'button';
        remove.addEventListener('click', () => {
          ensureRally().splice(n - 1, 1);
          closeCard();
          changed();
        });
        el('p', 'small soft card-label', body, t('commandsNow'));
        placeCommands(body, bits, at(), altInput);
        whyRow(body, bits);
        body.append(below);
      },
    };
  }

  function cardForNote(id) {
    const note = () => store.S.marks?.find(m => m.id === id);
    const at = () => { const m = note(); return m ? [m.lat, m.lon] : null; };
    return {
      title: () => note()?.name ?? t('cardPlace'),
      at,
      build(body, bits) {
        if (!note()) return;
        bits.update.push(rows(body, placeRows(at)));
        const below = el('div', 'card-edit');
        const wrap = el('label', 'field', below);
        el('span', 'soft', wrap, t('noteTitle'));
        const name = el('input', null, wrap);
        name.type = 'text';
        name.maxLength = 40;
        name.value = note().name;
        name.addEventListener('change', () => { if (name.value.trim()) actions.post('/api/marks', { op: 'update', id, name: name.value }); });
        const altInput = altField(below, startAlt());
        addButtons(below, at, altInput);
        el('p', 'small soft card-label', body, t('commandsNow'));
        placeCommands(body, bits, at(), altInput);
        whyRow(body, bits);
        body.append(below);
        const arrange = el('div', 'act-row', below);
        const remove = el('button', 'tile', arrange, t('deleteIt'));
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          await actions.post('/api/marks', { op: 'remove', id }).catch(() => null);
          closeCard();
        });
      },
    };
  }

  function cardForHome() {
    const at = () => (store.S.home ? [store.S.home[0], store.S.home[1]] : null);
    return {
      title: () => t('cardHome'),
      at,
      build(body, bits) {
        bits.update.push(rows(body, [
          ['fromCraft', () => { const h = fromHome(); return h ? distance(h.metres) : null; }],
          ['bearingFrom', () => { const h = fromHome(); return h && h.metres >= 1 ? `${Math.round((h.bearing * 180 / Math.PI + 360) % 360)}°` : null; }],
          ['msl', () => (store.S.home ? `${fixed(store.S.home[2])} m` : null)],
          ['rtlAlt', () => (store.S.params?.RTL_ALT_M != null ? `${fixed(store.S.params.RTL_ALT_M)} m` : null)],
          ['latlon', () => { const p = at(); return p ? `${p[0].toFixed(6)}, ${p[1].toFixed(6)}` : null; }],
        ]));
        el('p', 'small soft card-label', body, t('commandsNow'));
        const row = el('div', 'act-row', body);
        commandButton(row, bits, 'mode', MODES[store.lang][6], () => ({ mode: 6 }), { mode: 6 });
        const below = el('div', 'card-edit');
        const altInput = altField(below, startAlt());
        placeCommands(body, bits, at(), altInput);
        whyRow(body, bits);
        body.append(below);
      },
    };
  }

  function cardForCraft() {
    const S = () => store.S;
    return {
      title: () => {
        const mode = MODES[store.lang][S().mode];
        return `${t(S().armed ? 'armed' : 'disarmed')}${mode ? `  ${mode}` : ''}`;
      },
      at: () => (S().pos?.[0] != null ? [S().pos[0], S().pos[1]] : null),
      build(body, bits) {
        bits.update.push(rows(body, [
          ['altitude', () => (S().pos ? `${fixed(S().pos[3])} m` : null)],
          ['speed', () => (S().hud ? `${fixed(S().hud[0])} m/s` : null)],
          ['headingL', () => (S().hud ? `${S().hud[3]}°` : null)],
          ['voltage', () => (S().volts != null ? `${S().volts.toFixed(2)} V` : null)],
          ['fixType', () => (S().gps ? gpsSummary().text : null)],
          ['fromHomeL', () => { const h = fromHome(); return h ? distance(h.metres) : null; }],
          ['pendingL', () => (S().pending ? t('pendingLand') : null), () => 'amber'],
        ]));
        el('p', 'small soft card-label', body, t('commandsNow'));
        const ground = el('div', 'act-row', body);
        const arm = commandButton(ground, bits, 'arm', t('arm'));
        const disarm = commandButton(ground, bits, 'disarm', t('disarm'));
        const altInput = altField(ground, TAKEOFF_ALT);
        const takeoff = commandButton(ground, bits, 'takeoff', t('act_takeoff'), () => {
          const alt = altOf(altInput, 1, 120);
          return alt == null ? null : { alt };
        });
        const flight = el('div', 'act-row', body);
        const toGuided = commandButton(flight, bits, 'mode', MODES[store.lang][4], () => ({ mode: 4 }), { mode: 4 });
        commandButton(flight, bits, 'mode', MODES[store.lang][17], () => ({ mode: 17 }), { mode: 17 });
        commandButton(flight, bits, 'mode', MODES[store.lang][6], () => ({ mode: 6 }), { mode: 6 });
        commandButton(flight, bits, 'mode', MODES[store.lang][9], () => ({ mode: 9 }), { mode: 9 });
        const flow = el('div', 'act-row', body);
        const pause = commandButton(flow, bits, 'pause', t('act_pause'));
        const resume = commandButton(flow, bits, 'resume', t('act_resume'));
        const noLand = commandButton(flow, bits, 'land_cancel', t('act_land_cancel'));
        bits.visible.push(() => {
          const flying = !!S().armed && !store.S.avail?.goto;
          arm.hidden = !!S().armed;
          disarm.hidden = !S().armed;
          altInput.parentElement.hidden = takeoff.hidden = !!flying;
          toGuided.hidden = S().mode === 4;
          pause.hidden = resume.hidden = !flying;
          noLand.hidden = !S().pending;
        });
        whyRow(body, bits);
      },
    };
  }

  function cardForFence() {
    return {
      title: () => t('secFence'),
      at: () => null,
      build(body, bits) {
        const p = () => store.S.params ?? {};
        bits.update.push(rows(body, [
          ['health', () => fenceState()?.text, () => fenceState()?.tone],
          ['fenceAction', () => (p().FENCE_ACTION != null ? t(FENCE_ACTIONS[p().FENCE_ACTION] ?? 'fenceActOther') : null)],
          ['fenceCeiling', () => (p().FENCE_TYPE & 1 && p().FENCE_ALT_MAX ? `${Math.round(p().FENCE_ALT_MAX)} m` : null)],
          ['fenceRadius', () => (p().FENCE_TYPE & 2 && p().FENCE_RADIUS ? `${Math.round(p().FENCE_RADIUS)} m` : null)],
        ]));
        const open = el('button', 'tile', body, t('pagePlan'));
        open.type = 'button';
        open.dataset.page = 'plan';
      },
    };
  }

  const homeOf = () => (store.S.home ? { lat: store.S.home[0], lon: store.S.home[1], msl: store.S.home[2] } : null);
  const storedRoute = () => routeOfDraft(seedDraft(store.S), homeOf(), store.S.params?.RTL_ALT_M);

  function cardFor(ref) {
    const [kind, id] = ref.split(':');
    if (kind === 'place') return cardForPlace(ref);
    if (kind === 'item') return cardForItem(+id);
    if (kind === 'rally') return cardForRally(+id);
    if (kind === 'note') return cardForNote(id);
    if (kind === 'home') return cardForHome();
    if (kind === 'craft') return cardForCraft();
    if (kind === 'fence') return cardForFence();
    return null;
  }

  function openCard(ref, pinned, placeAt = null) {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    const definition = cardFor(ref);
    if (!definition) return;
    const same = card?.ref === ref && !placeAt;
    if (same) {
      card.pinned ||= pinned;
      cardEl.classList.toggle('pinned', card.pinned);
      return;
    }
    if (ref !== 'place') map.setPick(null);
    const bits = { buttons: [], labels: [], visible: [], update: [], why: null };
    card = {
      ref, pinned, placeAt,
      at: definition.at ?? (() => card?.placeAt),
      refresh() {
        put(titleEl, definition.title());
        for (const update of bits.update) update();
        refreshCommands(bits);
        position();
      },
    };
    bodyEl.textContent = '';
    definition.build(bodyEl, bits);
    cardEl.classList.toggle('pinned', pinned);
    cardEl.hidden = false;
    map.setSelected(ref);
    card.refresh();
  }

  function rebuildCard() {
    if (!card) return;
    const { ref, placeAt } = card;
    card = null;
    openCard(ref, true, placeAt);
  }

  function closeCard() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!card) return;
    if (card.ref === 'place') map.setPick(null);
    card = null;
    cardEl.hidden = true;
    bodyEl.textContent = '';
    map.setSelected(null);
  }

  function position() {
    // A button being held must not move out from under the finger.
    if (!card || cardEl.hidden || cardEl.querySelector('.holding')) return;
    if (narrow.matches) {
      cardEl.style.transform = '';
      return;
    }
    const w = cardEl.offsetWidth, h = cardEl.offsetHeight;
    const at = card.at?.();
    let x, y;
    if (at) {
      const s = map.screenOf(at[0], at[1]);
      if (!s) return;
      x = s[0] + CARD_GAP;
      if (x + w > innerWidth - EDGE) x = s[0] - CARD_GAP - w;
      y = s[1] - 28;
    } else {
      x = drawerOpen ? drawerEl.getBoundingClientRect().right + CARD_GAP : EDGE * 2;
      y = 120;
    }
    x = Math.max(EDGE, Math.min(x, innerWidth - w - EDGE));
    y = Math.max(EDGE, Math.min(y, innerHeight - h - EDGE));
    cardEl.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }

  cardEl.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  cardEl.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') closeSoon(); });
  // Touching a card means staying with it.
  const pin = () => {
    if (!card) return;
    card.pinned = true;
    cardEl.classList.add('pinned');
  };
  cardEl.addEventListener('pointerdown', pin);
  cardEl.addEventListener('focusin', pin);
  $('card-close').addEventListener('click', closeCard);

  function closeSoon() {
    clearTimeout(openTimer);
    if (!card || card.pinned) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeCard, HOVER_CLOSE_MS);
  }

  // ---- The drawer: the mission as a list -----------------------------------------------

  function renderDrawer() {
    drawerEl.hidden = !drawerOpen || !mapMain() || pageOpen();
    document.documentElement.classList.toggle('adding', adding && mapMain());
    $('map-plan').classList.toggle('on', drawerOpen);
    $('map-plan').classList.toggle('unsaved', hasDraft());
    if (drawerEl.hidden) return;
    // However many reasons it cannot arm are listed at the top, all of them stay readable above this.
    drawerEl.style.setProperty('--under-status', `${Math.ceil($('status').getBoundingClientRect().bottom) + CARD_GAP}px`);
    const S = store.S;
    const list = items();
    put($('plan-state'), hasDraft() ? t('draftState') : t('storedState'));
    $('plan-state').className = hasDraft() ? 'small amber' : 'small soft';
    const route = routeOfDraft(list, homeOf(), S.params?.RTL_ALT_M);
    const stats = routeStats(route, list, S.params?.WP_SPD);
    put($('plan-summary'), list.length ? t('draftSummary', { n: list.length, d: distance(stats.metres), h: Math.round(stats.top), t: clock(stats.seconds) }) : t('planNone'));

    const key = store.lang + JSON.stringify(list) + (S.mission?.[0] ?? '') + (card?.ref ?? '');
    if (key !== listKey) {
      listKey = key;
      listEl.textContent = '';
      const legs = new Map();
      let last = route.start;
      for (const p of route.points) {
        if (p.seq != null && last) legs.set(p.seq, Math.hypot((p.lat - last.lat) * 111320, (p.lon - last.lon) * 111320 * Math.cos(p.lat * Math.PI / 180)));
        last = p;
      }
      const heights = new Map(route.points.map(p => [p.seq, p.alt]));
      list.forEach((item, i) => {
        const seq = i + 1;
        const row = el('button', `item${card?.ref === `item:${seq}` ? ' picked' : ''}${!editing() && S.mission?.[0] === seq ? ' next' : ''}`, listEl);
        row.type = 'button';
        el('span', 'soft', row, String(seq));
        el('span', null, row, CMD_NAMES[store.lang][item.cmd] ?? `#${item.cmd}`);
        el('span', 'soft', row, legs.has(seq) && legs.get(seq) >= 1 ? distance(legs.get(seq)) : '');
        el('span', 'right', row, heights.has(seq) ? `${Math.round(heights.get(seq))} m` : '');
        row.addEventListener('click', () => openCard(`item:${seq}`, true));
        row.addEventListener('pointerenter', () => map.setSelected(`item:${seq}`));
        row.addEventListener('pointerleave', () => map.setSelected(card?.ref ?? null));
      });
    }

    warnEl.textContent = '';
    if (draft.mission) {
      const allowed = entryOf('plan_upload')?.mission_commands;
      for (const w of draftWarnings(draft.mission, route, S, allowed)) el('p', 'small amber', warnEl, t(w.key, w.vars));
    }
    $('plan-add').setAttribute('aria-checked', String(adding));
    $('plan-new').hidden = hasDraft();
    $('plan-edit').hidden = hasDraft() || !stored().length;
    for (const id of ['plan-write', 'plan-discard', 'plan-takeoff', 'plan-rtl']) $(id).hidden = !hasDraft();
    $('plan-takeoff').hidden ||= list[0]?.cmd === CMD.TAKEOFF;
    const lastCmd = list[list.length - 1]?.cmd;
    $('plan-rtl').hidden ||= lastCmd === CMD.RTL || lastCmd === CMD.LAND || !list.length;
    const mine = actions.execOn();
    const stopped = reasonOf('plan_upload');
    $('plan-write').disabled = !mine || !live() || !!stopped;
    put($('plan-why'), !hasDraft() ? '' : !mine ? t('needExec') : stopped ? t(`why_${stopped}`) : '');
    $('plan-open-control').hidden = !hasDraft() || mine || S.exec != null;
    renderExtras();
  }

  function renderExtras() {
    const host = $('plan-extras');
    const key = Object.keys(extras).join();
    if (host.dataset.key !== key) {
      host.dataset.key = key;
      host.textContent = '';
      for (const [kind, list] of Object.entries(extras)) {
        const b = el('button', 'hold tile', host);
        b.type = 'button';
        const label = el('span', null, b, t('act_upload', { what: t(`kind_${kind}`), n: list.length }));
        actions.pressButton(b, () => async () => {
          const r = await actions.run('plan_upload', label.textContent, { kind, items: list }, 120000);
          if (r?.result === 0) {
            delete extras[kind];
            renderDrawer();
          }
        });
      }
    }
    for (const b of host.children) b.disabled = !actions.execOn() || !live() || !!reasonOf('plan_upload');
  }

  function openDrawer() {
    drawerOpen = true;
    renderDrawer();
    afterChange();
  }

  $('map-plan').addEventListener('click', () => {
    drawerOpen = !drawerOpen;
    if (!drawerOpen) adding = false;
    renderDrawer();
    afterChange();
  });
  $('plan-close').addEventListener('click', () => {
    drawerOpen = false;
    adding = false;
    renderDrawer();
    afterChange();
  });
  $('plan-add').addEventListener('click', () => {
    adding = !adding;
    if (adding) closeCard();
    renderDrawer();
  });
  $('plan-edit').addEventListener('click', () => { ensureDraft(); changed(); });
  $('plan-new').addEventListener('click', () => {
    draft.mission = [];
    adding = true;
    closeCard();
    changed();
  });
  $('plan-discard').addEventListener('click', discard);
  $('plan-takeoff').addEventListener('click', () => {
    const list = ensureDraft();
    shiftJumps(list, 1, 1);
    list.unshift({ cmd: CMD.TAKEOFF, alt: defaultAlt(), p: [0, 0, 0, 0] });
    changed();
  });
  $('plan-rtl').addEventListener('click', () => {
    ensureDraft().push({ cmd: CMD.RTL, p: [0, 0, 0, 0] });
    changed();
  });
  actions.pressButton($('plan-write'), () => {
    const mission = draft.mission, rally = draft.rally;
    return async () => {
      if (mission) {
        const r = await actions.run('plan_upload', t('act_plan_upload'), { kind: 'mission', items: mission }, 120000);
        if (r?.result !== 0) return;
        draft.mission = null;
        changed();
        if (rally) await new Promise(done => setTimeout(done, WRITE_GAP_MS));
      }
      if (rally?.length) {
        const r = await actions.run('plan_upload', t('act_plan_upload'), { kind: 'rally', items: rally }, 120000);
        if (r?.result !== 0) return;
      } else if (rally) {
        const r = await actions.run('plan_clear', t('act_plan_clear'), { kind: 'rally' }, 30000);
        if (r?.result !== 0) return;
      }
      draft.rally = null;
      changed();
    };
  });
  $('plan-import').addEventListener('click', () => $('plan-file').click());
  $('plan-file').addEventListener('change', async () => {
    const f = $('plan-file').files[0];
    $('plan-file').value = '';
    if (!f) return;
    let parsed;
    try {
      parsed = parsePlanFile(await f.text());
    } catch {
      actions.notice(t('fileBad', { name: f.name }), 'red-text');
      return;
    }
    if (parsed.mission) draft.mission = parsed.mission;
    if (parsed.rally) draft.rally = parsed.rally;
    extras = parsed.fence ? { fence: parsed.fence } : {};
    closeCard();
    changed();
  });
  $('plan-export').addEventListener('click', () => {
    const list = items();
    if (!list.length) return;
    const url = URL.createObjectURL(new Blob([toWaypointsFile(list, homeOf())], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.waypoints`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $('plan-alt').value = localStorage.getItem('planAlt') ?? DEFAULT_ALT;
  $('plan-alt').addEventListener('change', () => localStorage.setItem('planAlt', String(defaultAlt())));

  // ---- From the map ---------------------------------------------------------------------

  return {
    draftShapes,
    closeCard,
    closePanels() {
      closeCard();
      drawerOpen = false;
      adding = false;
      renderDrawer();
    },
    toggleDrawer: () => $('map-plan').click(),
    deleteSelected() {
      if (card?.ref.startsWith('item:')) removeItem(+card.ref.split(':')[1]);
    },
    tap(at, always = false) {
      if (adding) {
        addPoint(at, CMD.WAYPOINT, defaultAlt());
        return;
      }
      // One tap brings a window up and the next on bare map puts it away. A window only being hovered
      // over was not brought up by a tap, so getting rid of it does not cost one.
      if (card?.pinned && !always) {
        closeCard();
        return;
      }
      map.setPick(at);
      openCard('place', true, at);
    },
    object(ref, type) {
      if (ref.startsWith('mid:')) {
        // A tap on the handle between two points puts a new one halfway.
        if (type !== 'tap') return;
        const seq = +ref.split(':')[1];
        const route = draftShapes()?.route;
        const i = route?.points.findIndex(p => p.seq === seq);
        const b = route?.points[i], a = i > 0 ? route.points[i - 1] : route?.start;
        if (!a || !b) return;
        this.drag(ref, [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], 'start');
        openCard(`item:${seq}`, true);
        return;
      }
      if (type === 'tap') {
        openCard(ref, true);
      } else if (type === 'enter') {
        clearTimeout(closeTimer);
        clearTimeout(openTimer);
        if (card?.pinned || adding) return;
        openTimer = setTimeout(() => openCard(ref, false), HOVER_OPEN_MS);
      } else if (type === 'leave') {
        closeSoon();
      }
    },
    drag(ref, at, phase) {
      let [kind, id] = ref.split(':');
      if (kind === 'mid') {
        if (phase === 'start') {
          const list = ensureDraft();
          const before = list[+id - 1], alt = before?.alt || defaultAlt();
          shiftJumps(list, +id, 1);
          list.splice(+id - 1, 0, { cmd: CMD.WAYPOINT, lat: at[0], lon: at[1], alt, p: [0, 0, 0, 0] });
        }
        kind = 'item';
      }
      if (kind === 'item') {
        const item = ensureDraft()[+id - 1];
        if (item) {
          item.lat = at[0];
          item.lon = at[1];
        }
        closeCard();
        changed(phase !== 'move');
      } else if (kind === 'rally') {
        const r = ensureRally()[+id - 1];
        if (r) {
          r.lat = at[0];
          r.lon = at[1];
        }
        closeCard();
        changed(phase === 'end');
      } else if (kind === 'note') {
        const m = store.S.marks?.find(x => x.id === id);
        if (m) {
          m.lat = at[0];
          m.lon = at[1];
        }
        map.setNotes(store.S.marks, true);
        if (phase === 'end') actions.post('/api/marks', { op: 'update', id, lat: at[0], lon: at[1] });
      }
    },
    moved: position,
    // Called whenever new data arrives.
    refresh() {
      if (pageOpen() || !mapMain()) closeCard();
      card?.refresh();
      renderDrawer();
    },
    openEditor: openDrawer,
    drawerOpen: () => drawerOpen,
  };
}
