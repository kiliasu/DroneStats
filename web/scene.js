// The world seen from the aircraft, or from just behind it: sky, sun, stars and ground, drawn
// in one fragment shader on the viewer's GPU. The flight path, the home point and the aircraft
// itself are lines drawn over it on a plain canvas. Nothing here runs on the server.

import { rangeRings } from '/rings.js';

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0., 1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform mat3 uR;
uniform float uF, uAlt, uLive, uFade, uStars, uPlain, uDpr, uDim, uCrisp;
uniform vec2 uPos;
uniform vec3 uSun, uZen, uHor, uWarm, uGlow, uGndN, uGndF, uDot, uSunCol;
out vec4 o;
const float PI = 3.14159265;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Coverage of a square lattice of ground points spaced s metres. The offset to the nearest
// point is converted to screen pixels, so points stay round however flat the view is.
float lattice(vec2 p, mat2 toScreen, float s, float size) {
  vec2 c = (fract(p / s + .5) - .5) * s;
  float dist = length(toScreen * c);
  float spacing = min(length(toScreen * vec2(s, 0.)), length(toScreen * vec2(0., s)));
  float r = clamp(spacing * .035, .55, 1.7) * size;
  float m = 1. - smoothstep(r - .6, r + .6, dist);
  return m * smoothstep(2.2, 7., spacing);
}

void main() {
  vec2 q = (gl_FragCoord.xy - .5 * uRes) / uF;
  vec3 d = uR * normalize(vec3(1., q.x, -q.y));
  float up = -d.z;
  float px = 1. / uF;
  vec3 col;

  if (up >= 0.) {
    col = mix(uHor, uZen, smoothstep(0., 1., pow(up, .42)));
    float side = dot(normalize(d.xy + 1e-5), normalize(uSun.xy + 1e-5)) * .5 + .5;
    col += uWarm * side * side * exp(-up * 6.5);
    col += uGlow * exp(-up * 15.);
    float s = max(dot(d, uSun), 0.);
    col += uSunCol * (smoothstep(.99985, .99995, s) + .16 * pow(s, 220.) + .05 * pow(s, 14.));
    if (uStars > .001 && uPlain < .5) {
      float cell = 72.;
      vec2 sc = vec2(atan(d.y, d.x) * cos(asin(clamp(up, 0., .985))), asin(clamp(up, 0., 1.))) * cell;
      vec2 id = floor(sc);
      float r = hash(id);
      if (r > .955) {
        vec2 off = vec2(hash(id + 7.), hash(id + 13.)) - .5;
        float size = cell * px * mix(.8, 1.5, hash(id + 19.));
        float glint = 1. - smoothstep(size * .4, size, length(fract(sc) - .5 - off * .7));
        col += glint * uStars * smoothstep(.015, .25, up) * (.3 + .7 * hash(id + 3.) * hash(id + 3.)) * vec3(.84, .91, 1.);
      }
    }
    if (uPlain < .5) {
      float az = atan(d.y, d.x);
      float st = PI / 12.;
      float m = abs(fract(az / st + .5) - .5) * st;
      float big = abs(fract(az / (PI / 4.) + .5) - .5) * (PI / 4.) < st * .5 ? 1. : 0.;
      float h = mix(.009, .02, big);
      float tick = (1. - smoothstep(px * .45, px * 1.3, m)) * (1. - smoothstep(h - px, h, up));
      col = mix(col, vec3(.93, .96, .98), tick * .85 * uCrisp);
    }
  } else {
    float t = uAlt / max(-up, 1e-4);
    vec2 p = uPos + d.xy * t;
    mat2 toGround = mat2(dFdx(p), dFdy(p));
    float det = determinant(toGround);
    mat2 toScreen = abs(det) > 1e-12 ? inverse(toGround) : mat2(0.);
    col = mix(uGndN, uGndF, exp(up * 6.));
    float side = dot(normalize(d.xy + 1e-5), normalize(uSun.xy + 1e-5)) * .5 + .5;
    col += uWarm * .3 * side * side * exp(up * 15.);
    col += uGlow * .5 * exp(up * 34.);
    float level = log(uAlt) / log(10.);
    float base = pow(10., floor(level));
    float f = level - floor(level);
    float fine = lattice(p, toScreen, base, uDpr) * (1. - f);
    float wide = lattice(p, toScreen, base * 10., uDpr * 1.3);
    col = mix(col, uDot, clamp(fine * .55 + wide, 0., 1.) * mix(.9, .35, exp(up * 2.2)) * uCrisp);
  }

  float line = 1. - smoothstep(0., px * 1.5, abs(up));
  col = mix(col, vec3(.88, .93, .96), line * .82 * uCrisp);

  float edge = abs(q.y * uF / (.5 * uRes.y));
  col *= 1. - .34 * smoothstep(.5, 1., edge);

  float gray = dot(col, vec3(.3, .59, .11));
  col = mix(vec3(gray) * .72, col, uLive);
  col += (hash(gl_FragCoord.xy) - .5) / 170.;
  o = vec4(col * uFade * uDim, 1.);
}`;

const rad = Math.PI / 180;
const DIMMED = .28;
const EYE = 1.2;              // the ground sits this far below the aircraft at rest, so the horizon is never degenerate
const NEAR = .5;              // lines are cut this close in front of the camera
const CHASE_DIST = Math.hypot(16, 7);     // the view from behind: this far from the aircraft...
const CHASE_ELEV = Math.atan2(7, 16);     // ...raised by this angle
const ZOOM_MIN = .15, ZOOM_MAX = 16;      // how much closer and further the viewer may bring it
const ELEV_MIN = 4 * rad, ELEV_MAX = 85 * rad;
const BLEND_S = .55;          // the camera moves between the two views in this long
const ARM = .15;              // the aircraft at its real size: centre to motor, metres (a 7-inch quad)
const ROTOR = .09;            // and the radius of a rotor
const MARKER_FLOOR = 26;      // never drawn narrower than this many pixels, before the viewer's size setting
const MARKER_CEILING = .6;    // nor wider than this share of the screen's height
const HOME_RING = 1;          // the ground mark at home
const POST = 3;               // height of the home marker
const GAP_S = 30;             // a longer break in the record is drawn as a break in the path
const CLEAR = { fpv: 6, chase: 2 };   // path points this close to the camera are left out
const CURTAIN_M = 10;         // from the path to its shadow, a line this often, to show the height...
const CURTAIN_MAX = 48;       // ...and never more than this many
const FADE_PX = 36;           // lines fade out over this distance before the readings at the bottom
const CIRCLE_SEGMENTS = 72;   // for the fence's circles
const MARK_R = 3.5;           // a stored point
const MARK_NEXT_R = 5.5;      // the one it is flying to
const LABEL_LIFT = 10;
const POINT_RING = 1.5;       // the ground mark at a place it is heading for
const TRAIL = 3;              // the flight path is a broad, see-through band: thin lines measure or plan, this has been flown
const GAUGE = 2.5;            // a motor's output, on its rotor's rim
const NUMBER_INSIDE_PX = 11;  // a rotor this large on screen holds its motor's number
const NUMBER_APART_PX = 24;   // as long as the rotors are this far apart on screen
const NUMBER_BESIDE_PX = 14;  // otherwise the numbers sit this far to the sides of the aircraft
const NUMBER_ROW_PX = 8;      // in two rows, this far above and below it
const LINE = 1.5;             // the two line weights of the world
const HAIR = .75;
const DASHED = [4, 4];
const SOLID = [];

// Where the sun is, as a unit vector in north-east-down.
function sunVector(lat, lon, when) {
  const d = when / 86400000 - 10957.5;
  const g = rad * (357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const l = rad * (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad * (23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const h = rad * ((18.697374558 + 24.06570982441908 * d) * 15 + lon) - ra;
  const la = rad * lat;
  const sinAlt = Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(h);
  const alt = Math.asin(sinAlt);
  const az = Math.atan2(-Math.cos(dec) * Math.sin(h), Math.cos(la) * Math.sin(dec) - Math.sin(la) * Math.cos(dec) * Math.cos(h));
  return [Math.cos(alt) * Math.cos(az), Math.cos(alt) * Math.sin(az), -sinAlt];
}

// Colours by sun elevation in degrees.
const KEYS = [
  { at: -14, zen: [.012, .030, .072], hor: [.040, .098, .172], warm: [.000, .000, .000], glow: [.050, .105, .165], gndN: [.012, .017, .024], gndF: [.022, .046, .074], dot: [.30, .46, .60], sun: [0, 0, 0], stars: 1 },
  { at: -4, zen: [.026, .066, .150], hor: [.130, .230, .330], warm: [.520, .270, .130], glow: [.080, .090, .110], gndN: [.016, .020, .026], gndF: [.080, .082, .094], dot: [.42, .46, .52], sun: [.3, .16, .08], stars: .25 },
  { at: 5, zen: [.034, .125, .265], hor: [.300, .440, .530], warm: [.640, .360, .170], glow: [.100, .090, .070], gndN: [.026, .029, .030], gndF: [.160, .146, .130], dot: [.50, .50, .46], sun: [1, .72, .42], stars: 0 },
  { at: 22, zen: [.030, .150, .315], hor: [.290, .470, .590], warm: [.120, .100, .080], glow: [.060, .080, .090], gndN: [.030, .045, .042], gndF: [.120, .165, .158], dot: [.46, .55, .50], sun: [1, .95, .84], stars: 0 },
];

function palette(deg) {
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let i = 0; i + 1 < KEYS.length; i++) {
    if (deg >= KEYS[i].at && deg <= KEYS[i + 1].at) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    if (deg > KEYS[i + 1].at) { a = b = KEYS[i + 1]; }
  }
  if (deg < KEYS[0].at) a = b = KEYS[0];
  const k = a === b ? 0 : (deg - a.at) / (b.at - a.at);
  const mix = (x, y) => x.map((v, i) => v + (y[i] - v) * k);
  return {
    zen: mix(a.zen, b.zen), hor: mix(a.hor, b.hor), warm: mix(a.warm, b.warm), glow: mix(a.glow, b.glow), gndN: mix(a.gndN, b.gndN),
    gndF: mix(a.gndF, b.gndF), dot: mix(a.dot, b.dot), sun: mix(a.sun, b.sun), stars: a.stars + (b.stars - a.stars) * k,
  };
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Body axes to north-east-down for roll r, pitch p and yaw y, rows first.
function dcm(r, p, y) {
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy,
    cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy,
    -sp, sr * cp, cr * cp];
}

// Traces a line through points given in camera coordinates (forward, right, down), cut where
// it passes behind the camera. A null breaks the line. `at` maps a point to the screen.
function trace(ctx, points, at) {
  const cut = (a, b) => {
    const t = (NEAR - a[0]) / (b[0] - a[0]);
    return [NEAR, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  const move = c => { const s = at(c); ctx.moveTo(s[0], s[1]); };
  const line = c => { const s = at(c); ctx.lineTo(s[0], s[1]); };
  let pen = false, prev = null;
  for (const c of points) {
    if (prev && c) {
      const a = prev[0] >= NEAR, b = c[0] >= NEAR;
      if (a && b) { if (!pen) move(prev); line(c); pen = true; }
      else if (a) { if (!pen) move(prev); line(cut(prev, c)); pen = false; }
      else if (b) { move(cut(prev, c)); line(c); pen = true; }
      else pen = false;
    } else pen = false;
    prev = c;
  }
}

// The same, drawn as a smooth curve through the points, for the flight path.
function traceSmooth(ctx, points, at) {
  const cut = (a, b) => {
    const t = (NEAR - a[0]) / (b[0] - a[0]);
    return [NEAR, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  let run = [], prev = null;
  const flush = () => {
    if (run.length > 1) {
      ctx.moveTo(run[0][0], run[0][1]);
      for (let i = 1; i < run.length - 1; i++) {
        ctx.quadraticCurveTo(run[i][0], run[i][1], (run[i][0] + run[i + 1][0]) / 2, (run[i][1] + run[i + 1][1]) / 2);
      }
      ctx.lineTo(run[run.length - 1][0], run[run.length - 1][1]);
    }
    run = [];
  };
  for (const c of points) {
    const here = c && c[0] >= NEAR, before = prev && prev[0] >= NEAR;
    if (here) {
      if (prev && !before) run.push(at(cut(prev, c)));
      run.push(at(c));
    } else {
      if (c && before) run.push(at(cut(prev, c)));
      flush();
    }
    prev = c;
  }
  flush();
}

function ring(n, e, d, r, toCam, segments = 12) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * 2 * Math.PI;
    pts.push(toCam(n + r * Math.cos(a), e + r * Math.sin(a), d));
  }
  return pts;
}

export class Scene {
  constructor(canvas, labelLayer, worldCanvas, options = {}) {
    this.canvas = canvas;
    this.layer = labelLayer;
    this.world = worldCanvas;
    this.ctx = worldCanvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const colour = name => css.getPropertyValue(name).trim();
    this.colors = { ink: colour('--ink'), soft: colour('--soft'), amber: colour('--amber'), red: colour('--red'), plan: colour('--plan') };
    this.font = `500 13px ${colour('--font')}`;
    this.homeTop = null;
    this.fixedQuality = options.fixedQuality;
    this.fakeTime = options.fakeTime;
    this.stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.att = [0, 0, 0, 0, 0, 0];
    this.attAt = 0;
    this.r = 0; this.p = 0; this.y = 0;
    this.alt = EYE; this.altTarget = EYE;
    this.n = 0; this.e = 0;             // metres north and east of the page's origin, eased
    this.posTarget = null;
    this.placed = false;
    this.vn = 0; this.ve = 0;
    this.view = 'fpv';
    this.blend = 0;                     // 0 looking out from the aircraft, 1 from behind it
    this.camYaw = 0;                    // the aircraft's heading, a little late
    this.orbit = { zoom: 1, elev: CHASE_ELEV, az: 0 };   // the viewer's own placing of the view from behind
    this.eased = { ...this.orbit };     // where the camera is on its way there
    this.locked = false;                // the camera keeps its bearing instead of following the aircraft
    this.lockYaw = 0;
    this.markerScale = 1.5;             // the viewer's setting for how large the aircraft is drawn
    this.rings = true;
    this.showTrail = true;
    this.motors = null;
    this.prediction = null;
    this.plan = null;                   // what is stored on the flight controller, in the world's metres
    this.planShow = { plan: true, fence: true, rally: true };
    this.currentItem = 0;               // the mission item it is flying to
    this.target = null;                 // [north, east, height]: where it is heading
    this.ringEls = [];
    this.hud = { avoid: [], clear: [], fadeTop: 64, fadeBottom: null, aimY: null };
    this.fades = null;
    this.trail = null;
    this.homePoint = null;
    this.live = 0; this.liveTarget = 0;
    this.fade = 0;
    this.dim = 1; this.dimTarget = 1;
    this.plain = false;
    this.quality = 1;
    this.slow = 0;
    this.labels = [];
    this.home = null;
    this.force = true;
    this.lat = 34; this.lon = -new Date().getTimezoneOffset() / 4;
    this.sunAt = 0;
    this.last = 0;
    if (!this.init()) document.documentElement.classList.add('no-webgl');
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost', e => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => { this.init(); this.force = true; });
    this.resize();
    canvas.classList.add('ready');
  }

  init() {
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return false;
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(program)); return false; }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uRes', 'uR', 'uF', 'uAlt', 'uLive', 'uFade', 'uStars', 'uPlain', 'uDpr', 'uDim', 'uCrisp', 'uPos', 'uSun', 'uZen', 'uHor', 'uWarm', 'uGlow', 'uGndN', 'uGndF', 'uDot', 'uSunCol']) {
      this.u[n] = gl.getUniformLocation(program, n);
    }
    this.sunAt = 0;
    return true;
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.quality;
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // Lines keep the full device resolution whatever the shader's quality.
    this.lineDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.world.width = Math.round(w * this.lineDpr);
    this.world.height = Math.round(h * this.lineDpr);
    this.f = 0.62 * Math.max(w, h * 0.8);
    this.force = true;
  }

  setLabels(names) {
    this.layer.textContent = '';
    this.labels = names.map((text, i) => {
      const el = document.createElement('span');
      el.textContent = text;
      this.layer.append(el);
      return { el, bearing: i * 45 * rad };
    });
    this.homeEl = document.createElement('span');
    this.homeEl.className = 'home';
    this.layer.append(this.homeEl);
    this.ringEls = Array.from({ length: 4 }, () => {
      const el = document.createElement('span');
      el.className = 'ring';
      this.layer.append(el);
      return el;
    });
    this.force = true;
  }

  setPlain(plain) {
    this.plain = plain;
    this.force = true;
  }

  // Lowers the exposure of the whole world, so content can sit directly on it.
  setDim(on) { this.dimTarget = on ? DIMMED : 1; }

  // 'fpv' looks out from the aircraft; 'chase' looks at it from behind and above.
  setView(view) {
    if (view === this.view) return;
    this.view = view;
    this.force = true;
  }

  // The view from behind can be brought closer or further (zoom), raised or lowered (elev) and
  // turned round the aircraft (az, relative to its heading). By default it sits behind.
  setOrbit(changes) {
    const o = Object.assign(this.orbit, changes);
    o.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, o.zoom));
    o.elev = Math.min(ELEV_MAX, Math.max(ELEV_MIN, o.elev));
    o.az = wrap(o.az);
    this.force = true;
  }
  turnBy(dAz, dElev) { this.setOrbit({ az: this.orbit.az + dAz, elev: this.orbit.elev + dElev }); }
  resetOrbit() {
    this.setLocked(false);
    this.setOrbit({ zoom: 1, elev: CHASE_ELEV, az: 0 });
  }
  orbitIsDefault() {
    const o = this.orbit;
    return !this.locked && Math.abs(o.zoom - 1) < .01 && Math.abs(o.elev - CHASE_ELEV) < .005 && Math.abs(o.az) < .005;
  }

  // Locked, the camera keeps the bearing it has now and the aircraft turns in the picture.
  // Unlocked, it follows the aircraft again from wherever it then is, without a jump.
  setLocked(on, yaw) {
    if (on === this.locked && yaw == null) return;
    if (on) {
      this.lockYaw = yaw ?? wrap(this.camYaw + this.eased.az);
    } else if (this.locked) {
      this.orbit.az = this.eased.az = wrap(this.lockYaw - this.camYaw);
    }
    this.locked = on;
    this.force = true;
  }

  setRings(on) {
    if (on === this.rings) return;
    this.rings = on;
    this.force = true;
  }
  // The way a command would go, as [north, east, height], or null.
  setPrediction(points) {
    this.prediction = points;
    this.force = true;
  }

  // Each motor as [percent, tone], or null while parked.
  setMotors(motors) {
    this.motors = motors;
  }

  setTrailVisible(on) {
    if (on === this.showTrail) return;
    this.showTrail = on;
    this.force = true;
  }
  setMarker(scale) {
    if (scale === this.markerScale) return;
    this.markerScale = scale;
    this.force = true;
  }
  // The same object again means nothing changed.
  setPlan(plan, show) {
    const s = this.planShow;
    if (plan === this.plan && show.plan === s.plan && show.fence === s.fence && show.rally === s.rally) return;
    this.plan = plan;
    this.planShow = { ...show };
    this.force = true;
  }
  setProgress(item, target) {
    const t = this.target;
    if (item === this.currentItem && target?.[0] === t?.[0] && target?.[1] === t?.[1] && target?.[2] === t?.[2]) return;
    this.currentItem = item;
    this.target = target;
    this.force = true;
  }

  // Where the readings are, so labels keep off them: rectangles to avoid, where lines must
  // have faded out by, and how far down the screen the aircraft sits when seen from behind.
  setHud(hud) {
    this.hud = hud;
    this.fades = null;
    this.force = true;
  }

  // Feed from telemetry. Angles in radians, speeds in m/s north and east, positions in metres
  // north and east of the page's origin.
  setAttitude(att) { this.att = att; this.attAt = performance.now(); }
  setMotion(altRel, vn, ve) {
    this.altTarget = Math.max(altRel, 0) + EYE;
    this.vn = Math.abs(vn) < .15 ? 0 : vn;
    this.ve = Math.abs(ve) < .15 ? 0 : ve;
  }
  setPosition(n, e) {
    if (n == null) { this.posTarget = null; return; }
    if (this.posTarget && this.posTarget.n === n && this.posTarget.e === e) return;
    this.posTarget = { n, e, at: performance.now() };
    if (!this.placed) { this.n = n; this.e = e; this.placed = true; }    // the first fix: no glide from the origin
  }
  setPlace(lat, lon) { if (lat != null) { this.lat = lat; this.lon = lon; } }
  setLive(live) { this.liveTarget = live ? 1 : 0; }
  setHome(bearing, text) {
    if (bearing === this.home?.bearing && text === this.home?.text) return;
    if (bearing == null && !this.home) return;
    this.home = bearing == null ? null : { bearing, text };
    this.force = true;
  }
  setHomePoint(point) {
    if (point?.[0] === this.homePoint?.[0] && point?.[1] === this.homePoint?.[1]) return;
    this.homePoint = point;
    this.force = true;
  }
  // Points [north, east, altitude, time]. The same array again means nothing changed.
  setTrail(points) {
    if (points === this.trail) return;
    this.trail = points;
    this.force = true;
  }

  project(R, n, e, d) {
    const x = R[0] * n + R[3] * e + R[6] * d;
    const y = R[1] * n + R[4] * e + R[7] * d;
    const z = R[2] * n + R[5] * e + R[8] * d;
    if (x < 0.1) return null;
    return [this.w / 2 + this.f * y / x, this.h / 2 + this.f * z / x];
  }

  // A label sits above and centred on its point, unless that would put it over a reading.
  placeAt(el, x, y, angle, text) {
    const blocked = x < -80 || x > this.w + 80
      || this.hud.avoid.some(([left, top, right, bottom]) => x > left - 28 && x < right + 28 && y > top && y < bottom + 24);
    if (blocked) return false;
    if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    if (text != null && el.textContent !== text) el.textContent = text;
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${angle.toFixed(4)}rad) translate(-50%,-100%)`;
    return true;
  }

  placeLabel(R, el, bearing, text) {
    const lift = -0.052;   // sits above the ticks
    const n = Math.cos(bearing), e = Math.sin(bearing);
    const a = this.project(R, n, e, lift);
    const b = this.project(R, n * Math.cos(.02) - e * Math.sin(.02), e * Math.cos(.02) + n * Math.sin(.02), lift);
    if (!a || !b || !this.placeAt(el, a[0], a[1], Math.atan2(b[1] - a[1], b[0] - a[0]), text)) {
      if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    }
  }

  frame(now) {
    const dt = Math.min(.1, (now - this.last) / 1000 || 0);
    this.last = now;

    // Extrapolate from the last sample with its rates, then ease toward that.
    const age = Math.min(.3, (now - this.attAt) / 1000);
    const [r, p, y, rr, pr, yr] = this.att;
    const k = 1 - Math.exp(-dt * 12);
    const dr = (r + rr * age - this.r) * k;
    const dp = (p + pr * age - this.p) * k;
    const dy = wrap(y + yr * age - this.y) * k;
    this.r += dr; this.p += dp; this.y = wrap(this.y + dy);
    const da = (this.altTarget - this.alt) * (1 - Math.exp(-dt * 3));
    this.alt += da;
    // The position eases toward the last fix carried forward with the velocity. With no fix it
    // drifts with the velocity alone, which is enough for the ground to flow past.
    let dn, de;
    if (this.posTarget) {
      const since = Math.min(1.5, (now - this.posTarget.at) / 1000);
      const kp = 1 - Math.exp(-dt * 3);
      dn = (this.posTarget.n + this.vn * since - this.n) * kp;
      de = (this.posTarget.e + this.ve * since - this.e) * kp;
    } else {
      dn = this.vn * dt; de = this.ve * dt;
    }
    this.n += dn; this.e += de;

    // The camera moves between the views in a fixed time and settles exactly.
    const still = this.stillMotion.matches;
    const target = this.view === 'chase' && !this.plain ? 1 : 0;
    const db = target - this.blend;
    this.blend = still ? target : this.blend + Math.sign(db) * Math.min(Math.abs(db), dt / BLEND_S);
    const ko = still ? 1 : 1 - Math.exp(-dt * 14);
    const o = this.orbit, c = this.eased;
    const dzoom = (o.zoom - c.zoom) * ko, delev = (o.elev - c.elev) * ko, daz = wrap(o.az - c.az) * ko;
    c.zoom += dzoom; c.elev += delev; c.az = wrap(c.az + daz);
    // Behind the aircraft, the camera turns after it, a little late.
    let dc = 0;
    if (this.blend > 0) {
      dc = wrap(this.y - this.camYaw) * (1 - Math.exp(-dt * 1.6));
      this.camYaw = wrap(this.camYaw + dc);
    } else {
      this.camYaw = this.y;
    }
    const dl = this.liveTarget - this.live;
    this.live += Math.sign(dl) * Math.min(Math.abs(dl), dt * 2.5);
    const df = 1 - this.fade;
    this.fade += Math.min(df, dt * 1.6);
    const dd = this.dimTarget - this.dim;
    this.dim += Math.sign(dd) * Math.min(Math.abs(dd), dt * 4);

    const moved = Math.abs(dr) + Math.abs(dp) + Math.abs(dy) > 1e-4 || Math.abs(da) > 1e-3 || Math.abs(dn) + Math.abs(de) > 1e-3
      || db || Math.abs(dzoom) + Math.abs(delev) + Math.abs(daz) > 1e-4 || (!this.locked && this.blend > 0 && Math.abs(dc) > 1e-4)
      || dl || df > 0 || dd || this.force;
    if (!moved) return;
    this.force = false;

    const R = dcm(this.r, this.p, this.y);
    const down = -this.alt;
    let camR = R, cam = [this.n, this.e, down];
    const s = this.blend * this.blend * (3 - 2 * this.blend);
    if (s > 0) {
      const yaw = this.locked ? this.lockYaw : wrap(this.camYaw + c.az);
      const distance = CHASE_DIST * c.zoom, back = distance * Math.cos(c.elev), up = distance * Math.sin(c.elev);
      // Tilted so that the aircraft sits where the readings leave room for it.
      const look = Math.atan2((this.hud.aimY ?? this.h * .66) - this.h / 2, this.f);
      const pitch = look - c.elev;
      const from = [this.n - back * Math.cos(yaw), this.e - back * Math.sin(yaw), down - up];
      cam = s === 1 ? from : [cam[0] + (from[0] - cam[0]) * s, cam[1] + (from[1] - cam[1]) * s, cam[2] + (from[2] - cam[2]) * s];
      camR = s === 1 ? dcm(0, pitch, yaw) : dcm(this.r * (1 - s), this.p * (1 - s) + pitch * s, this.y + wrap(yaw - this.y) * s);
    }
    if (!this.plain) {
      for (const { el, bearing } of this.labels) this.placeLabel(camR, el, bearing);
      this.drawWorld(camR, cam, R, down, s);
    }
    if (!this.gl) return;

    const started = performance.now();
    const gl = this.gl, u = this.u;
    const clock = this.fakeTime ?? Date.now();
    if (!this.sunAt || clock - this.sunAt > 60000 || this.fakeTime) {
      this.sunAt = clock;
      const sun = this.sun = sunVector(this.lat, this.lon, clock);
      const colours = palette(Math.asin(-sun[2]) / rad);
      gl.uniform3fv(u.uSun, sun);
      gl.uniform3fv(u.uZen, colours.zen); gl.uniform3fv(u.uHor, colours.hor); gl.uniform3fv(u.uWarm, colours.warm); gl.uniform3fv(u.uGlow, colours.glow);
      gl.uniform3fv(u.uGndN, colours.gndN); gl.uniform3fv(u.uGndF, colours.gndF); gl.uniform3fv(u.uDot, colours.dot);
      gl.uniform3fv(u.uSunCol, colours.sun); gl.uniform1f(u.uStars, colours.stars);
    }
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uF, this.f * W / this.w);
    gl.uniform1f(u.uDpr, W / this.w);
    gl.uniformMatrix3fv(u.uR, false, [camR[0], camR[3], camR[6], camR[1], camR[4], camR[7], camR[2], camR[5], camR[8]]);
    gl.uniform1f(u.uAlt, -cam[2]);
    gl.uniform2f(u.uPos, cam[0], cam[1]);
    gl.uniform1f(u.uLive, this.live);
    gl.uniform1f(u.uFade, this.fade);
    gl.uniform1f(u.uDim, this.dim);
    gl.uniform1f(u.uCrisp, (this.dim - DIMMED) / (1 - DIMMED));
    gl.uniform1f(u.uPlain, this.plain ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Slow GPU: drop the render resolution rather than the frame rate.
    if (!this.fixedQuality) {
      gl.finish();
      this.slow = performance.now() - started > 24 ? this.slow + 1 : Math.max(0, this.slow - 1);
      if (this.slow > 20 && this.quality > .5) {
        this.quality -= .25;
        this.slow = 0;
        this.resize();
      }
    }
  }

  stroke(colour, width, dash = SOLID, alpha = 1) {
    const ctx = this.ctx;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The flight path with its shadow on the ground, the home point, and from behind the aircraft
  // itself: lines in the same frame as the shader's world, so they sit on its ground.
  drawWorld(camR, cam, R, down, s) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.lineDpr, 0, 0, this.lineDpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.homeTop = null;
    let ringsShown = 0;
    if (this.dimTarget === 1) {
      const toCam = (n, e, d) => {
        const vn = n - cam[0], ve = e - cam[1], vd = d - cam[2];
        return [camR[0] * vn + camR[3] * ve + camR[6] * vd, camR[1] * vn + camR[4] * ve + camR[7] * vd, camR[2] * vn + camR[5] * ve + camR[8] * vd];
      };
      const w2 = this.w / 2, h2 = this.h / 2, f = this.f;
      const at = c => [w2 + f * c[1] / c[0], h2 + f * c[2] / c[0]];
      const main = this.liveTarget ? this.colors.ink : this.colors.soft;
      const mark = this.liveTarget ? this.colors.amber : this.colors.soft;
      ctx.lineJoin = ctx.lineCap = 'round';
      if (this.homePoint) this.drawHome(toCam, at, mark);
      if (this.rings) ringsShown = this.drawRings(toCam, at);
      if (this.plan) this.drawPlan(toCam, at);
      if (this.target) this.drawTarget(toCam, at, down);
      if (this.prediction) this.drawPrediction(toCam, at, down);
      if (this.trail && this.showTrail) this.drawTrail(toCam, at, camR, main, s);
      if (s > .05) this.drawAircraft(toCam, at, R, down, main, Math.min(1, s * 1.6));
      this.fadeEdges(ctx);
    }

    for (let i = ringsShown; i < this.ringEls.length; i++) {
      if (this.ringEls[i].style.visibility !== 'hidden') this.ringEls[i].style.visibility = 'hidden';
    }

    // The home label sits on the post's top when that is in view, else on the horizon.
    if (this.homeEl) {
      const top = this.homeTop;
      if (!this.home) { if (this.homeEl.style.visibility !== 'hidden') this.homeEl.style.visibility = 'hidden'; }
      else if (!(top && this.placeAt(this.homeEl, top[0], top[1] - 9, 0, this.home.text))) this.placeLabel(camR, this.homeEl, this.home.bearing, this.home.text);
    }
  }

  drawTrail(toCam, at, camR, main, s) {
    const ctx = this.ctx;
    const near = (s > .5 ? CLEAR.chase : CLEAR.fpv) ** 2;
    const sky = [], ground = [];
    let prev = null;
    for (const p of this.trail) {
      if (prev && p[3] - prev[3] > GAP_S) { sky.push(null); ground.push(null); }
      const h = Math.max(p[2], 0) + EYE;
      const c = toCam(p[0], p[1], -h);
      sky.push(c[0] * c[0] + c[1] * c[1] + c[2] * c[2] < near ? null : c);
      // Its shadow is the same point h metres further down, which is one column of camR.
      ground.push([c[0] + camR[6] * h, c[1] + camR[7] * h, c[2] + camR[8] * h]);
      prev = p;
    }
    ctx.beginPath();
    traceSmooth(ctx, ground, at);
    this.stroke(this.colors.soft, HAIR, DASHED, .85);

    // From behind, thin lines down to the shadow show how high each part of the path was.
    if (s > .5) {
      let total = 0;
      for (let i = 1; i < ground.length; i++) {
        if (ground[i] && ground[i - 1]) total += Math.hypot(ground[i][0] - ground[i - 1][0], ground[i][1] - ground[i - 1][1], ground[i][2] - ground[i - 1][2]);
      }
      const step = Math.max(CURTAIN_M, total / CURTAIN_MAX);
      let walked = step;
      ctx.beginPath();
      for (let i = 1; i < ground.length; i++) {
        if (!ground[i] || !ground[i - 1]) continue;
        walked += Math.hypot(ground[i][0] - ground[i - 1][0], ground[i][1] - ground[i - 1][1], ground[i][2] - ground[i - 1][2]);
        if (walked >= step && sky[i]) {
          trace(ctx, [sky[i], ground[i]], at);
          walked = 0;
        }
      }
      this.stroke(this.colors.soft, HAIR, SOLID, .45);
    }

    // The older the path, the fainter, so the way it was flown can be read. Square ends, because round
    // ones would show through each other where the parts meet.
    const third = Math.floor(sky.length / 3);
    const parts = sky.length < 30 ? [[0, sky.length, .7]] : [[0, third + 1, .25], [third, 2 * third + 1, .45], [2 * third, sky.length, .7]];
    ctx.lineCap = 'butt';
    for (const [from, to, alpha] of parts) {
      ctx.beginPath();
      traceSmooth(ctx, sky.slice(from, to), at);
      this.stroke(main, TRAIL, SOLID, alpha);
    }
    ctx.lineCap = 'round';
  }

  // Home: a ring on the ground and a post, with a mark at its top while that is in view.
  drawHome(toCam, at, mark) {
    const ctx = this.ctx;
    const [hn, he] = this.homePoint;
    const pts = ring(hn, he, 0, HOME_RING, toCam, 16);
    const tip = toCam(hn, he, -(EYE + POST));
    pts.push(null, toCam(hn, he, 0), tip);
    ctx.beginPath();
    trace(ctx, pts, at);
    if (tip[0] >= NEAR) {
      const [x, y] = at(tip);
      if (x > -20 && x < this.w + 20 && y > 0 && y < this.h) {
        this.homeTop = [x, y];
        ctx.moveTo(x + 4, y);
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
      }
    }
    this.stroke(mark, LINE);
  }

  // What is stored on the flight controller, at its real place and height: the fence as walls up to
  // its ceiling, the route with a line down to the ground from each point, and the rally points.
  drawPlan(toCam, at) {
    const ctx = this.ctx, plan = this.plan, show = this.planShow;
    if (show.fence) {
      const top = plan.ceiling != null ? -(plan.ceiling + EYE) : null;
      const colour = plan.enabled ? this.colors.red : this.colors.soft;
      for (const { points, inside } of plan.polygons) {
        const loop = [...points, points[0]];
        ctx.beginPath();
        trace(ctx, loop.map(([n, e]) => toCam(n, e, 0)), at);
        if (top != null) {
          trace(ctx, loop.map(([n, e]) => toCam(n, e, top)), at);
          for (const [n, e] of points) trace(ctx, [toCam(n, e, 0), toCam(n, e, top)], at);
        }
        this.stroke(colour, HAIR, inside && plan.enabled && plan.polygonsOn ? SOLID : DASHED);
      }
      for (const { at: [n, e], radius, inside } of plan.circles) {
        ctx.beginPath();
        trace(ctx, ring(n, e, 0, radius, toCam, CIRCLE_SEGMENTS), at);
        if (top != null) trace(ctx, ring(n, e, top, radius, toCam, CIRCLE_SEGMENTS), at);
        this.stroke(colour, HAIR, inside && plan.enabled ? SOLID : DASHED);
      }
      if (plan.cylinder) {
        const [n, e] = plan.cylinder.at;
        ctx.beginPath();
        trace(ctx, ring(n, e, 0, plan.cylinder.radius, toCam, CIRCLE_SEGMENTS), at);
        if (top != null) trace(ctx, ring(n, e, top, plan.cylinder.radius, toCam, CIRCLE_SEGMENTS), at);
        this.stroke(colour, HAIR, plan.enabled ? SOLID : DASHED);
      }
    }
    if (show.rally) {
      for (const r of plan.rally) {
        const tip = toCam(r.n, r.e, -(r.alt + EYE));
        const pts = ring(r.n, r.e, 0, POINT_RING, toCam, 16);
        pts.push(null, toCam(r.n, r.e, 0), tip);
        ctx.beginPath();
        trace(ctx, pts, at);
        this.stroke(this.colors.amber, HAIR);
        this.markAt(tip, at, r.label, this.colors.amber, MARK_R);
      }
    }
    // A draft takes the place of what is stored, and is drawn dashed: it is not on the aircraft yet.
    const route = plan.draft ?? plan.route;
    if (show.plan && route.length) {
      const colour = plan.draft ? this.colors.ink : this.colors.plan;
      const sky = route.map(p => toCam(p.n, p.e, -(Math.max(p.alt, 0) + EYE)));
      const ground = route.map(p => toCam(p.n, p.e, 0));
      ctx.beginPath();
      trace(ctx, ground, at);
      this.stroke(colour, HAIR, DASHED, .6);
      ctx.beginPath();
      route.forEach((p, i) => { if (p.seq != null) trace(ctx, [sky[i], ground[i]], at); });
      this.stroke(colour, HAIR, SOLID, .6);
      ctx.beginPath();
      trace(ctx, sky, at);
      this.stroke(colour, LINE, plan.draft ? DASHED : SOLID);
      const next = plan.draft ? null : route.find(p => p.seq != null && p.seq >= this.currentItem);
      route.forEach((p, i) => {
        if (p.seq != null) this.markAt(sky[i], at, p.label, colour, p === next ? MARK_NEXT_R : MARK_R);
      });
    }
    for (const note of plan.notes) {
      const tip = toCam(note.n, note.e, -(POST + EYE));
      ctx.beginPath();
      trace(ctx, [toCam(note.n, note.e, 0), tip], at);
      this.stroke(this.colors.ink, HAIR);
      this.markAt(tip, at, note.name, this.colors.ink, MARK_R);
    }
  }

  // What a command would do, before it is sent: dashed from the aircraft along the way it would go,
  // with a post and a ring on the ground where it would end.
  drawPrediction(toCam, at, down) {
    const ctx = this.ctx;
    const way = [toCam(this.n, this.e, down)];
    for (const [n, e, h] of this.prediction.slice(1)) way.push(toCam(n, e, -(Math.max(h, 0) + EYE)));
    ctx.beginPath();
    trace(ctx, way, at);
    this.stroke(this.colors.amber, 2, DASHED);
    const [n, e, h] = this.prediction[this.prediction.length - 1];
    const mark = ring(n, e, 0, POINT_RING, toCam, 16);
    mark.push(null, toCam(n, e, 0), toCam(n, e, -(Math.max(h, 0) + EYE)));
    ctx.beginPath();
    trace(ctx, mark, at);
    this.stroke(this.colors.amber, LINE);
  }

  // Where it is heading: a dashed line from the aircraft, down to a ring on the ground.
  drawTarget(toCam, at, down) {
    const ctx = this.ctx;
    const [n, e, h] = this.target;
    const top = h != null ? -(Math.max(h, 0) + EYE) : down;
    const pts = ring(n, e, 0, POINT_RING, toCam, 16);
    pts.push(null, toCam(n, e, 0), toCam(n, e, top));
    ctx.beginPath();
    trace(ctx, pts, at);
    this.stroke(this.colors.plan, LINE);
    ctx.beginPath();
    trace(ctx, [toCam(this.n, this.e, down), toCam(n, e, top)], at);
    this.stroke(this.colors.plan, LINE, DASHED);
  }

  // A filled point with a short label above it, if it is in front of the camera and on the screen.
  markAt(c, at, label, colour, radius) {
    if (c[0] < NEAR) return;
    const [x, y] = at(c);
    if (x < -20 || x > this.w + 20 || y < -20 || y > this.h + 20) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.setLineDash(SOLID);
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(4, 7, 12, .75)';
    ctx.strokeText(label, x, y - LABEL_LIFT);
    ctx.fillText(label, x, y - LABEL_LIFT);
  }

  // Distance rings on the ground round home, each labelled on its far side. Until it has a home, round
  // the aircraft: they are still a scale to read against, so the setting always shows.
  drawRings(toCam, at) {
    const ctx = this.ctx;
    const [hn, he] = this.homePoint ?? [this.n, this.e];
    const radii = rangeRings(Math.hypot(this.n - hn, this.e - he));
    ctx.beginPath();
    for (const r of radii) trace(ctx, ring(hn, he, 0, r, toCam, r > 100 ? 96 : 48), at);
    this.stroke(this.colors.soft, HAIR);
    // A little to the right of the line to home, so they stay clear of the home label on that line.
    const dn = hn - this.n, de = he - this.e;
    const side = (Math.hypot(dn, de) < 1 ? this.camYaw : Math.atan2(de, dn)) + 20 * rad;
    let shown = 0;
    for (const r of radii) {
      const c = toCam(hn + Math.cos(side) * r, he + Math.sin(side) * r, 0);
      if (c[0] < NEAR || shown >= this.ringEls.length) continue;
      const [x, y] = at(c);
      const onHome = this.homeTop && Math.abs(x - this.homeTop[0]) < 72 && Math.abs(y - 4 - (this.homeTop[1] - 9)) < 22;
      if (!onHome && this.placeAt(this.ringEls[shown], x, y - 4, 0, `${r} m`)) shown++;
    }
    return shown;
  }

  // The aircraft, seen from behind. Real size, unless that would be too small to read from here.
  // The front rotors are brighter than the rear ones and the nose has a mark, so its heading shows.
  drawAircraft(toCam, at, R, down, main, alpha) {
    const ctx = this.ctx;
    const B = (x, y) => toCam(this.n + R[0] * x + R[1] * y, this.e + R[3] * x + R[4] * y, down + R[6] * x + R[7] * y);
    const hub = B(0, 0);
    if (hub[0] < NEAR) return;
    // Its real size, or the smallest that can be read from here, times the viewer's setting: every
    // setting is different from every other at every distance.
    const real = 2 * (ARM + ROTOR) * this.f / Math.hypot(hub[0], hub[1], hub[2]);
    const grow = Math.min(Math.max(real, MARKER_FLOOR) * this.markerScale, this.h * MARKER_CEILING) / real;
    const arm = ARM * grow, rotor = ROTOR * grow, a = arm / Math.SQRT2;

    const mark = ring(this.n, this.e, 0, arm + rotor, toCam, 24);
    mark.push(null, hub, toCam(this.n, this.e, 0));
    ctx.beginPath();
    trace(ctx, mark, at);
    this.stroke(this.colors.soft, HAIR, SOLID, alpha);

    ctx.beginPath();
    trace(ctx, [hub, B(a, a), null, hub, B(-a, -a), null, hub, B(a, -a), null, hub, B(-a, a)], at);
    this.stroke(main, LINE, SOLID, alpha);
    const disc = (x, y) => {
      const pts = [];
      for (let i = 0; i <= 18; i++) {
        const t = i / 18 * 2 * Math.PI;
        pts.push(B(x + rotor * Math.cos(t), y + rotor * Math.sin(t)));
      }
      return pts;
    };
    ctx.beginPath();
    trace(ctx, disc(a, a), at);
    trace(ctx, disc(a, -a), at);
    this.stroke(main, LINE, SOLID, alpha);
    ctx.beginPath();
    trace(ctx, disc(-a, -a), at);
    trace(ctx, disc(-a, a), at);
    this.stroke(this.colors.soft, HAIR, SOLID, alpha);

    const nose = [B(arm * .95, 0), B(arm * .3, arm * .26), B(arm * .3, -arm * .26)];
    if (nose.every(c => c[0] >= NEAR)) {
      const [p0, p1, p2] = nose.map(at);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.closePath();
      ctx.fillStyle = main;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (this.motors) this.drawMotors(B, at, a, rotor, main, alpha);
  }

  // How hard each motor is working, as on the sight: a share of its rotor's rim, in the colour of how
  // near that is to the limit, and its number. The rotors hold their numbers when they are large and
  // apart enough. Otherwise, or foreshortened as the aircraft leans, the numbers would land on each
  // other, so they go in four places round it, left and right, upper and lower, as the rotors lie.
  drawMotors(B, at, a, rotor, main, alpha) {
    const ctx = this.ctx;
    const hub = at(B(0, 0));
    const shown = [];
    [[a, a], [-a, -a], [a, -a], [-a, a]].forEach(([x, y], i) => {      // as ArduCopter numbers a quad X
      if (!this.motors[i]) return;
      const [v, tone] = this.motors[i];
      const colour = !this.liveTarget ? this.colors.soft : tone === 'bad' ? this.colors.red : tone === 'warn' ? this.colors.amber : main;
      if (v > 0) {
        const pts = [];
        const steps = Math.ceil(v / 100 * 18);
        for (let j = 0; j <= steps; j++) {
          const t = j / steps * (v / 100) * 2 * Math.PI;
          pts.push(B(x + rotor * Math.cos(t), y + rotor * Math.sin(t)));
        }
        ctx.beginPath();
        trace(ctx, pts, at);
        this.stroke(colour, GAUGE, SOLID, alpha);
      }
      const centre = B(x, y);
      if (centre[0] < NEAR) return;
      const c = at(centre), rim = at(B(x + rotor, y));
      shown.push({ text: String(v), colour, x: c[0], y: c[1], r: Math.hypot(rim[0] - c[0], rim[1] - c[1]) });
    });
    const roomy = shown.every((m, i) => m.r >= NUMBER_INSIDE_PX
      && shown.every((o, j) => j <= i || Math.hypot(m.x - o.x, m.y - o.y) >= NUMBER_APART_PX));
    if (!roomy) {
      const reach = Math.max(...shown.map(m => Math.abs(m.x - hub[0]) + m.r)) + NUMBER_BESIDE_PX;
      const byX = [...shown].sort((p, q) => p.x - q.x);
      for (const [side, sign] of [[byX.slice(0, 2), -1], [byX.slice(2), 1]]) {
        side.sort((p, q) => p.y - q.y).forEach((m, row) => {
          m.x = hub[0] + sign * reach;
          m.y = hub[1] + (side.length > 1 ? (row ? 1 : -1) * NUMBER_ROW_PX : 0);
        });
      }
    }
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.setLineDash(SOLID);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(4, 7, 12, .75)';
    ctx.globalAlpha = alpha;
    for (const m of shown) {
      ctx.fillStyle = m.colour;
      ctx.strokeText(m.text, m.x, m.y);
      ctx.fillText(m.text, m.x, m.y);
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  // Lines fade out before they reach the readings at the top and bottom of the screen, and stop
  // short of text elsewhere, the way a map keeps its lines off its labels.
  fadeEdges(ctx) {
    const { fadeTop, fadeBottom, clear } = this.hud;
    if (fadeBottom == null) return;
    for (const [left, top, right, bottom] of clear) ctx.clearRect(left - 6, top - 3, right - left + 12, bottom - top + 6);
    if (!this.fades) {
      const top = ctx.createLinearGradient(0, 0, 0, fadeTop);
      top.addColorStop(0, '#000');
      top.addColorStop(1, 'rgba(0,0,0,0)');
      const bottom = ctx.createLinearGradient(0, fadeBottom - FADE_PX, 0, fadeBottom);
      bottom.addColorStop(0, 'rgba(0,0,0,0)');
      bottom.addColorStop(1, '#000');
      this.fades = { top, bottom };
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = this.fades.top;
    ctx.fillRect(0, 0, this.w, fadeTop);
    ctx.fillStyle = this.fades.bottom;
    ctx.fillRect(0, fadeBottom - FADE_PX, this.w, this.h - fadeBottom + FADE_PX);
    ctx.globalCompositeOperation = 'source-over';
  }
}
