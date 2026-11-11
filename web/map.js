// A small slippy map. The tiles come straight from the map provider to the viewer's
// browser, so they cost this device nothing.

import { rangeRings } from '/rings.js';
import { CMD, nextPoint, placesOf, pointLabel } from '/plan.js';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 256;
const EARTH = 40075016.686;     // metres round the equator, for metres per pixel
const MAX_ZOOM = 22;            // how far in the map goes
const NATIVE_MAX = 20;          // imagery is asked for up to this level and scaled up beyond it
const BLANK_FROM = 19;          // from this level on, a flat tile means the imagery stops lower down
const AUTO_MAX = 19;            // chosen automatically, the map stays where the imagery is sharp
const MIN_ZOOM = 3;
const SCALE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const SCALE_MAX_PX = 110;
const RECENTRE_MS = 280;
const TILE_RETRY_MS = 20000;
const GAP_S = 30;
const TAP_PX = 6;
const TAP_MS = 600;
const FIT_ROOM = .8;            // the part of the map a fitted view fills
const RING_LABEL_MIN_PX = 34;
const HANDLE_MIN_PX = 56;
const tile = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// A position on the map of level 0, in pixels. Multiply by 2^z for any other level.
function world(lat, lon) {
  const s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * SIZE, (.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * SIZE];
}

function place(x, y) {
  const lon = x / SIZE * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / SIZE))) * 180 / Math.PI;
  return [lat, lon];
}

const svg = (name, cls, parent) => {
  const e = document.createElementNS(NS, name);
  if (cls) e.setAttribute('class', cls);
  parent?.append(e);
  return e;
};

const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');

export class TileMap {
  constructor(root, { onChange = () => {}, onTap = () => {}, onObject = () => {}, onDrag = () => {}, onMoved = () => {} } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.onTap = onTap;
    this.onObject = onObject;   // a thing on the map was hovered over or tapped
    this.onDrag = onDrag;       // a thing on the map is being moved
    this.onMoved = onMoved;     // what is on the screen has shifted
    this.tiles = root.querySelector('.tiles');
    this.trailEl = root.querySelector('.trail');
    this.craftEl = root.querySelector('.craft-at');
    this.homeEl = root.querySelector('.home-at');
    this.ringsEl = root.querySelector('.rings');
    this.scaleEl = root.querySelector('.scale');
    this.planEl = root.querySelector('.plan');
    this.targetEl = root.querySelector('.target');
    this.pickEl = root.querySelector('.pick');
    this.predictEl = root.querySelector('.predict');
    this.predictEndEl = root.querySelector('.predict-end');
    this.prediction = null;
    this.beforePrediction = null;
    this.main = false;      // on the whole stage, where it can be moved about
    this.rings = true;
    this.tilesOn = true;
    this.markerScale = 1;
    this.shapes = null;     // what is stored on the flight controller, from plan.js
    this.show = { plan: true, fence: true, rally: true };
    this.planBuilt = null;
    this.current = 0;       // the mission item it is flying to
    this.target = null;     // the point it is heading for, as [lat, lon]
    this.pick = null;       // a point the viewer has chosen, as [lat, lon]
    this.draft = null;      // a mission being edited, in the same form as what is stored
    this.notes = [];        // the viewers' own marks
    this.notesVersion = 0;
    this.selected = null;   // the thing whose card is open
    this.press = null;
    this.dragging = null;
    this.loaded = new Map();
    this.tileMax = NATIVE_MAX;     // lowered where the imagery turns out to stop sooner
    this.trail = [];        // [lat, lon, altitude, time], kept by the page
    this.zoom = null;       // null while choosing automatically
    this.shownZoom = null;  // where the zoom is on its way there
    this.free = null;       // where the viewer has moved the map to, or null while it follows the aircraft
    this.tween = null;      // on the way back to the aircraft
    this.pos = null;
    this.home = null;
    this.heading = 0;
    this.pointers = new Map();
    this.pinch = null;
    new ResizeObserver(() => this.render()).observe(root);
    root.addEventListener('wheel', e => {
      e.preventDefault();
      this.setZoom(this.targetZoom() + Math.max(-.6, Math.min(.6, -e.deltaY * .004)));
    }, { passive: false });
    root.addEventListener('pointerdown', e => {
      if (!this.main || (e.pointerType === 'mouse' && e.button !== 0)) return;
      root.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      const thing = e.target.closest?.('[data-ref]');
      this.press = this.pointers.size === 1
        ? { x: e.clientX, y: e.clientY, at: performance.now(), ref: thing?.dataset.ref ?? null, drag: thing?.dataset.drag === '1' }
        : null;
      if (this.pointers.size === 2) {
        this.dragging = null;
        const [a, b] = [...this.pointers.values()];
        this.pinch = { span: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.targetZoom() };
      }
    });
    root.addEventListener('pointermove', e => {
      const last = this.pointers.get(e.pointerId);
      if (!last) return;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.dragging) {
        this.dragTo(e, 'move');
        return;
      }
      if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) >= TAP_PX) {
        if (this.press.drag) {
          this.dragging = this.press.ref;
          this.press = null;
          this.dragTo(e, 'start');
          return;
        }
        this.press = null;
      } else if (this.press) {
        return;    // not a drag yet, so a small slip while tapping moves nothing
      }
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (span > 10) this.setZoom(this.pinch.zoom + Math.log2(span / this.pinch.span), true);
      } else if (this.pointers.size === 1) {
        this.pan(e.clientX - last[0], e.clientY - last[1]);
      }
    });
    const up = e => {
      const known = this.pointers.delete(e.pointerId);
      if (this.dragging) {
        if (e.type === 'pointerup') this.dragTo(e, 'end');
        this.dragging = null;
      } else if (known && e.type === 'pointerup' && this.press && performance.now() - this.press.at < TAP_MS) {
        if (this.press.ref) {
          this.onObject(this.press.ref, 'tap');
        } else {
          const at = this.eventPlace(e);
          if (at) this.onTap(at);
        }
      }
      this.press = null;
      if (this.pointers.size < 2) this.pinch = null;
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    // A mouse can look before it touches.
    root.addEventListener('pointerover', e => {
      if (!this.main || e.pointerType !== 'mouse' || this.pointers.size) return;
      const thing = e.target.closest?.('[data-ref]');
      if (thing) this.onObject(thing.dataset.ref, 'enter');
    });
    root.addEventListener('pointerout', e => {
      if (!this.main || e.pointerType !== 'mouse') return;
      const thing = e.target.closest?.('[data-ref]');
      if (thing && !thing.contains(e.relatedTarget)) this.onObject(thing.dataset.ref, 'leave');
    });
    root.addEventListener('contextmenu', e => {
      if (!this.main) return;
      e.preventDefault();
      const thing = e.target.closest?.('[data-ref]');
      if (thing) {
        this.onObject(thing.dataset.ref, 'tap');
      } else {
        const at = this.eventPlace(e);
        if (at) this.onTap(at, true);   // a right click asks about that place, whatever is open
      }
    });
  }

  eventPlace(e) {
    const r = this.root.getBoundingClientRect();
    return this.placeAt(e.clientX - r.left, e.clientY - r.top);
  }

  dragTo(e, phase) {
    const at = this.eventPlace(e);
    if (at) this.onDrag(this.dragging, at, phase);
  }

  // Where a place is on the screen.
  screenOf(lat, lon) {
    const centre = this.shownCentre;
    if (!centre) return null;
    const k = 2 ** (this.shownZoom ?? this.targetZoom());
    const [x, y] = world(lat, lon);
    const r = this.root.getBoundingClientRect();
    return [(x - centre[0]) * k + this.root.clientWidth / 2 + r.left, (y - centre[1]) * k + this.root.clientHeight / 2 + r.top];
  }

  setDraft(draft) {
    if (draft === this.draft) return;
    this.draft = draft;
    this.render();
  }

  setNotes(notes, moved = false) {
    if (notes === this.notes && !moved) return;
    this.notes = notes ?? [];
    this.notesVersion++;
    this.render();
  }

  setSelected(ref) {
    if (ref === this.selected) return;
    this.selected = ref;
    this.render();
  }

  setRings(on) {
    if (on === this.rings) return;
    this.rings = on;
    this.render();
  }

  // How large the aircraft is drawn.
  setMarker(scale) {
    if (scale === this.markerScale) return;
    this.markerScale = scale;
    this.render();
  }

  setPlan(shapes, show) {
    if (shapes === this.shapes && show.plan === this.show.plan && show.fence === this.show.fence && show.rally === this.show.rally) return;
    this.shapes = shapes;
    this.show = { ...show };
    this.render();
  }

  setProgress(current, target) {
    if (current === this.current && target?.[0] === this.target?.[0] && target?.[1] === this.target?.[1]) return;
    this.current = current;
    this.target = target;
    this.render();
  }

  setPick(point) {
    this.pick = point;
    this.render();
  }

  // What a command would do, before it is sent, with `label` at its end. If it does not all fit, the view
  // moves to show it, and goes back to where it was when it is gone.
  setPrediction(flight, label = '') {
    const first = flight && !this.prediction;
    this.prediction = flight;
    this.predictLabel = label;
    if (first && this.main && this.shownCentre) {
      const w = this.root.clientWidth, h = this.root.clientHeight;
      const k = 2 ** (this.shownZoom ?? this.targetZoom());
      const offScreen = flight.points.some(p => {
        const [x, y] = world(p.lat, p.lon);
        const sx = w / 2 + (x - this.shownCentre[0]) * k, sy = h / 2 + (y - this.shownCentre[1]) * k;
        return sx < 40 || sx > w - 40 || sy < 40 || sy > h - 40;
      });
      if (offScreen) {
        this.beforePrediction = { free: this.free, zoom: this.zoom };
        this.showPlaces(flight.points.map(p => [p.lat, p.lon]));
        return;
      }
    }
    if (!flight && this.beforePrediction) {
      ({ free: this.free, zoom: this.zoom } = this.beforePrediction);
      this.beforePrediction = null;
      this.tween = null;
      this.onChange();
    }
    this.render();
  }

  // Shows everything stored, with the aircraft, whatever that takes.
  fit() {
    const places = placesOf(this.shapes, this.show);
    if (this.draft?.route) for (const p of this.draft.route.points) places.push([p.lat, p.lon]);
    for (const note of this.notes) places.push([note.lat, note.lon]);
    this.showPlaces(places);
  }

  showPlaces(places) {
    if (this.pos) places.push(this.pos);
    if (this.home) places.push(this.home);
    if (!places.length) return;
    const points = places.map(p => world(p[0], p[1]));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const zoom = Math.log2(Math.min(w * FIT_ROOM / Math.max(right - left, 1e-9), h * FIT_ROOM / Math.max(bottom - top, 1e-9)));
    this.zoom = Math.max(MIN_ZOOM, Math.min(NATIVE_MAX, zoom));
    this.free = [(left + right) / 2, (top + bottom) / 2];
    this.tween = null;
    this.onChange();
    this.render();
  }

  // Where a point on the screen is.
  placeAt(x, y) {
    const centre = this.shownCentre;
    if (!centre) return null;
    const k = 2 ** (this.shownZoom ?? this.targetZoom());
    return place(centre[0] + (x - this.root.clientWidth / 2) / k, centre[1] + (y - this.root.clientHeight / 2) / k);
  }

  // Without imagery the map is a plain plot of positions round home, and asks for no tiles.
  setTiles(on) {
    if (on === this.tilesOn) return;
    this.tilesOn = on;
    this.render();
  }

  setMain(on) {
    this.main = on;
    this.pointers.clear();
    this.pinch = null;
  }

  get following() { return !this.free; }

  nudge(step) { this.setZoom(Math.round(this.targetZoom()) + step); }

  setZoom(z, now = false) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (now) this.shownZoom = this.zoom;
    this.render();
  }

  // Back to the aircraft, at the automatic zoom.
  resetView() {
    this.zoom = null;
    this.free = null;
    this.tween = null;
    this.render();
  }

  recentre() {
    if (!this.free) return;
    this.tween = { from: this.free, at: performance.now() };
    this.free = null;
    this.onChange();
    this.render();
  }

  // What the map is centred on when the viewer has not moved it. With no position yet there may
  // still be a home or a stored plan to look at.
  anchor() {
    if (this.pos) return this.pos;
    if (this.home) return this.home;
    return placesOf(this.shapes, this.show)[0] ?? null;
  }

  pan(dx, dy) {
    const anchor = this.anchor();
    if (!anchor) return;
    const k = 2 ** (this.shownZoom ?? this.targetZoom());
    const [x, y] = this.free ?? world(...anchor);
    const wasFollowing = !this.free;
    this.free = [x - dx / k, y - dy / k];
    this.tween = null;
    if (wasFollowing) this.onChange();
    this.render();
  }

  targetZoom() { return this.zoom ?? this.autoZoom(); }

  // Close enough to read, far enough to keep home in view, and on the whole stage also what is stored.
  autoZoom() {
    const anchor = this.anchor();
    if (!anchor) return 18;
    const places = this.main ? placesOf(this.shapes, this.show) : [];
    if (this.main && this.draft?.route) for (const p of this.draft.route.points) places.push([p.lat, p.lon]);
    if (this.home) places.push(this.home);
    if (!places.length) return 18;
    const room = Math.min(this.root.clientWidth, this.root.clientHeight) * .4;
    const [ax, ay] = world(...anchor);
    let apart = 0;
    for (const p of places) {
      const [bx, by] = world(p[0], p[1]);
      apart = Math.max(apart, Math.hypot(ax - bx, ay - by));
    }
    for (let z = AUTO_MAX; z > MIN_ZOOM; z--) if (apart * 2 ** z < room) return z;
    return MIN_ZOOM;
  }

  update(lat, lon, heading, home, trail = [], trailVersion = 0) {
    const key = `${lat},${lon},${Math.round(heading)},${home},${trailVersion}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.heading = heading;
    this.home = home;
    this.trail = trail;
    this.pos = lat == null ? null : [lat, lon];
    this.root.classList.toggle('has-fix', !!this.pos);
    this.render();
  }

  // The provider answers for levels it has no imagery at with a flat placeholder, not an error.
  // Such a tile is read back once loaded; if it is flat, the imagery stops below that level.
  // With no connection a tile just stays out of sight, and is asked for again a while later.
  fetchTile(key, z, x, y) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
    img.addEventListener('load', () => {
      img.style.visibility = '';
      img.classList.add('in');
      if (img.crossOrigin && this.flat(img) && z <= this.tileMax) this.tileMax = z - 1;
      this.schedule();
    });
    img.addEventListener('error', () => {
      if (img.crossOrigin) {        // perhaps only reading it back is refused
        img.crossOrigin = null;
        img.src = tile(z, x, y);
        return;
      }
      img.style.visibility = 'hidden';
      this.schedule();
      setTimeout(() => {
        if (this.loaded.get(key) !== img) return;
        img.remove();
        this.loaded.delete(key);
        this.schedule();
      }, TILE_RETRY_MS);
    });
    if (z >= BLANK_FROM) img.crossOrigin = 'anonymous';
    img.src = tile(z, x, y);
    return img;
  }

  flat(img) {
    try {
      const probe = this.probe ??= document.createElement('canvas');
      probe.width = probe.height = 4;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 4, 4);
      const d = ctx.getImageData(0, 0, 4, 4).data;
      let lo = 255, hi = 0;
      for (let i = 0; i < d.length; i += 4) {
        for (let k = 0; k < 3; k++) { lo = Math.min(lo, d[i + k]); hi = Math.max(hi, d[i + k]); }
      }
      return hi - lo < 6;
    } catch {
      return false;
    }
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(now => {
      this.frame = 0;
      const dt = Math.min(.05, (now - (this.lastFrame ?? now)) / 1000);
      this.lastFrame = now;
      const target = this.targetZoom(), gap = target - (this.shownZoom ?? target);
      this.shownZoom = stillMotion.matches || Math.abs(gap) < .004 ? target : this.shownZoom + gap * (1 - Math.exp(-dt * 11));
      this.render();
    });
  }

  render() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const anchor = this.anchor();
    this.tiles.style.visibility = anchor ? 'visible' : 'hidden';
    this.craftEl.style.visibility = this.pos ? 'visible' : 'hidden';
    this.homeEl.style.visibility = anchor && this.home ? 'visible' : 'hidden';
    this.trailEl.style.visibility = this.pos ? 'visible' : 'hidden';
    this.scaleEl.style.visibility = anchor ? 'visible' : 'hidden';
    this.root.classList.toggle('has-anchor', !!anchor);
    if (!anchor) {
      this.ringsEl.textContent = '';
      this.planEl.textContent = '';
      this.planBuilt = null;
      this.targetEl.setAttribute('d', '');
      this.pickEl.setAttribute('d', '');
      this.shownCentre = null;
    }
    if (!anchor || !w || !h) return;

    const target = this.targetZoom();
    this.shownZoom ??= target;
    const z = this.shownZoom, k = 2 ** z;
    const craft = world(...anchor);
    let centre = this.free ?? craft;
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.at) / RECENTRE_MS);
      const s = t * t * (3 - 2 * t);
      centre = [this.tween.from[0] + (craft[0] - this.tween.from[0]) * s, this.tween.from[1] + (craft[1] - this.tween.from[1]) * s];
      if (t >= 1) this.tween = null;
    }
    this.shownCentre = centre;
    const toScreen = (lat, lon) => {
      const [x, y] = world(lat, lon);
      return [(x - centre[0]) * k + w / 2, (y - centre[1]) * k + h / 2];
    };

    // Tiles for where the zoom is heading. Beyond the imagery's own levels, those of its last
    // level are shown scaled up. Until the new ones arrive the old ones stay, scaled to fit.
    const tz = Math.max(0, Math.min(Math.round(target), this.tileMax));
    const count = 2 ** tz;
    // Worked out at the zoom it is heading for, which keeps the number of tiles small whatever
    // the zoom happens to be on the way there.
    const size = SIZE * 2 ** (target - tz), scale = 2 ** target;
    const tx = centre[0] * scale, ty = centre[1] * scale;
    const x0 = Math.floor((tx - w / 2) / size), x1 = Math.floor((tx + w / 2) / size);
    const y0 = Math.max(0, Math.floor((ty - h / 2) / size)), y1 = Math.min(count - 1, Math.floor((ty + h / 2) / size));
    const wanted = new Set();
    let ready = true;
    if (this.tilesOn) for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${tz}/${x}/${y}`;
        wanted.add(key);
        let img = this.loaded.get(key);
        if (!img) {
          img = this.fetchTile(key, tz, ((x % count) + count) % count, y);
          img.place = [tz, x, y];
          this.tiles.append(img);
          this.loaded.set(key, img);
        }
        if (!img.complete) ready = false;
      }
    }
    const cx = centre[0] * k, cy = centre[1] * k;
    for (const [key, img] of this.loaded) {
      const [iz, ix, iy] = img.place;
      if (!wanted.has(key) && (ready || iz === tz)) {
        img.remove();
        this.loaded.delete(key);
        continue;
      }
      const s = SIZE * 2 ** (z - iz);
      const left = Math.round(ix * s - cx + w / 2), top = Math.round(iy * s - cy + h / 2);
      img.style.width = `${Math.round((ix + 1) * s - cx + w / 2) - left}px`;
      img.style.height = `${Math.round((iy + 1) * s - cy + h / 2) - top}px`;
      img.style.transform = `translate(${left}px,${top}px)`;
    }

    if (this.pos) {
      const [px, py] = toScreen(...this.pos);
      this.craftEl.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${this.heading.toFixed(0)}) scale(${this.markerScale})`);
      this.craftEl.classList.toggle('picked', this.selected === 'craft');
    }
    const cos = Math.cos(anchor[0] * Math.PI / 180);
    const perMetre = SIZE * k / (EARTH * cos);
    this.ringsEl.textContent = '';
    if (this.home) {
      const [hx, hy] = toScreen(...this.home);
      this.homeEl.setAttribute('transform', `translate(${hx.toFixed(1)} ${hy.toFixed(1)})`);
      this.homeEl.classList.toggle('picked', this.selected === 'home');
    }
    // Rings round home. Until it has one, round the aircraft: they are still a scale to read against.
    const ringCentre = this.home ?? this.pos;
    if (this.rings && ringCentre) {
      const [hx, hy] = toScreen(...ringCentre);
      // The same rings as in the world. Labels go on the side towards the middle of the map,
      // where the readings are not, and only where there is room for them.
      const side = (Math.hypot(w / 2 - hx, h / 2 - hy) > 20 ? Math.atan2(h / 2 - hy, w / 2 - hx) : 0) + .45;
      const from = this.pos ?? ringCentre;
      const metres = Math.hypot((from[0] - ringCentre[0]) * 111320, (from[1] - ringCentre[1]) * 111320 * cos);
      for (const r of rangeRings(metres)) {
        const radius = r * perMetre;
        if (radius < 6) continue;
        const circle = svg('circle', 'ring', this.ringsEl);
        circle.setAttribute('cx', hx.toFixed(1));
        circle.setAttribute('cy', hy.toFixed(1));
        circle.setAttribute('r', radius.toFixed(1));
        if (w >= 200 && radius >= RING_LABEL_MIN_PX) {       // only where there is room inside it for its label
          const text = svg('text', 'ring-text', this.ringsEl);
          text.setAttribute('x', (hx + Math.cos(side) * radius).toFixed(1));
          text.setAttribute('y', (hy + Math.sin(side) * radius + 4).toFixed(1));
          text.textContent = `${r} m`;
        }
      }
    }
    this.renderPlan(toScreen, perMetre, w);
    this.renderPoint(this.targetEl, this.target, toScreen, 7);
    this.renderPoint(this.pickEl, this.pick, toScreen, 9);
    this.renderPrediction(toScreen);
    // A smooth curve through the points. A break of more than 30 s in the record is a break in it.
    let d = '', prev = null, here = null;
    for (const p of this.trail) {
      const next = toScreen(p[0], p[1]);
      if (!prev || p[3] - prev[3] > GAP_S) {
        if (here) d += `L${here[0].toFixed(1)} ${here[1].toFixed(1)}`;
        d += `M${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
      } else {
        d += `Q${here[0].toFixed(1)} ${here[1].toFixed(1)} ${((here[0] + next[0]) / 2).toFixed(1)} ${((here[1] + next[1]) / 2).toFixed(1)}`;
      }
      here = next;
      prev = p;
    }
    if (here) d += `L${here[0].toFixed(1)} ${here[1].toFixed(1)}`;
    this.trailEl.setAttribute('d', d);

    // A scale bar, for when there are no rings to read against.
    const metres = SCALE_STEPS.filter(m => m * perMetre <= SCALE_MAX_PX).pop();
    if (metres) {
      this.scaleEl.firstElementChild.style.width = `${(metres * perMetre).toFixed(1)}px`;
      const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
      if (this.scaleEl.lastElementChild.textContent !== label) this.scaleEl.lastElementChild.textContent = label;
    }

    if (z !== target || this.tween) this.schedule();
    this.onMoved();
  }

  renderPrediction(toScreen) {
    const flight = this.prediction;
    this.predictEndEl.style.display = flight ? 'inline' : 'none';
    if (!flight) {
      this.predictEl.setAttribute('d', '');
      return;
    }
    const points = flight.points.map(p => toScreen(p.lat, p.lon));
    this.predictEl.setAttribute('d', points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(''));
    const [x, y] = points[points.length - 1];
    this.predictEndEl.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    const text = this.predictEndEl.lastElementChild;
    if (text.textContent !== this.predictLabel) text.textContent = this.predictLabel;
  }

  // A cross in a circle at a point, with a dashed line from the aircraft: where it is heading, or
  // where the viewer has pointed.
  renderPoint(el, point, toScreen, r) {
    if (!point) {
      el.setAttribute('d', '');
      return;
    }
    const [x, y] = toScreen(point[0], point[1]);
    let d = `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
      + `M${x.toFixed(1)} ${(y - r - 4).toFixed(1)}v8M${x.toFixed(1)} ${(y + r - 4).toFixed(1)}v8M${(x - r - 4).toFixed(1)} ${y.toFixed(1)}h8M${(x + r - 4).toFixed(1)} ${y.toFixed(1)}h8`;
    if (this.pos) {
      const [px, py] = toScreen(...this.pos);
      d += `M${px.toFixed(1)} ${py.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    el.setAttribute('d', d);
  }

  // The marks stay in the page between frames; only the lines and places change as the map moves.
  buildPlan() {
    const s = this.shapes, draft = this.draft;
    const stamp = `${s?.version}|${draft?.version}|${this.notesVersion}|${this.show.plan}|${this.show.fence}|${this.show.rally}|${this.current}`;
    if (this.planBuilt === stamp) return;
    this.planBuilt = stamp;
    this.planEl.textContent = '';
    this.planParts = { lines: [], marks: [] };
    if (!s) return;
    const drafting = this.show.plan && !!draft?.route;
    const draftingRally = this.show.rally && !!draft?.rally;
    const next = nextPoint(s, this.current);
    if (this.show.fence) {
      const active = s.enabled;
      for (const polygon of s.polygons) {
        const live = active && s.polygonsOn;
        const el = svg('path', `fence-line${polygon.inside ? '' : ' keep-out'}${live ? '' : ' off'}`, this.planEl);
        this.planParts.lines.push({ el, points: polygon.points, closed: true });
        this.planParts.lines.push({ el: this.fenceHit('path'), points: polygon.points, closed: true });
      }
      for (const circle of s.circles) {
        const el = svg('circle', `fence-line${circle.inside ? '' : ' keep-out'}${active ? '' : ' off'}`, this.planEl);
        this.planParts.lines.push({ el, circle });
        this.planParts.lines.push({ el: this.fenceHit('circle'), circle });
      }
      if (s.cylinder) {
        const el = svg('circle', `fence-line${active ? '' : ' off'}`, this.planEl);
        this.planParts.lines.push({ el, circle: s.cylinder });
        this.planParts.lines.push({ el: this.fenceHit('circle'), circle: s.cylinder });
      }
      if (s.back) this.addMark(s.back, 'F', 'mark fence-mark');
    }
    if (this.show.plan && s.route.points.length) {
      const points = [s.route.start, ...s.route.points].filter(Boolean).map(p => [p.lat, p.lon]);
      const el = svg('path', `route${drafting ? ' behind' : ''}`, this.planEl);
      this.planParts.lines.push({ el, points });
      if (!drafting) {
        const placed = new Set();     // from above, a takeoff and a return to the same spot are one mark
        for (const p of s.route.points) {
          const spot = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
          if (p.seq == null || placed.has(spot)) continue;
          placed.add(spot);
          const flying = next && p.seq === next.seq;
          this.addMark([p.lat, p.lon], pointLabel(p), `mark wp${flying ? ' next' : ''}`, `item:${p.seq}`, p.cmd !== CMD.RTL && p.cmd !== CMD.TAKEOFF);
        }
      }
    }
    if (drafting) {
      const route = draft.route, points = [route.start, ...route.points].filter(Boolean);
      this.planParts.lines.push({ el: svg('path', 'route draft', this.planEl), points: points.map(p => [p.lat, p.lon]) });
      // Between two points, a handle to pull out a new one, as in Mission Planner.
      points.forEach((p, i) => {
        if (!i || p.seq == null) return;
        const a = points[i - 1];
        this.addHandle([(a.lat + p.lat) / 2, (a.lon + p.lon) / 2], `mid:${p.seq}`, [a.lat, a.lon], [p.lat, p.lon]);
      });
      const placed = new Set();
      for (const p of route.points) {
        const spot = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
        if (p.seq == null || placed.has(spot)) continue;
        placed.add(spot);
        this.addMark([p.lat, p.lon], pointLabel(p), 'mark wp draft', `item:${p.seq}`, p.cmd !== CMD.RTL && p.cmd !== CMD.TAKEOFF);
      }
    }
    if (this.show.rally) {
      const rally = draftingRally ? draft.rally : s.rally;
      for (const r of rally) this.addMark([r.lat, r.lon], `R${r.n}`, `mark rally${draftingRally ? ' draft' : ''}`, `rally:${r.n}`, true);
    }
    for (const note of this.notes) this.addNote(note);
  }

  fenceHit(shape) {
    const el = svg(shape, 'fence-hit', this.planEl);
    el.dataset.ref = 'fence';
    return el;
  }

  addMark(at, label, cls, ref, draggable = false) {
    const g = svg('g', cls, this.planEl);
    if (ref) g.dataset.ref = ref;
    if (draggable) g.dataset.drag = '1';
    svg('circle', 'hit', g).setAttribute('r', '18');
    svg('circle', null, g).setAttribute('r', '9');
    const text = svg('text', null, g);
    text.setAttribute('y', '4.5');
    text.textContent = label;
    this.planParts.marks.push({ g, at });
  }

  addHandle(at, ref, from, to) {
    const g = svg('g', 'mark mid', this.planEl);
    g.dataset.ref = ref;
    g.dataset.drag = '1';
    svg('circle', 'hit', g).setAttribute('r', '12');
    svg('circle', null, g).setAttribute('r', '4');
    this.planParts.marks.push({ g, at, from, to });
  }

  addNote(note) {
    const ref = `note:${note.id}`;
    const g = svg('g', 'mark note', this.planEl);
    g.dataset.ref = ref;
    g.dataset.drag = '1';
    svg('circle', 'hit', g).setAttribute('r', '16');
    svg('circle', null, g).setAttribute('r', '5');
    const text = svg('text', null, g);
    text.setAttribute('x', '11');
    text.setAttribute('y', '4.5');
    text.textContent = note.name;
    this.planParts.marks.push({ g, at: [note.lat, note.lon] });
  }

  renderPlan(toScreen, perMetre, w) {
    this.buildPlan();
    const parts = this.planParts;
    if (!parts) return;
    this.planEl.classList.toggle('small', w < 200);
    for (const { el, points, closed, circle } of parts.lines) {
      if (circle) {
        const [x, y] = toScreen(circle.at[0], circle.at[1]);
        el.setAttribute('cx', x.toFixed(1));
        el.setAttribute('cy', y.toFixed(1));
        el.setAttribute('r', Math.max(circle.radius * perMetre, 0).toFixed(1));
      } else {
        el.setAttribute('d', points.map((p, i) => {
          const [x, y] = toScreen(p[0], p[1]);
          return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        }).join('') + (closed ? 'Z' : ''));
      }
    }
    for (const { g, at, from, to } of parts.marks) {
      const [x, y] = toScreen(at[0], at[1]);
      g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      // Marks stay put when one is picked: rebuilding them would pull the one under the pointer away.
      g.classList.toggle('picked', g.dataset.ref === this.selected);
      if (from) {     // a handle only where there is room for it between the two points
        const [ax, ay] = toScreen(from[0], from[1]), [bx, by] = toScreen(to[0], to[1]);
        g.style.display = Math.hypot(ax - bx, ay - by) < HANDLE_MIN_PX ? 'none' : '';
      }
    }
  }
}
