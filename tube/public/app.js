import { LINES } from './shared/lines.mjs';
import { buildModel, buildTimeline, locate } from './model.js';
import { createData } from './data.js';

// ---------------------------------------------------------------------------
// State

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);

const state = {
  W: 0, H: 0, dpr: 1,
  cam: { x: 0, y: 0, s: 0.05 }, fitScale: 0.05,
  focus: null,          // highlighted line id
  hidden: new Set(),    // filtered-out line ids
  sel: null,            // { type: 'station'|'train'|'line', id }
  hover: null,
  trains: new Map(),    // id -> train record
  trainCounts: {},
  status: new Map(),    // line id -> statuses
  clockOffset: 0,
  lastFetch: 0, fetchedAt: 0, feedError: null, stale: false,
  theme: null, colors: {},
  morph: null,
  q: '',               // search query
  river: true,         // minimalist Thames background
};
const now = () => Date.now() + state.clockOffset;

const network = await (await fetch('data/network.json')).json();
const model = buildModel(network, LINES);
const data = createData(network); // talks to TfL directly; no server needed

// ---------------------------------------------------------------------------
// Theme

function effectiveTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  state.theme = effectiveTheme();
  state.colors = { bg: cs.getPropertyValue('--bg').trim(), fg: cs.getPropertyValue('--fg').trim(), dim: cs.getPropertyValue('--dim').trim(), river: cs.getPropertyValue('--river').trim() };
  invalidate?.();
  for (const l of model.lines) l.c = state.theme === 'dark' && l.dark ? l.dark : l.color;
  document.querySelector('meta[name=theme-color]').content = state.colors.bg;
  renderLegend();
}
try { const t = localStorage.getItem('tube-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
$('theme').onclick = () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('tube-theme', next); } catch {}
  readTheme();
};

// ---------------------------------------------------------------------------
// Camera

function resize() {
  state.dpr = Math.min(window.devicePixelRatio || 1, 3); // full sharpness: the map is cached, so this is cheap
  state.W = innerWidth; state.H = innerHeight;
  canvas.width = Math.round(state.W * state.dpr);
  canvas.height = Math.round(state.H * state.dpr);
}
function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of model.stations.values()) {
    x0 = Math.min(x0, s.wx); y0 = Math.min(y0, s.wy); x1 = Math.max(x1, s.wx); y1 = Math.max(y1, s.wy);
  }
  return { x0, y0, x1, y1 };
}
function fitCam() {
  const b = bounds();
  const mobile = state.W <= 640;
  // Leave room for the sheet: on the left (desktop) or at the bottom (phone).
  const padL = mobile ? 16 : 400, padR = mobile ? 16 : 70, padT = mobile ? 70 : 40, padB = mobile ? 150 : 40;
  const aw = state.W - padL - padR, ah = state.H - padT - padB;
  const s = Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0));
  const cxs = padL + aw / 2, cys = padT + ah / 2;
  return { x: (b.x0 + b.x1) / 2 - (cxs - state.W / 2) / s, y: (b.y0 + b.y1) / 2 - (cys - state.H / 2) / s, s };
}
let camAnim = null;
function flyTo(target, ms = 700) {
  const from = { ...state.cam }, t0 = performance.now();
  camAnim = t => {
    let k = Math.min(1, (t - t0) / ms);
    k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const ls = Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * k;
    state.cam = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, s: Math.exp(ls) };
    if (k >= 1) camAnim = null;
  };
}
const sx = wx => (wx - state.cam.x) * state.cam.s + state.W / 2;
const sy = wy => (wy - state.cam.y) * state.cam.s + state.H / 2;
const zoom = () => state.cam.s / state.fitScale;

function zoomAt(px, py, factor) {
  const s2 = clampS(state.cam.s * factor);
  const wx = (px - state.W / 2) / state.cam.s + state.cam.x;
  const wy = (py - state.H / 2) / state.cam.s + state.cam.y;
  state.cam.s = s2;
  state.cam.x = wx - (px - state.W / 2) / s2;
  state.cam.y = wy - (py - state.H / 2) / s2;
}

// ---------------------------------------------------------------------------
// Sizes that scale gently with zoom (thin at distance, bolder up close)

function sizes() {
  const z = zoom();
  const lw = Math.min(7, Math.max(1.6, 1.6 * Math.pow(z, 0.62)));
  return { z, lw, gap: lw * 1.35, train: Math.min(1.9, Math.max(1, 0.9 + z * 0.12)) };
}

// ---------------------------------------------------------------------------
// Data

async function pollTrains() {
  if (document.hidden) return;
  try {
    const d = await data.trains();
    state.clockOffset = data.clockOffset;
    state.fetchedAt = d.fetchedAt; state.stale = d.stale; state.feedError = null;
    state.lastFetch = Date.now();
    ingest(d.trains);
  } catch (err) {
    state.feedError = String(err.message || err);
  }
  updateLive();
}

function ingest(list) {
  const t = now();
  const seen = new Set();
  const counts = {};
  for (const raw of list) {
    if (!model.lineById.has(raw.line)) continue;
    seen.add(raw.id);
    counts[raw.line] = (counts[raw.line] || 0) + 1;
    const pts = buildTimeline(model, raw);
    let tr = state.trains.get(raw.id);
    if (!tr) {
      tr = { id: raw.id, born: performance.now(), alpha: 0 };
      state.trains.set(raw.id, tr);
    } else if (tr.pts) {
      // Remember where it was drawn, then ease from there to the new estimate.
      const before = worldPos(tr, t);
      tr.raw = raw; tr.pts = pts;
      const after = worldPos(tr, t);
      if (before && after) {
        const d = Math.hypot(before.x - after.x, before.y - after.y);
        tr.corr = d < 900 ? { dx: before.x - after.x, dy: before.y - after.y, t0: performance.now() } : null;
      }
    }
    tr.raw = raw; tr.pts = pts; tr.gone = null;
    tr.uncertain = !raw.from;
  }
  for (const tr of state.trains.values()) if (!seen.has(tr.id) && !tr.gone) tr.gone = performance.now();
  state.trainCounts = counts;
  renderLegend();
  if (state.sel?.type === 'train' || state.sel?.type === 'line') renderPanel();
}

async function pollStatus() {
  if (document.hidden) return;
  try {
    const d = await data.status();
    state.status = new Map(d.lines.map(l => [l.id, l.statuses]));
    renderLegend();
    if (state.sel?.type === 'line') renderPanel();
  } catch {}
}

function updateLive() {
  const el = $('live'), txt = $('live-text');
  const n = [...state.trains.values()].filter(t => !t.gone).length;
  const age = state.fetchedAt ? Math.max(0, Math.round((now() - state.fetchedAt) / 1000)) : null;
  el.className = 'live ' + (!state.fetchedAt ? (state.feedError ? 'err' : '') : age > 120 || state.stale ? 'stale' : 'ok');
  if (!state.fetchedAt) txt.textContent = state.feedError ? 'TfL feed unavailable' : 'Connecting…';
  else if (age > 120) txt.textContent = `Delayed · ${fmtAgo(age)}`;
  else txt.textContent = `${n} trains live`;
  el.title = state.fetchedAt ? `Updated ${fmtAgo(age)}` : '';
}
const fmtAgo = s => (s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`);

// ---------------------------------------------------------------------------
// Train positions

// Position along the line path between two stations, in world coordinates,
// with the parallel-line offset (in gap units) and heading.
function along(lineId, a, b, f) {
  const line = model.lineById.get(lineId);
  const p = model.path(lineId, a, b);
  const S = id => model.stations.get(id);
  const vo = id => line.vofs.get(id) || [0, 0];
  if (p.length < 2 || a === b) {
    const s = S(a), o = vo(a);
    return { x: s.wx, y: s.wy, ox: o[0], oy: o[1], hx: 0, hy: 0 };
  }
  let total = 0;
  const L = [];
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(S(p[i]).wx - S(p[i - 1]).wx, S(p[i]).wy - S(p[i - 1]).wy); L.push(d); total += d; }
  let target = f * total, i = 0;
  while (i < L.length - 1 && target > L[i]) { target -= L[i]; i++; }
  const A = S(p[i]), B = S(p[i + 1]), k = L[i] ? Math.min(1, target / L[i]) : 0;
  const oa = vo(p[i]), ob = vo(p[i + 1]);
  const hx = B.wx - A.wx, hy = B.wy - A.wy, hl = Math.hypot(hx, hy) || 1;
  return { x: A.wx + (B.wx - A.wx) * k, y: A.wy + (B.wy - A.wy) * k, ox: oa[0] + (ob[0] - oa[0]) * k, oy: oa[1] + (ob[1] - oa[1]) * k, hx: hx / hl, hy: hy / hl };
}

function worldPos(tr, t) {
  const loc = locate(tr.pts, t);
  if (!loc) return null;
  const pos = along(tr.raw.line, loc.a, loc.b, loc.f);
  pos.loc = loc;
  return pos;
}

// ---------------------------------------------------------------------------
// Rendering

const labelWidths = new Map();
function measure(g, text, font) {
  const k = font + text;
  if (!labelWidths.has(k)) { g.font = font; labelWidths.set(k, g.measureText(text).width); }
  return labelWidths.get(k);
}

// ---------------------------------------------------------------------------
// Rendering
//
// Two layers. The "base" (lines, stations, labels) is drawn into an offscreen
// bitmap only when something about it changes. Every frame we just paste that
// bitmap and draw the trains on top. While the camera moves, the bitmap is
// pasted scaled/shifted and re-rendered crisply once the motion settles, the
// same trick map apps use. This keeps per-frame work tiny on phones.

const base = document.createElement('canvas');
const bctx = base.getContext('2d');
const labels = document.createElement('canvas'); // same geometry, drawn above the trains
const lctx = labels.getContext('2d');
let MARGIN = 0.35;       // base extends this fraction beyond each screen edge (smaller on phones to save memory)
let baseCam = null, baseKey = '', baseDirty = true;
let lastCam = { x: 0, y: 0, s: 0 }, lastCamMove = -1e9, lastDraw = 0;
let stationHits = [];    // { s, wx, wy, ox, oy, r } for hit testing at any camera
let trainScreen = [];    // { tr, x, y } from the last frame
let netBounds = null;

function lineAlpha(id) {
  if (state.hidden.has(id)) return 0;
  if (state.focus && state.focus !== id) return 0.12;
  if (state.sel?.type === 'train' && state.trains.get(state.sel.id)?.raw.line !== id) return 0.35;
  return 1;
}
const invalidate = () => { baseDirty = true; };

function baseStateKey() {
  const selLine = state.sel?.type === 'train' ? state.trains.get(state.sel.id)?.raw.line : '';
  return [state.W, state.H, state.dpr, state.theme, state.focus, [...state.hidden].join(), selLine,
    state.sel?.type === 'station' ? state.sel.id : '', state.hover?.s?.id || '', model.layout,
    snap, $('sheet').offsetHeight, state.river].join('|');
}

// Screen position of a station on a given line (with parallel-line offset).
function P(lineId, id, gap) {
  const s = model.stations.get(id), o = model.lineById.get(lineId).vofs.get(id) || [0, 0];
  return [sx(s.wx) + o[0] * gap, sy(s.wy) + o[1] * gap];
}

// Reference zoom = "whole network on a laptop screen", so label density is
// the same at the same physical scale on a phone and a desktop.
function refFit() {
  const b = netBounds;
  return Math.min(1010 / (b.x1 - b.x0), 680 / (b.y1 - b.y0));
}

function renderBase() {
  const { W, H, dpr } = state;
  MARGIN = W < 640 ? 0.25 : 0.35;
  const bw = W * (1 + 2 * MARGIN), bh = H * (1 + 2 * MARGIN);
  const pw = Math.round(bw * dpr), ph = Math.round(bh * dpr);
  for (const c of [base, labels]) if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, pw, ph);
  lctx.setTransform(dpr, 0, 0, dpr, MARGIN * W * dpr, MARGIN * H * dpr);
  const g = bctx;
  g.setTransform(dpr, 0, 0, dpr, MARGIN * W * dpr, MARGIN * H * dpr);
  g.fillStyle = state.colors.bg;
  g.fillRect(-MARGIN * W, -MARGIN * H, bw, bh);
  g.lineCap = 'round'; g.lineJoin = 'round';
  netBounds = bounds();

  const { lw, gap } = sizes();
  const { bg, fg } = state.colors;
  const x0 = -MARGIN * W - 40, y0 = -MARGIN * H - 40, x1 = W * (1 + MARGIN) + 40, y1 = H * (1 + MARGIN) + 40;

  // Lines, with rounded corners at bends.
  // The Thames: a soft, wide band under everything (optional).
  if (state.river && model.river.length > 1) {
    const pts = model.river.map(([x, y]) => [sx(x), sy(y)]);
    g.strokeStyle = state.colors.river;
    g.lineWidth = Math.min(70, Math.max(7, state.cam.s * 120));
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    g.stroke();
  }

  const corner = Math.max(4, lw * 3);
  const segs = []; // screen-space line segments: obstacles for labels
  for (const l of model.lines) {
    const a = lineAlpha(l.id);
    if (!a) continue;
    g.globalAlpha = a; g.strokeStyle = l.c; g.lineWidth = lw;
    g.beginPath();
    for (const ch of l.chains) {
      const pts = ch.map(id => P(l.id, id, gap));
      for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
        const d1 = Math.hypot(cx - px, cy - py), d2 = Math.hypot(nx - cx, ny - cy);
        const r = Math.min(corner, d1 / 2, d2 / 2);
        if (r < 0.5) { g.lineTo(cx, cy); continue; }
        g.lineTo(cx - ((cx - px) / d1) * r, cy - ((cy - py) / d1) * r);
        g.quadraticCurveTo(cx, cy, cx + ((nx - cx) / d2) * r, cy + ((ny - cy) / d2) * r);
      }
      const last = pts[pts.length - 1];
      g.lineTo(last[0], last[1]);
    }
    g.stroke();
  }
  g.globalAlpha = 1;

  // Hub connectors (e.g. the two Paddington stations).
  for (const s of model.stations.values()) for (const o of s.siblings) if (o > s.id) {
    const so = model.stations.get(o);
    if (!visibleStation(s) && !visibleStation(so)) continue;
    const w = Math.max(4, lw * 2.2);
    g.beginPath(); g.moveTo(sx(s.wx), sy(s.wy)); g.lineTo(sx(so.wx), sy(so.wy));
    g.strokeStyle = fg; g.lineWidth = w; g.stroke();
    g.strokeStyle = bg; g.lineWidth = w - 2.4; g.stroke();
  }

  // Stations.
  stationHits = [];
  const onScreen = [];
  for (const s of model.stations.values()) {
    const vis = s.lines.filter(id => !state.hidden.has(id));
    if (!vis.length) continue;
    const x = sx(s.wx), y = sy(s.wy);
    if (x < x0 || y < y0 || x > x1 || y > y1) continue;
    g.globalAlpha = Math.max(...vis.map(lineAlpha));
    let hit;
    if (s.interchange) {
      let m = 0;
      for (const id of vis) { const o = model.lineById.get(id).vofs.get(s.id); if (o) m = Math.max(m, Math.hypot(o[0], o[1])); }
      const r = m * gap + Math.max(2.6, lw * 1.05);
      g.fillStyle = bg; g.strokeStyle = fg; g.lineWidth = Math.max(1.2, lw * 0.55);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      hit = { s, ox: 0, oy: 0, r: r + 3 };
    } else {
      const id = vis[0], l = model.lineById.get(id), o = l.vofs.get(s.id) || [0, 0];
      const px = x + o[0] * gap, py = y + o[1] * gap;
      if (s.terminal) {
        const r = Math.max(2.6, lw * 1.15);
        g.fillStyle = l.c; g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = bg; g.beginPath(); g.arc(px, py, r * 0.42, 0, Math.PI * 2); g.fill();
        hit = { s, ox: o[0], oy: o[1], r: r + 4 };
      } else {
        const r = Math.max(1.5, lw * 0.75);
        g.fillStyle = bg; g.strokeStyle = l.c; g.lineWidth = Math.max(1, lw * 0.5);
        g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); g.stroke();
        hit = { s, ox: o[0], oy: o[1], r: r + 5 };
      }
    }
    stationHits.push(hit);
    if (x > -20 && y > -20 && x < W + 20 && y < H + 20) onScreen.push({ ...hit, x: x + hit.ox * gap, y: y + hit.oy * gap });
  }
  g.globalAlpha = 1;

  drawLabels(lctx, onScreen, segs, lw);
  baseCam = { ...state.cam };
  baseDirty = false;
}

function visibleStation(s) { return s.lines.some(id => !state.hidden.has(id)); }

// Does segment (x1,y1)-(x2,y2) touch rectangle r?
function segHitsRect(x1, y1, x2, y2, r) {
  const rx2 = r.x + r.w, ry2 = r.y + r.h;
  if (Math.max(x1, x2) < r.x || Math.min(x1, x2) > rx2 || Math.max(y1, y2) < r.y || Math.min(y1, y2) > ry2) return false;
  const inside = (x, y) => x >= r.x && x <= rx2 && y >= r.y && y <= ry2;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  const cross = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (!d) return false;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  return cross(x1, y1, x2, y2, r.x, r.y, rx2, r.y) || cross(x1, y1, x2, y2, rx2, r.y, rx2, ry2)
    || cross(x1, y1, x2, y2, r.x, ry2, rx2, ry2) || cross(x1, y1, x2, y2, r.x, r.y, r.x, ry2);
}

// Labels are placed like on a printed map: never over another label, a
// station or the floating UI, and preferably not across any line. Minor
// stations whose name can't be placed cleanly are simply not labelled.
function drawLabels(g, hits, segs, lw) {
  const z = state.cam.s / refFit();
  const small = state.W < 640;
  const fs = small ? 12 : Math.round(Math.min(13, 11 + Math.max(0, z - 1) * 0.5));
  const font = `500 ${fs}px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Helvetica Neue", Arial, sans-serif`;
  const selSt = state.sel?.type === 'station' ? model.stations.get(state.sel.id) : null;

  const CELL = 48;
  const key = (cx, cy) => cx * 100003 + cy;
  const cellsOf = r => { const out = []; for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) out.push(key(cx, cy)); return out; };
  const hard = new Map(), soft = new Map(), marks = new Map();
  const addTo = (grid, item, r) => { for (const c of cellsOf(r)) (grid.get(c) || grid.set(c, []).get(c)).push(item); };
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Hard obstacles: floating UI and station markers.
  for (const el of document.querySelectorAll('.hud > *, .sheet')) {
    const r = el.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) { const o = { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 }; addTo(hard, o, o); }
  }
  for (const h of hits) { const o = { x: h.x - h.r, y: h.y - h.r, w: h.r * 2, h: h.r * 2, s: h.s }; addTo(marks, o, o); }
  // Soft obstacles: the lines themselves (inflated by half a line width).
  const pad = lw / 2 + 1;
  for (const sg of segs) {
    const [x1, y1, x2, y2] = sg;
    if (Math.max(x1, x2) < -50 || Math.min(x1, x2) > state.W + 50 || Math.max(y1, y2) < -50 || Math.min(y1, y2) > state.H + 50) continue;
    addTo(soft, sg, { x: Math.min(x1, x2) - pad, y: Math.min(y1, y2) - pad, w: Math.abs(x2 - x1) + pad * 2, h: Math.abs(y2 - y1) + pad * 2 });
  }
  const hitsHard = r => cellsOf(r).some(c => (hard.get(c) || []).some(o => overlaps(r, o)));
  const hitsMark = (r, own) => cellsOf(r).some(c => (marks.get(c) || []).some(o => o.s !== own && overlaps(r, o)));
  const hitsSoft = r => {
    const rr = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    return cellsOf(r).some(c => (soft.get(c) || []).some(([x1, y1, x2, y2]) => segHitsRect(x1, y1, x2, y2, rr)));
  };

  const cands = [];
  for (const h of hits) {
    const s = h.s, n = s.lines.length;
    let pri = n * 10 + (s.terminal ? 12 : 0) + (s.interchange ? 6 : 0);
    let show = z > 2.2 || (z > 1.4 && (s.interchange || s.terminal)) || n >= 3 || (s.terminal && z > 1.1);
    if (state.focus && s.lines.includes(state.focus)) { show = show || z > 1.1; pri += 30; }
    if (selSt === s || state.hover?.s === s) { show = true; pri = 1000; }
    if (show) cands.push({ h, pri });
  }
  cands.sort((a, b) => b.pri - a.pri);

  g.font = font; g.textBaseline = 'middle'; g.textAlign = 'left'; g.lineJoin = 'round';
  const hgt = fs + 3;
  for (const { h, pri } of cands) {
    const w = measure(g, h.s.name, font), off = h.r + 3, d = off * 0.75;
    const opts = [
      [h.x + off, h.y - hgt / 2], [h.x - off - w, h.y - hgt / 2],
      [h.x + d, h.y - d - hgt], [h.x + d, h.y + d], [h.x - d - w, h.y - d - hgt], [h.x - d - w, h.y + d],
      [h.x - w / 2, h.y - off - hgt], [h.x - w / 2, h.y + off],
    ].map(([x, y]) => ({ x, y, w, h: hgt }));
    let r = opts.find(o => !hitsHard(o) && !hitsMark(o, h.s) && !hitsSoft(o));
    // Important stations may cross a line or brush a neighbouring marker (the
    // halo keeps them legible) rather than vanish; never another label.
    if (!r && pri >= 20) r = opts.find(o => !hitsHard(o) && !hitsMark(o, h.s)) || opts.find(o => !hitsHard(o));
    if (!r && pri >= 1000) r = opts[0];
    if (!r) continue;
    addTo(hard, r, r);
    g.globalAlpha = Math.max(0.25, Math.max(...h.s.lines.map(lineAlpha)));
    // A soft glow in the background colour instead of a hard outline: it
    // lifts the text off any line behind it without looking stroked.
    g.fillStyle = state.colors.fg;
    g.shadowColor = state.colors.bg; g.shadowBlur = 5 * state.dpr;
    g.fillText(h.s.name, r.x, r.y + hgt / 2);
    g.fillText(h.s.name, r.x, r.y + hgt / 2);
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    g.fillText(h.s.name, r.x, r.y + hgt / 2);
  }
  g.globalAlpha = 1;
}

// Keep the network on screen.
function clampCam() {
  if (!netBounds) return;
  const b = netBounds, mx = (b.x1 - b.x0) * 0.15, my = (b.y1 - b.y0) * 0.15;
  state.cam.x = Math.min(b.x1 + mx, Math.max(b.x0 - mx, state.cam.x));
  state.cam.y = Math.min(b.y1 + my, Math.max(b.y0 - my, state.cam.y));
}

function frame(tms) {
  requestAnimationFrame(frame);
  if (camAnim) camAnim(tms);
  if (state.morph) {
    const k = Math.min(1, (tms - state.morph.t0) / 900);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    model.setLayout(state.morph.mode, e);
    baseDirty = true;
    if (k >= 1) state.morph = null;
  }
  clampCam();
  const c = state.cam;
  if (c.x !== lastCam.x || c.y !== lastCam.y || c.s !== lastCam.s) { lastCamMove = tms; lastCam = { ...c }; }
  const key = baseStateKey();
  if (key !== baseKey) { baseKey = key; baseDirty = true; }
  const moving = tms - lastCamMove < 150 || pointers.size > 0;

  // Where the cached base lands on screen at the current camera.
  let k = 1, dx = 0, dy = 0, dw = 0, dh = 0;
  const place = () => {
    k = c.s / baseCam.s;
    dw = state.W * (1 + 2 * MARGIN) * k; dh = state.H * (1 + 2 * MARGIN) * k;
    dx = (-MARGIN * state.W - state.W / 2) * k + (baseCam.x - c.x) * c.s + state.W / 2;
    dy = (-MARGIN * state.H - state.H / 2) * k + (baseCam.y - c.y) * c.s + state.H / 2;
  };
  let rerender = baseDirty || !baseCam;
  if (!rerender) {
    place();
    const stale = c.x !== baseCam.x || c.y !== baseCam.y || c.s !== baseCam.s;
    const uncovered = dx > 0.5 || dy > 0.5 || dx + dw < state.W - 0.5 || dy + dh < state.H - 0.5;
    rerender = (stale && !moving) || uncovered || k < 0.7 || k > 1.45;
  }
  lastDraw = tms;
  if (rerender) { renderBase(); place(); }

  const { dpr } = state;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = state.colors.bg;
  ctx.fillRect(0, 0, state.W, state.H);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, dx, dy, dw, dh);
  drawLive(tms);
  ctx.drawImage(labels, dx, dy, dw, dh);
  drawRings();
}

// --- Live layer: selected route, trains, selection rings ---------------------

function capsule(g, x, y, hx, hy, L, Wd) {
  const r = Wd / 2, h = Math.max(0, L / 2 - r);
  const ang = Math.atan2(hy, hx);
  const fx = x + hx * h, fy = y + hy * h, bx = x - hx * h, by = y - hy * h;
  g.moveTo(fx + Math.cos(ang - Math.PI / 2) * r, fy + Math.sin(ang - Math.PI / 2) * r);
  g.arc(fx, fy, r, ang - Math.PI / 2, ang + Math.PI / 2);
  g.arc(bx, by, r, ang + Math.PI / 2, ang + Math.PI * 1.5);
  g.closePath();
}

function drawLive(tms) {
  const g = ctx;
  const { lw, gap } = sizes();
  const { bg, fg } = state.colors;
  g.lineCap = 'round'; g.lineJoin = 'round';
  const t = now(), pnow = performance.now();
  const selTrain = state.sel?.type === 'train' ? state.trains.get(state.sel.id) : null;

  // Selected train: highlight the route ahead.
  if (selTrain?.pts) {
    const l = model.lineById.get(selTrain.raw.line);
    const loc = locate(selTrain.pts, t);
    const ids = [];
    if (loc) {
      ids.push(loc.a);
      for (let i = loc.i + (loc.moving ? 0 : 1); i < selTrain.pts.length; i++) {
        for (const id of model.path(l.id, ids[ids.length - 1], selTrain.pts[i].s).slice(1)) ids.push(id);
      }
    }
    if (ids.length > 1) {
      g.strokeStyle = l.c; g.globalAlpha = 0.28; g.lineWidth = lw * 3.2;
      g.beginPath();
      ids.forEach((id, i) => { const [x, y] = P(l.id, id, gap); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke(); g.globalAlpha = 1;
    }
  }

  // Trains: compute positions, then draw in batches (one path per line).
  trainScreen = [];
  const tw = Math.min(13, Math.max(4, lw * 1.9)), tl = tw * 1.75; // grow with zoom so trains stay visible on thick lines
  const batches = new Map(); // line|uncertain -> [{x,y,hx,hy}]
  const singles = [];
  for (const tr of state.trains.values()) {
    if (!tr.pts) continue;
    const lid = tr.raw.line;
    let a = lineAlpha(lid);
    if (!a) continue;
    if (tr.gone) { const f = 1 - (pnow - tr.gone) / 1500; if (f <= 0) { state.trains.delete(tr.id); continue; } a *= f; }
    else a *= Math.min(1, (pnow - tr.born) / 900);
    if (t - tr.raw.observedAt > 180_000) a *= 0.45;
    const pos = worldPos(tr, t);
    if (!pos) continue;
    let wx = pos.x, wy = pos.y;
    if (tr.corr) {
      const f = Math.exp(-(pnow - tr.corr.t0) / 900);
      if (f < 0.01) tr.corr = null; else { wx += tr.corr.dx * f; wy += tr.corr.dy * f; }
    }
    let hx = pos.hx, hy = pos.hy;
    if (!hx && !hy) [hx, hy] = tr.h || [1, 0];
    tr.h = [hx, hy];
    const side = lw * 0.45; // keep left, like the trains themselves
    const x = sx(wx) + pos.ox * gap + hy * side, y = sy(wy) + pos.oy * gap - hx * side;
    if (x < -20 || y < -20 || x > state.W + 20 || y > state.H + 20) continue;
    trainScreen.push({ tr, x, y, hx, hy, L: tr === selTrain ? tl * 1.3 : tl, W: tr === selTrain ? tw * 1.3 : tw });
    const item = { x, y, hx, hy, a, tr };
    if (tr === selTrain || a < 0.98) singles.push(item);
    else {
      const key = lid + (tr.uncertain ? '|u' : '');
      (batches.get(key) || batches.set(key, []).get(key)).push(item);
    }
  }
  const drawSet = (items, lid, uncertain, L, Wd, alpha) => {
    const c = model.lineById.get(lid).c;
    g.globalAlpha = alpha;
    g.beginPath();
    for (const it of items) capsule(g, it.x, it.y, it.hx, it.hy, L, Wd);
    g.lineWidth = 1.6; g.strokeStyle = bg; g.stroke();
    if (uncertain) { g.fillStyle = bg; g.fill(); g.lineWidth = 1.3; g.strokeStyle = c; g.stroke(); }
    else { g.fillStyle = c; g.fill(); }
    // Nose dot shows direction, but only once trains are big enough to read it.
    if (Wd < 7) return;
    g.beginPath();
    const nr = Wd * 0.22, no = L / 2 - Wd / 2;
    for (const it of items) { g.moveTo(it.x + it.hx * no + nr, it.y + it.hy * no); g.arc(it.x + it.hx * no, it.y + it.hy * no, nr, 0, Math.PI * 2); }
    g.fillStyle = uncertain ? c : bg; g.globalAlpha = alpha * 0.9; g.fill();
  };
  for (const [key, items] of batches) { const [lid, u] = key.split('|'); drawSet(items, lid, !!u, tl, tw, 1); }
  for (const it of singles) {
    const isSel = it.tr === selTrain;
    const L = isSel ? tl * 1.3 : tl, Wd = isSel ? tw * 1.3 : tw;
    if (isSel) {
      const pulse = 0.5 + 0.5 * Math.sin(pnow / 300);
      g.globalAlpha = it.a * (0.18 + 0.12 * pulse); g.fillStyle = model.lineById.get(it.tr.raw.line).c;
      g.beginPath(); g.arc(it.x, it.y, L * 1.4, 0, Math.PI * 2); g.fill();
    }
    drawSet([it], it.tr.raw.line, it.tr.uncertain, L, Wd, it.a);
  }
  g.globalAlpha = 1;

}

function drawRings() {
  const g = ctx, { gap } = sizes(), { fg } = state.colors, pnow = performance.now();
  // Selected station ring.
  if (state.sel?.type === 'station') {
    const h = stationHits.find(h => h.s.id === state.sel.id);
    if (h) {
      const x = sx(h.s.wx) + h.ox * gap, y = sy(h.s.wy) + h.oy * gap;
      g.strokeStyle = fg; g.lineWidth = 1.5; g.globalAlpha = 0.6 + 0.4 * Math.sin(pnow / 350);
      g.beginPath(); g.arc(x, y, h.r + 4, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Interaction: pan, pinch, double-tap, inertia

const pointers = new Map();
let gesture = null, samples = [], lastTap = null, inertia = null;
let touchInput = false; // fingers need bigger hit targets than a mouse

const toWorld = (px, py, cam = state.cam) => ({ x: (px - state.W / 2) / cam.s + cam.x, y: (py - state.H / 2) / cam.s + cam.y });
const clampS = s => Math.min(state.fitScale * 40, Math.max(state.fitScale * 0.6, s));

function startPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, w0: toWorld(mid.x, mid.y), s0: state.cam.s, moved: true };
}
function startPan(p, moved = false) {
  gesture = { type: 'pan', x0: p.x, y0: p.y, lx: p.x, ly: p.y, t0: performance.now(), moved };
  samples = [{ t: performance.now(), x: p.x, y: p.y }];
}

canvas.addEventListener('pointerdown', e => {
  touchInput = e.pointerType === 'touch';
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  inertia = null; camAnim = null;
  if (pointers.size === 1) startPan(pointers.get(e.pointerId));
  else if (pointers.size === 2) startPinch();
});

canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') hoverAt(e.clientX, e.clientY); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = clampS(gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0);
    // Keep the world point that started under the fingers under the fingers.
    state.cam = { s, x: gesture.w0.x - (mid.x - state.W / 2) / s, y: gesture.w0.y - (mid.y - state.H / 2) / s };
    return;
  }
  if (gesture.type !== 'pan') return;
  const slop = touchInput ? 8 : 4;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < slop) return;
  if (!gesture.moved) { gesture.moved = true; gesture.lx = e.clientX; gesture.ly = e.clientY; canvas.classList.add('dragging'); }
  state.cam.x -= (e.clientX - gesture.lx) / state.cam.s;
  state.cam.y -= (e.clientY - gesture.ly) / state.cam.s;
  gesture.lx = e.clientX; gesture.ly = e.clientY;
  const tnow = performance.now();
  samples.push({ t: tnow, x: e.clientX, y: e.clientY });
  while (samples.length > 2 && tnow - samples[0].t > 100) samples.shift();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    // Lifting one finger continues as a pan from the remaining one.
    if (pointers.size === 1) { startPan([...pointers.values()][0], true); gesture.afterPinch = true; }
    else if (pointers.size === 0) gesture = null;
    return;
  }
  if (pointers.size > 0) return;
  const g = gesture; gesture = null;
  const tnow = performance.now();
  if (!g.moved && tnow - g.t0 < 450) {
    // Double-tap zooms only on empty map: two quick taps on a train or a
    // station should not make the whole map jump.
    if (touchInput && lastTap?.empty && tnow - lastTap.t < 320 && Math.hypot(lastTap.x - e.clientX, lastTap.y - e.clientY) < 30) {
      lastTap = null;
      zoomTo(e.clientX, e.clientY, 2);
      return;
    }
    lastTap = { t: tnow, x: e.clientX, y: e.clientY, empty: !pick(e.clientX, e.clientY) };
    clickAt(e.clientX, e.clientY);
    return;
  }
  if (g.moved && !g.afterPinch && samples.length > 1) {
    const a = samples[0], b = samples[samples.length - 1], dt = b.t - a.t;
    if (dt > 0 && tnow - b.t < 60) {
      const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
      if (Math.hypot(vx, vy) > 0.2) startInertia(vx, vy);
    }
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { state.hover = null; $('tip').hidden = true; } });

function startInertia(vx, vy) {
  let last = performance.now();
  const step = () => {
    if (inertia !== step) return;
    const t = performance.now(), dt = Math.min(32, t - last); last = t;
    state.cam.x -= (vx * dt) / state.cam.s; state.cam.y -= (vy * dt) / state.cam.s;
    const f = Math.pow(0.995, dt); vx *= f; vy *= f;
    if (Math.hypot(vx, vy) > 0.02) requestAnimationFrame(step); else inertia = null;
  };
  inertia = step;
  requestAnimationFrame(step);
}

function zoomTo(px, py, factor, ms = 380) {
  const w = toWorld(px, py), s = clampS(state.cam.s * factor);
  flyTo({ s, x: w.x - (px - state.W / 2) / s, y: w.y - (py - state.H / 2) / s }, ms);
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  camAnim = null; inertia = null;
  const unit = e.deltaMode === 1 ? 16 : 1;
  const k = e.ctrlKey ? 0.012 : 0.0022;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * k));
}, { passive: false });

canvas.addEventListener('dblclick', e => { if (!touchInput) zoomTo(e.clientX, e.clientY, 2.2, 450); });

// Hit-testing measures the distance to the edge of what is drawn (a train's
// capsule, a station's ring), so whatever is actually under the finger wins.
// Trains standing in a station are therefore just as tappable as the station.
function pick(x, y) {
  const { gap } = sizes();
  const slack = touchInput ? 14 : 5;
  let best = null, bd = Infinity;
  for (const h of trainScreen) {
    const half = Math.max(0, h.L / 2 - h.W / 2);
    const t = Math.max(-half, Math.min(half, (x - h.x) * h.hx + (y - h.y) * h.hy));
    const d = Math.hypot(x - (h.x + h.hx * t), y - (h.y + h.hy * t)) - h.W / 2;
    if (d < slack && d < bd) { bd = d; best = { type: 'train', tr: h.tr }; }
  }
  for (const h of stationHits) {
    const r = Math.max(2, h.r - 4); // drawn radius (hit radius includes padding)
    const d = Math.hypot(sx(h.s.wx) + h.ox * gap - x, sy(h.s.wy) + h.oy * gap - y) - r;
    // Ties go to the train (it's drawn on top); stations need to be strictly closer.
    if (d < slack && d < bd - 1) { bd = d; best = { type: 'station', s: h.s }; }
  }
  return best;
}

function hoverAt(x, y) {
  const p = pick(x, y);
  state.hover = p;
  canvas.classList.toggle('hover', !!p);
  const tip = $('tip');
  if (!p) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
  if (p.type === 'station') tip.textContent = p.s.name;
  else {
    const l = model.lineById.get(p.tr.raw.line);
    tip.textContent = `${l.name} · ${p.tr.raw.destinationName ? 'to ' + p.tr.raw.destinationName : 'train ' + p.tr.raw.vehicleId}`;
  }
}

function clickAt(x, y) {
  const p = pick(x, y);
  if (!p) {
    if (state.sel) closeDetail();
    else if (isPhone() && snap !== 'peek') setSnap('peek');
    $('q').blur();
    return;
  }
  if (p.type === 'train') select({ type: 'train', id: p.tr.id });
  else select({ type: 'station', id: p.s.id });
}

function setLayout(mode) {
  if (mode === model.layout && !state.morph) return;
  document.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('on', b.dataset.layout === mode));
  // Fit to the destination layout while morphing.
  model.setLayout(mode, 1); const target = fitCam(); model.setLayout(mode, 0);
  state.morph = { mode, t0: performance.now() };
  flyTo(target, 900);
}
$('fit').onclick = () => flyTo(fitCam());
try { state.river = localStorage.getItem('tube-river') !== '0'; } catch {}
const syncRiverBtn = () => { $('river').classList.toggle('on', state.river); $('river').setAttribute('aria-pressed', state.river); };
syncRiverBtn();
$('river').onclick = () => { state.river = !state.river; syncRiverBtn(); try { localStorage.setItem('tube-river', state.river ? '1' : '0'); } catch {} };
document.querySelectorAll('[data-layout]').forEach(btn => btn.onclick = () => setLayout(btn.dataset.layout));
$('layout-btn').onclick = () => setLayout(model.layout === 'geo' ? 'schematic' : 'geo');
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.q) { $('q').value = ''; state.q = ''; renderSheet(); } else if (state.sel) closeDetail(); }
});
// iOS Safari changes the viewport height whenever its toolbars show or hide;
// only a width change (rotation, window resize) may rescale the map.
let lastW = innerWidth;
addEventListener('resize', () => {
  resize();
  if (innerWidth !== lastW) { lastW = innerWidth; const f = fitCam().s; state.cam.s *= f / state.fitScale; state.fitScale = f; }
  invalidate(); setSnap(snap, false);
});

// ---------------------------------------------------------------------------
// The sheet: search, service status, lines, and station / train / line detail.
// Phones: docked at the bottom with three snap points. Desktop: a left card.

const sheet = $('sheet'), sheetBody = $('sheet-body');
const isPhone = () => state.W <= 640;
let snap = 'peek';

const safeBottom = (() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom);visibility:hidden';
  document.body.appendChild(probe);
  return () => probe.offsetHeight;
})();

function snapHeight(name) {
  const peek = sheet.querySelector('.grab').offsetHeight + $('sheet-top').offsetHeight + safeBottom() + 4;
  if (name === 'peek') return peek;
  if (name === 'half') return Math.max(peek + 180, Math.round(state.H * 0.5));
  return sheet.offsetHeight;
}
// Height of map hidden behind the sheet (phones) / width taken on the left (desktop).
const sheetCover = () => (isPhone() ? snapHeight(snap) : 0);

function setSnap(name, animate = true) {
  snap = name;
  if (!isPhone()) { sheet.style.transform = ''; sheetBody.style.height = ''; return; }
  const h = snapHeight(name);
  sheet.classList.toggle('anim', animate);
  sheet.style.transform = `translateY(${sheet.offsetHeight - h}px)`;
  sheetBody.style.height = Math.max(0, h - (snapHeight('peek') - safeBottom())) + 'px';
  invalidate();
}

// Drag the sheet by its handle / header.
{
  let d = null;
  const down = e => {
    if (!isPhone() || e.target.closest('input, button, .search')) return;
    const m = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
    d = { id: e.pointerId, y0: e.clientY, start: m.m42, t: performance.now(), moved: false, samples: [[performance.now(), e.clientY]] };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    sheet.classList.remove('anim');
  };
  const move = e => {
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y0;
    if (Math.abs(dy) > 4) d.moved = true;
    const min = 0, max = sheet.offsetHeight - snapHeight('peek');
    let y = d.start + dy;
    if (y < min) y = min - Math.sqrt(min - y) * 2; // rubber band
    if (y > max) y = max + Math.sqrt(y - max) * 2;
    sheet.style.transform = `translateY(${y}px)`;
    d.samples.push([performance.now(), e.clientY]);
    if (d.samples.length > 5) d.samples.shift();
  };
  const up = e => {
    if (!d || e.pointerId !== d.id) return;
    const dd = d; d = null;
    if (!dd.moved) { setSnap(snap === 'peek' ? 'half' : 'peek'); return; }
    const [t0, y0] = dd.samples[0], [t1, y1] = dd.samples[dd.samples.length - 1];
    const v = (y1 - y0) / Math.max(1, t1 - t0); // px/ms, positive = down
    const y = dd.start + (e.clientY - dd.y0) + v * 180; // project the fling
    const H = sheet.offsetHeight;
    const best = ['peek', 'half', 'full'].map(n => [n, Math.abs(H - snapHeight(n) - y)]).sort((a, b) => a[1] - b[1])[0][0];
    if (best === 'peek' && state.sel) { closeDetail(); return; }
    setSnap(best);
  };
  for (const el of [sheet.querySelector('.grab'), $('sheet-top')]) {
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}

// Keep the selection visible above the sheet.
function revealAbove(wx, wy) {
  const x = sx(wx), y = sy(wy);
  const top = 70, bottom = state.H - (isPhone() ? snapHeight('half') : 0) - 30;
  const left = isPhone() ? 24 : 400, right = state.W - 24;
  if (y > top && y < bottom && x > left && x < right) return;
  const cx = isPhone() ? state.W / 2 : (400 + state.W) / 2, cy = (top + bottom) / 2;
  flyTo({ s: state.cam.s, x: wx - (cx - state.W / 2) / state.cam.s, y: wy - (cy - state.H / 2) / state.cam.s }, 650);
}

function flyToStation(s) {
  const k = Math.max(state.cam.s, refFit() * 2.8);
  const cx = isPhone() ? state.W / 2 : (400 + state.W) / 2;
  const cy = isPhone() ? (70 + state.H - snapHeight('half')) / 2 : state.H / 2;
  flyTo({ s: k, x: s.wx - (cx - state.W / 2) / k, y: s.wy - (cy - state.H / 2) / k }, 650);
}

function select(sel, { fly = false } = {}) {
  state.sel = sel;
  state.q = ''; $('q').value = ''; $('q').blur();
  if (sel?.type === 'line') state.focus = sel.id;
  else if (sel) state.focus = null;
  if (sel?.type === 'station') {
    const s = model.stations.get(sel.id);
    loadStation(sel.id);
    fly ? flyToStation(s) : revealAbove(s.wx, s.wy);
  }
  if (sel?.type === 'train') { const tr = state.trains.get(sel.id); const p = tr && worldPos(tr, now()); if (p) revealAbove(p.x, p.y); }
  if (sel && isPhone()) setSnap('half');
  sheetBody.scrollTop = 0;
  renderSheet();
}
function closeDetail() {
  state.sel = null; state.focus = null;
  if (isPhone()) setSnap('peek');
  renderSheet();
}

// Search -------------------------------------------------------------------

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/\bst\.?\b/g, 'st').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const searchIndex = [...model.stations.values()]
  .filter(s => !s.siblings.some(o => o < s.id && model.stations.get(o).name === s.name)) // one row per station name
  .map(s => ({ s, n: norm(s.name) }));
function searchStations(q) {
  const n = norm(q);
  if (!n) return [];
  return searchIndex
    .map(e => {
      const score = e.n === n ? 0 : e.n.startsWith(n) ? 1 : e.n.split(' ').some(w => w.startsWith(n)) ? 2 : e.n.includes(n) ? 3 : 9;
      return { ...e, score };
    })
    .filter(e => e.score < 9)
    .sort((a, b) => a.score - b.score || b.s.lines.length - a.s.lines.length || a.s.name.localeCompare(b.s.name))
    .slice(0, 12);
}
const q = $('q');
// Open the sheet *before* the field takes focus, so the search box is already
// near the top and iOS has no reason to scroll the page for the keyboard.
document.querySelector('.search').addEventListener('pointerdown', e => {
  if (!isPhone() || snap === 'full') return;
  e.preventDefault();
  setSnap('full', false);
  q.focus({ preventScroll: true }); // same user gesture, so iOS still shows the keyboard
});
q.addEventListener('focus', () => { if (isPhone() && snap !== 'full') setSnap('full'); });
// iOS may still nudge the document when the keyboard appears; keep it pinned.
addEventListener('scroll', () => { if (scrollY || scrollX) scrollTo(0, 0); });
visualViewport?.addEventListener('resize', () => { if (scrollY) scrollTo(0, 0); });
q.addEventListener('input', () => { state.q = q.value; sheetBody.scrollTop = 0; renderSheet(); });
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const r = searchStations(q.value)[0]; if (r) select({ type: 'station', id: r.s.id }, { fly: true }); }
});
$('live').onclick = () => { if (state.sel) closeDetail(); if (isPhone()) setSnap('half'); };

// Rendering the sheet ---------------------------------------------------------

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = id => { const l = model.lineById.get(id); return `<span class="chip"><i style="background:${l.c}"></i>${esc(l.name)}</span>`; };
const minsHTML = ms => {
  const s = ms / 1000;
  if (s < 30) return '<span class="min due">Due</span>';
  return `<span class="min">${Math.max(1, Math.round(s / 60))}<small>min</small></span>`;
};
const closeBtn = '<button class="close" data-act="close" aria-label="Close"><svg viewBox="0 0 16 16" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>';
const eyeOn = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.5"/></svg>';
const eyeOff = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><path d="M3.5 16.5l13-13"/></svg>';

function severityClass(statuses) {
  if (!statuses?.length) return '';
  const worst = Math.min(...statuses.map(s => (s.severity === 20 ? 1 : s.severity === 18 || s.severity === 19 ? 10 : s.severity)));
  return worst >= 10 ? '' : worst >= 7 ? 'warn' : 'bad';
}

let stationData = null;
async function loadStation(id) {
  const s = model.stations.get(id);
  if (stationData?.id !== id) stationData = { id, loading: true, arrivals: [] };
  try {
    const d = await data.station([id, ...s.siblings]);
    if (state.sel?.id !== id) return;
    stationData = { id, arrivals: d.arrivals, at: Date.now() };
  } catch {
    stationData = { id, error: true, arrivals: [] };
  }
  renderSheet();
}

let lastSheetHTML = '';
function renderSheet() {
  const view = state.q ? 'search' : state.sel ? state.sel.type : 'home';
  const html = view === 'search' ? searchHTML(state.q)
    : view === 'station' ? stationHTML(model.stations.get(state.sel.id))
    : view === 'train' ? trainHTML(state.trains.get(state.sel.id))
    : view === 'line' ? lineHTML(model.lineById.get(state.sel.id))
    : homeHTML();
  // Only touch the DOM when the content actually changed (re-rendered every second).
  if (html !== lastSheetHTML) { sheetBody.innerHTML = html; lastSheetHTML = html; }
}
const renderLegend = renderSheet, renderPanel = renderSheet; // old names used above

function homeHTML() {
  const disrupted = model.lines.filter(l => severityClass(state.status.get(l.id)));
  const worst = disrupted.some(l => severityClass(state.status.get(l.id)) === 'bad') ? 'bad' : disrupted.length ? 'warn' : '';
  let html = '';
  if (state.status.size) {
    html += `<div class="summary ${worst}"><i class="dot"></i><div>${disrupted.length
      ? `<b>${disrupted.map(l => esc(l.name)).join(', ')}</b><span class="muted">${esc(disrupted.map(l => state.status.get(l.id)[0].text).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}</span>`
      : '<b>Good service</b><span class="muted">on all Underground lines</span>'}</div></div>`;
  }
  html += '<div class="label">Lines</div><div class="rows">';
  for (const l of model.lines) {
    const st = state.status.get(l.id), cls = severityClass(st), n = state.trainCounts[l.id];
    const off = state.hidden.has(l.id);
    html += `<div class="row ${off ? 'off' : ''}" data-line="${l.id}" role="button" tabindex="0">
      <span class="sw" style="background:${l.c}"></span>
      <span class="main"><div class="name">${esc(l.name)}</div><div class="meta ${cls}">${esc(st?.[0]?.text || 'Status loading')}${n ? ` · ${n} trains` : ''}</div></span>
      <button class="eye" data-eye="${l.id}" aria-label="${off ? 'Show' : 'Hide'} ${esc(l.name)}">${off ? eyeOff : eyeOn}</button>
    </div>`;
  }
  html += '</div><p class="foot">Train positions are estimated between stations from TfL’s live arrival predictions; they are not GPS. Data: TfL Open Data.</p>';
  return html;
}

function searchHTML(qs) {
  const res = searchStations(qs);
  if (!res.length) return `<p class="empty">No station matches “${esc(qs)}”.</p>`;
  return '<div class="rows">' + res.map(({ s }) => {
    const lines = [...new Set([s, ...s.siblings.map(id => model.stations.get(id))].flatMap(x => x.lines))];
    return `<button class="row" data-station="${s.id}"><span class="main"><div class="name">${esc(s.name)}</div><div class="dots">${lines.map(id => `<i style="background:${model.lineById.get(id).c}"></i>`).join('')}</div></span></button>`;
  }).join('') + '</div>';
}

function stationHTML(s) {
  const lines = [...new Set([s, ...s.siblings.map(id => model.stations.get(id))].flatMap(x => x.lines))];
  let html = `<div class="head"><div class="t"><h2>${esc(s.name)}</h2><div class="sub">${lines.map(chip).join('')}${s.zone ? `<span>Zone ${esc(s.zone)}</span>` : ''}</div></div>${closeBtn}</div>`;
  for (const id of lines) {
    const st = state.status.get(id), cls = severityClass(st);
    if (cls) html += `<div class="alert ${cls === 'bad' ? 'bad' : ''}"><b>${esc(model.lineById.get(id).name)}:</b> ${esc(st[0].text)}</div>`;
  }
  if (!stationData || stationData.id !== s.id || stationData.loading) return html + '<p class="empty">Loading departures…</p>';
  if (stationData.error) return html + '<p class="empty">Departures are unavailable right now.</p>';
  const t = now();
  const groups = new Map();
  for (const a of stationData.arrivals) {
    if (a.t < t - 30_000) continue;
    const dir = (a.platform || '').replace(/\s*-\s*Platform.*$/i, '').replace(/^(\w)(\w*)bound/i, (m, a1, b1) => a1.toUpperCase() + b1.toLowerCase() + 'bound') || 'Platform';
    const k = `${a.line}|${dir}`;
    if (!groups.has(k)) groups.set(k, { line: a.line, dir, list: [] });
    const g = groups.get(k);
    if (!g.list.some(x => x.vehicleId && x.vehicleId === a.vehicleId && Math.abs(x.t - a.t) < 60_000)) g.list.push(a);
  }
  if (!groups.size) return html + '<p class="empty">No trains expected in the next half hour.</p>';
  const order = [...groups.values()].sort((a, b) => model.lineById.get(a.line).order - model.lineById.get(b.line).order || a.dir.localeCompare(b.dir));
  for (const g of order) {
    const l = model.lineById.get(g.line);
    html += `<section class="board"><header><i style="background:${l.c}"></i>${esc(l.name)} · ${esc(g.dir)}</header>`;
    for (const a of g.list.slice(0, 3)) {
      const to = /check front/i.test(a.destination || '') || !a.destination ? 'Check front of train' : a.destination;
      html += `<div class="dep"><span class="to">${esc(to)}</span>${minsHTML(a.t - t)}</div>`;
    }
    html += '</section>';
  }
  return html + `<p class="foot">Live departures from TfL · updated ${fmtAgo(Math.round((Date.now() - stationData.at) / 1000))}</p>`;
}

function trainHTML(tr) {
  if (!tr || !tr.raw) return `<div class="head"><div class="t"><h2>Train</h2></div>${closeBtn}</div><p class="empty">This train is no longer being reported.</p>`;
  const r = tr.raw, l = model.lineById.get(r.line), t = now();
  const loc = locate(tr.pts, t);
  const S = id => model.stations.get(id)?.name || id;
  const upcoming = tr.pts.filter((p, i) => (i > 0 || !r.from) && p.arr !== -Infinity && p.arr > t - 20_000);
  const next = upcoming[0];
  const dir = (r.platform || '').match(/^(\w+bound)/i)?.[1];
  const age = Math.round((t - r.observedAt) / 1000);
  const where = loc && !loc.moving ? `At ${esc(S(loc.a))}` : loc ? `${esc(S(loc.a))} → ${esc(S(loc.b))}` : '—';
  let html = `<div class="head"><div class="t"><h2>${r.destinationName ? esc(r.destinationName) : esc(l.name)}</h2>
    <div class="sub">${chip(l.id)}${dir ? `<span>${esc(dir[0].toUpperCase() + dir.slice(1).toLowerCase())}</span>` : ''}<span>Train ${esc(r.vehicleId)}</span></div></div>${closeBtn}</div>
    <div class="now"><div class="k">NOW · ESTIMATED</div><div class="v">${where}</div>
    ${next ? `<div class="n">Next: ${esc(S(next.s))} · ${next.arr - t < 30_000 ? 'due' : Math.max(1, Math.round((next.arr - t) / 60000)) + ' min'}</div>` : ''}</div>`;
  if (upcoming.length) {
    html += `<div class="label">Next stops</div><ul class="stops" style="--c:${l.c}">`;
    for (const p of upcoming.slice(0, 10)) html += `<li><span>${esc(S(p.s))}</span><span>${p.arr - t < 30_000 ? 'due' : new Date(p.arr - state.clockOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>`;
    html += '</ul>';
  }
  html += `<p class="foot">TfL last reported “${esc(r.location || 'no location')}” ${fmtAgo(age)}. The position between stations is interpolated from arrival predictions.${tr.uncertain ? ' The previous station is unknown, so the train is shown at its next stop (hollow marker).' : ''}</p>`;
  return html;
}

function lineHTML(l) {
  const st = state.status.get(l.id) || [];
  const n = state.trainCounts[l.id] || 0;
  let html = `<div class="head"><div class="t"><h2>${esc(l.name)}</h2><div class="sub">${chip(l.id)}<span>${n} trains running</span><span>${l.adj.size} stations</span></div></div>${closeBtn}</div>`;
  for (const s of st) {
    const cls = severityClass([s]);
    html += cls ? `<div class="alert ${cls === 'bad' ? 'bad' : ''}"><b>${esc(s.text)}</b>${s.reason ? `<br>${esc(s.reason.replace(/^[^:]+:\s*/, ''))}` : ''}</div>`
      : `<div class="summary"><i class="dot"></i><div><b>${esc(s.text)}</b></div></div>`;
  }
  // Stations in route order (longest route first, then any branch stations).
  const order = [];
  for (const r of [...l.routes].sort((a, b) => b.length - a.length)) for (const id of r) if (!order.includes(id) && model.stations.has(id)) order.push(id);
  html += `<div class="label">Stations</div><ul class="stops" style="--c:${l.c}">` + order.map(id => `<li data-station="${id}" role="button"><span>${esc(model.stations.get(id).name)}</span><span></span></li>`).join('') + '</ul>';
  return html;
}

sheetBody.addEventListener('click', e => {
  const eye = e.target.closest('[data-eye]');
  if (eye) {
    e.stopPropagation();
    const id = eye.dataset.eye;
    state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
    renderSheet(); return;
  }
  if (e.target.closest('[data-act="close"]')) { closeDetail(); return; }
  const st = e.target.closest('[data-station]');
  if (st) { select({ type: 'station', id: st.dataset.station }, { fly: true }); return; }
  const row = e.target.closest('[data-line]');
  if (row) { state.hidden.delete(row.dataset.line); select({ type: 'line', id: row.dataset.line }); }
});

// Live countdowns
setInterval(() => {
  updateLive();
  if (state.sel && !state.q) renderSheet();
}, 1000);
setInterval(() => { if (state.sel?.type === 'station') loadStation(state.sel.id); }, 20_000);

// ---------------------------------------------------------------------------
// Boot

resize();
readTheme();
state.cam = fitCam();
state.fitScale = state.cam.s;
// Portrait phones: the whole network is tiny, so open on central London
// (the fit button still shows everything).
renderSheet();
setSnap('peek', false);
netBounds = bounds();
if (isPhone() && state.H > state.W) {
  const a = model.stations.get('940GZZLUOXC'), b = model.stations.get('940GZZLUBNK');
  const k = refFit() * 1.2;
  // Centre zone 1 in the part of the screen not covered by the sheet.
  if (a && b) state.cam = { x: (a.wx + b.wx) / 2, y: (a.wy + b.wy) / 2 + (snapHeight('peek') / 2) / k, s: k };
}
requestAnimationFrame(frame);
pollTrains(); pollStatus();
setInterval(pollTrains, 15_000);
setInterval(pollStatus, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollTrains(); pollStatus(); } });
// Stop iOS Safari from zooming the whole page on pinch / double-tap.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault());
// Home-screen app: cache the shell so it opens instantly (needs HTTPS or localhost).
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
// Local development only: inspection handle for testing.
if (location.hostname === 'localhost') window.__tube = { state, model, select, get trainScreen() { return trainScreen; } };
