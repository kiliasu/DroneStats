// Plain line charts: the curve, the limits that matter, and nothing else. They draw straight
// on the world. No axes, no grid, no background.

const NS = 'http://www.w3.org/2000/svg';
const GAP_S = 10;       // a longer break in the record is drawn as a break in the line

function make(name, cls, parent) {
  const el = document.createElementNS(NS, name);
  if (cls) el.setAttribute('class', cls);
  parent?.append(el);
  return el;
}

function pathOf(points, x, y) {
  let d = '', previous = null;
  for (const [time, value] of points) {
    const joined = previous != null && time - previous <= GAP_S;
    d += `${joined ? 'L' : 'M'}${x(time).toFixed(1)} ${y(value).toFixed(1)}`;
    previous = time;
  }
  return d;
}

export function spark(svg, points, minSpan = 0.05) {
  const path = svg.firstElementChild ?? make('path', null, svg);
  const box = svg.getBoundingClientRect();
  if (points.length < 2 || !box.width) {
    path.setAttribute('d', '');
    return;
  }
  const values = points.map(p => p[1]);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(hi - lo, minSpan);
  const mid = (hi + lo) / 2;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const x = time => (time - t0) / Math.max(t1 - t0, 1) * box.width;
  const y = value => box.height - 1 - ((value - mid) / span + .5) * (box.height - 2);
  path.setAttribute('d', pathOf(points, x, y));
}

export class Chart {
  constructor(parent, cls = '') {
    this.svg = make('svg', `chart ${cls}`, parent);
    this.svg.setAttribute('aria-hidden', 'true');
    this.limits = make('g', null, this.svg);
    this.forecast = make('path', 'forecast', this.svg);
    this.line = make('path', 'curve', this.svg);
    this.dot = make('circle', 'dot', this.svg);
    this.dot.setAttribute('r', 3);
    this.times = make('g', null, this.svg);
    new ResizeObserver(() => this.redraw()).observe(this.svg);
  }

  // o: points [[time, value]], now, past and future in seconds, lo and hi, optional
  // limits [{ v, text, tone }], optional forecast [[time, value], ...], and labels.
  draw(o) {
    this.o = o;
    this.redraw();
  }

  redraw() {
    const o = this.o;
    if (!o) return;
    const box = this.svg.getBoundingClientRect();
    if (!box.width) return;
    const footer = o.labels ? 22 : 0;
    const w = box.width, h = box.height - footer;
    const start = o.now - o.past;
    const x = time => (time - start) / (o.past + (o.future ?? 0)) * (w - 4);
    const y = value => 2 + (1 - (value - o.lo) / (o.hi - o.lo)) * (h - 4);

    this.line.setAttribute('d', pathOf(o.points, x, y));
    const last = o.points[o.points.length - 1];
    this.dot.setAttribute('visibility', last ? 'visible' : 'hidden');
    if (last) {
      this.dot.setAttribute('cx', x(last[0]).toFixed(1));
      this.dot.setAttribute('cy', y(last[1]).toFixed(1));
    }

    this.forecast.setAttribute('d', o.forecast
      ? o.forecast.map(([time, value], i) => `${i ? 'L' : 'M'}${x(time).toFixed(1)} ${y(Math.max(value, o.lo)).toFixed(1)}`).join('')
      : '');

    // Limit labels sit on their lines, pushed apart only as far as needed to stay readable.
    this.limits.textContent = '';
    const shown = (o.limits ?? []).filter(l => l.v >= o.lo && l.v <= o.hi)
      .map(l => ({ ...l, ly: y(l.v) })).sort((a, b) => a.ly - b.ly);
    let lowest = -Infinity;
    for (const l of shown) {
      const rule = make('line', `limit ${l.tone ?? ''}`, this.limits);
      rule.setAttribute('x1', 0);
      rule.setAttribute('x2', w);
      rule.setAttribute('y1', l.ly.toFixed(1));
      rule.setAttribute('y2', l.ly.toFixed(1));
      const label = make('text', `limit-text ${l.tone ?? ''}`, this.limits);
      const ty = Math.max(l.ly - 5, lowest + 15, 12);
      lowest = ty;
      label.setAttribute('x', w);
      label.setAttribute('y', ty.toFixed(1));
      label.textContent = l.text;
    }

    this.times.textContent = '';
    if (o.format) {
      // With no limits to read against, the top and bottom of the range give the scale.
      for (const [value, ty] of [[o.hi, 12], [o.lo, h - 3]]) {
        const label = make('text', 'time-text', this.times);
        label.setAttribute('x', 0);
        label.setAttribute('y', ty);
        label.textContent = o.format(value);
      }
    }
    if (o.labels) {
      const place = (time, text, anchor) => {
        const label = make('text', 'time-text', this.times);
        label.setAttribute('x', Math.max(0, Math.min(w, x(time))).toFixed(1));
        label.setAttribute('y', box.height - 3);
        label.setAttribute('text-anchor', anchor);
        label.textContent = text;
      };
      place(start, o.labels.start, 'start');
      if (o.future) {
        place(o.now, o.labels.now, 'middle');
        place(o.now + o.future, o.labels.end, 'end');
      } else {
        place(o.now, o.labels.now, 'end');
      }
    }
  }
}
