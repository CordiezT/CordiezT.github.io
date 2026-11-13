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
  state.colors = { bg: cs.getPropertyValue('--bg').trim(), fg: cs.getPropertyValue('--fg').trim(), dim: cs.getPropertyValue('--dim').trim() };
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
  const mobile = state.W < 640;
  // Leave room for the legend on the left (desktop) / bottom (mobile).
  const padL = mobile ? 20 : 230, padR = mobile ? 20 : 40, padT = mobile ? 80 : 70, padB = mobile ? 80 : 50;
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
  else if (age > 120) txt.textContent = `${n} trains · data delayed, last ${fmtAgo(age)}`;
  else txt.textContent = `${n} trains · updated ${fmtAgo(age)}`;
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
    $('panel').hidden ? 0 : $('panel').offsetHeight, document.body.classList.contains('lines-open')].join('|');
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
  const corner = Math.max(4, lw * 3);
  for (const l of model.lines) {
    const a = lineAlpha(l.id);
    if (!a) continue;
    g.globalAlpha = a; g.strokeStyle = l.c; g.lineWidth = lw;
    g.beginPath();
    for (const ch of l.chains) {
      const pts = ch.map(id => P(l.id, id, gap));
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

  drawLabels(lctx, onScreen);
  baseCam = { ...state.cam };
  baseDirty = false;
}

function visibleStation(s) { return s.lines.some(id => !state.hidden.has(id)); }

function drawLabels(g, hits) {
  const z = state.cam.s / refFit();
  const small = state.W < 640;
  const fs = small ? 11 : Math.round(Math.min(13, 10.5 + Math.max(0, z - 1) * 0.5));
  const pad = small ? 5 : 2;
  const font = `500 ${fs}px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Helvetica Neue", Arial, sans-serif`;
  // Keep labels clear of the floating UI.
  const placed = [...document.querySelectorAll('.hud > *, .panel:not([hidden]), body.lines-open .legend')].map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 };
  }).filter(r => r.w > 8 && r.h > 8);
  const selSt = state.sel?.type === 'station' ? model.stations.get(state.sel.id) : null;
  const cands = [];
  for (const h of hits) {
    const s = h.s, n = s.lines.length;
    let pri = n * 10 + (s.terminal ? 12 : 0) + (s.interchange ? 6 : 0);
    let show = z > 2.4 || (z > 1.5 && (s.interchange || s.terminal)) || n >= 3 || (s.terminal && z > 1.15);
    if (state.focus && s.lines.includes(state.focus)) { show = show || z > 1.2; pri += 30; }
    if (selSt === s || state.hover?.s === s) { show = true; pri = 1000; }
    if (show) cands.push({ h, pri });
  }
  cands.sort((a, b) => b.pri - a.pri);
  g.font = font; g.textBaseline = 'middle'; g.textAlign = 'left'; g.lineJoin = 'round';
  // Spatial grid for collision tests.
  const CELL = 64, grid = new Map();
  const cellsOf = r => { const out = []; for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) out.push(cx + ',' + cy); return out; };
  const add = r => { for (const c of cellsOf(r)) (grid.get(c) || grid.set(c, []).get(c)).push(r); };
  const hitsAny = r => cellsOf(r).some(c => (grid.get(c) || []).some(p => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y));
  placed.forEach(add);
  for (const { h, pri } of cands) {
    const w = measure(g, h.s.name, font), hgt = fs + 2, off = h.r + 3;
    const opts = [[h.x + off, h.y - hgt / 2], [h.x - off - w, h.y - hgt / 2], [h.x - w / 2, h.y - off - hgt], [h.x - w / 2, h.y + off]]
      .map(([x, y]) => ({ x: x - pad, y: y - pad, w: w + pad * 2, h: hgt + pad * 2 }));
    const r = opts.find(o => !hitsAny(o)) || (pri >= 1000 ? opts[0] : null);
    if (!r) continue;
    add(r);
    g.globalAlpha = Math.max(0.25, Math.max(...h.s.lines.map(lineAlpha)));
    g.lineWidth = 3.5; g.strokeStyle = state.colors.bg; g.fillStyle = state.colors.fg;
    g.strokeText(h.s.name, r.x + pad, r.y + pad + hgt / 2);
    g.fillText(h.s.name, r.x + pad, r.y + pad + hgt / 2);
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
  // Idle: trains move slowly, 30 fps is plenty and saves battery.
  if (!rerender && !moving && !state.morph && tms - lastDraw < 32) return;
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
    trainScreen.push({ tr, x, y });
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
    // nose
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
    if (pointers.size === 1) startPan([...pointers.values()][0], true);
    else if (pointers.size === 0) gesture = null;
    return;
  }
  if (pointers.size > 0) return;
  const g = gesture; gesture = null;
  const tnow = performance.now();
  if (!g.moved && tnow - g.t0 < 450) {
    if (touchInput && lastTap && tnow - lastTap.t < 320 && Math.hypot(lastTap.x - e.clientX, lastTap.y - e.clientY) < 30) {
      lastTap = null;
      zoomTo(e.clientX, e.clientY, 2.2);
      return;
    }
    lastTap = { t: tnow, x: e.clientX, y: e.clientY };
    clickAt(e.clientX, e.clientY);
    return;
  }
  if (g.moved && samples.length > 1) {
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

function pick(x, y) {
  const { gap } = sizes();
  let train = null, td = Infinity, station = null, sd = Infinity;
  for (const h of trainScreen) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < (touchInput ? 20 : 11) && d < td) { td = d; train = { type: 'train', tr: h.tr }; }
  }
  for (const h of stationHits) {
    const d = Math.hypot(sx(h.s.wx) + h.ox * gap - x, sy(h.s.wy) + h.oy * gap - y);
    if (d < Math.max(touchInput ? 16 : 9, h.r) && d < sd) { sd = d; station = { type: 'station', s: h.s }; }
  }
  // Trains sitting in a station shouldn't make the station unclickable.
  if (train && station) return td < (touchInput ? 8 : 4) && td < sd ? train : station;
  return train || station;
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
  if (document.body.classList.contains('lines-open')) { setLinesOpen(false); return; }
  const p = pick(x, y);
  if (!p) { if (state.sel) select(null); else if (state.focus) { state.focus = null; renderLegend(); } return; }
  if (p.type === 'train') select({ type: 'train', id: p.tr.id });
  else select({ type: 'station', id: p.s.id });
}

// On phones the info sheet covers the bottom half: glide the selection into
// the visible area above it.
function revealAbove(wx, wy) {
  if (state.W >= 640) return;
  const y = sy(wy), x = sx(wx), targetY = state.H * 0.3;
  if (y > 60 && y < state.H * 0.45 && x > 20 && x < state.W - 20) return;
  flyTo({ s: state.cam.s, x: wx - (state.W / 2 - state.W / 2) / state.cam.s, y: wy - (targetY - state.H / 2) / state.cam.s }, 450);
}

function select(sel) {
  state.sel = sel;
  if (sel) setLinesOpen(false);
  if (sel?.type === 'station') { const s = model.stations.get(sel.id); revealAbove(s.wx, s.wy); }
  if (sel?.type === 'train') { const tr = state.trains.get(sel.id); const p = tr && worldPos(tr, now()); if (p) revealAbove(p.x, p.y); }
  if (sel?.type === 'station') loadStation(sel.id);
  renderPanel();
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
document.querySelectorAll('[data-layout]').forEach(btn => btn.onclick = () => setLayout(btn.dataset.layout));
$('layout-btn').onclick = () => setLayout(model.layout === 'geo' ? 'schematic' : 'geo');
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.sel) select(null); else { state.focus = null; renderLegend(); } }
});
addEventListener('resize', () => { resize(); state.fitScale = fitCam().s; invalidate(); });

// Mobile: the lines list lives in a sheet behind a "Lines" button.
function setLinesOpen(open) {
  document.body.classList.toggle('lines-open', open);
  $('lines-btn').setAttribute('aria-expanded', open);
}
$('lines-btn').onclick = () => { const open = !document.body.classList.contains('lines-open'); if (open) select(null); setLinesOpen(open); };

// Mobile: drag the info sheet down to dismiss it.
{
  const panel = $('panel');
  let drag = null;
  panel.addEventListener('pointerdown', e => {
    if (state.W >= 640 || e.target.closest('button, a')) return;
    const top = panel.getBoundingClientRect().top;
    if (e.clientY - top > 56 && panel.scrollTop > 0) return; // let the list scroll
    if (e.clientY - top > 56) return;
    drag = { y0: e.clientY, id: e.pointerId };
    try { panel.setPointerCapture(e.pointerId); } catch {}
    panel.style.transition = 'none';
  });
  panel.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    panel.style.transform = `translateY(${Math.max(0, e.clientY - drag.y0)}px)`;
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0; drag = null;
    panel.style.transition = 'transform .2s ease';
    if (dy > 70) {
      panel.style.transform = 'translateY(110%)';
      setTimeout(() => { panel.style.transform = ''; panel.style.transition = ''; if (state.sel?.type === 'line') { state.focus = null; renderLegend(); } select(null); }, 180);
    } else panel.style.transform = '';
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Legend

function severityClass(statuses) {
  if (!statuses?.length) return '';
  const worst = Math.min(...statuses.map(s => (s.severity === 20 ? 1 : s.severity === 18 || s.severity === 19 ? 10 : s.severity)));
  return worst >= 10 ? '' : worst >= 7 ? 'warn' : 'bad';
}

function renderLegend() {
  const el = $('legend');
  if (!el) return;
  const rows = model.lines.map(l => {
    const st = state.status.get(l.id);
    return `<div class="row ${state.focus === l.id ? 'active' : ''} ${state.hidden.has(l.id) ? 'off' : ''}" data-line="${l.id}" role="button" tabindex="0" title="${esc(st?.map(s => s.text).join(', ') || l.name)}">
      <span class="sw" style="background:${l.c}"></span>
      <span class="nm">${l.name}</span>
      <span class="st ${severityClass(st)}"></span>
      <span class="ct">${state.trainCounts[l.id] ?? ''}</span>
      <span class="eye" data-eye="${l.id}" title="${state.hidden.has(l.id) ? 'Show' : 'Hide'} line">${state.hidden.has(l.id) ? eyeOff : eyeOn}</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="hd"><span>Lines</span><button id="allon">${state.hidden.size ? 'Show all' : state.focus ? 'Clear' : ''}</button></div>${rows}`;
  // Compact mobile button: colour stripes + count of disrupted lines.
  const btn = $('lines-btn');
  if (btn) {
    const disrupted = model.lines.filter(l => severityClass(state.status.get(l.id))).length;
    const focus = state.focus && model.lineById.get(state.focus);
    btn.innerHTML = `<span class="stripes">${model.lines.map(l => `<i style="background:${l.c};opacity:${state.hidden.has(l.id) ? 0.25 : 1}"></i>`).join('')}</span>`
      + `<span>${focus ? esc(focus.name) : 'Lines'}</span>`
      + (disrupted ? `<span class="badge">${disrupted} disrupted</span>` : '');
  }
}
const eyeOn = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const eyeOff = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>';

$('legend').addEventListener('click', e => {
  if (e.target.closest('#allon')) { state.hidden.clear(); state.focus = null; renderLegend(); return; }
  const eye = e.target.closest('[data-eye]');
  if (eye) {
    const id = eye.dataset.eye;
    state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
    if (state.focus === id) state.focus = null;
    renderLegend(); return;
  }
  const row = e.target.closest('[data-line]');
  if (!row) return;
  const id = row.dataset.line;
  state.hidden.delete(id);
  if (state.focus === id) { state.focus = null; if (state.sel?.type === 'line') select(null); }
  else { state.focus = id; select({ type: 'line', id }); }
  renderLegend();
});

// ---------------------------------------------------------------------------
// Panels

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pill = id => { const l = model.lineById.get(id); return `<span class="pill"><i style="background:${l.c}"></i>${l.name}</span>`; };
const mins = ms => { const s = ms / 1000; return s < 30 ? '<span class="due">due</span>' : s < 90 ? '1 min' : `${Math.round(s / 60)} min`; };

let stationData = null;
async function loadStation(id) {
  const s = model.stations.get(id);
  const ids = [id, ...s.siblings];
  stationData = { id, loading: true, arrivals: [] };
  try {
    const d = await data.station(ids);
    if (state.sel?.id !== id) return;
    stationData = { id, arrivals: d.arrivals, at: Date.now() };
  } catch {
    stationData = { id, error: true, arrivals: [] };
  }
  renderPanel();
}

let lastPanelHTML = '';
function renderPanel() {
  const panel = $('panel'), body = $('panel-body');
  const sel = state.sel;
  if (!sel) { panel.hidden = true; lastPanelHTML = ''; return; }
  const html = sel.type === 'station' ? stationHTML(model.stations.get(sel.id))
    : sel.type === 'train' ? trainHTML(state.trains.get(sel.id))
    : lineHTML(model.lineById.get(sel.id));
  // Only touch the DOM when the content actually changed (it re-renders every second).
  if (html !== lastPanelHTML) { body.innerHTML = html; lastPanelHTML = html; }
  panel.hidden = false;
}
$('panel-close').onclick = () => { if (state.sel?.type === 'line') { state.focus = null; renderLegend(); } select(null); };

function stationHTML(s) {
  const lines = [...new Set([s, ...s.siblings.map(id => model.stations.get(id))].flatMap(x => x.lines))];
  let html = `<h2>${esc(s.name)}</h2><div class="sub">${lines.map(pill).join('')}${s.zone ? `<span class="muted">Zone ${esc(s.zone)}</span>` : ''}</div>`;
  for (const id of lines) {
    const st = state.status.get(id);
    if (severityClass(st)) html += `<div class="status ${severityClass(st)}"><b>${model.lineById.get(id).name}:</b> ${esc(st[0].text)}</div>`;
  }
  if (!stationData || stationData.id !== s.id || stationData.loading) return html + '<p class="muted">Loading arrivals…</p>';
  if (stationData.error) return html + '<p class="muted">Arrivals unavailable right now.</p>';
  const t = now();
  const groups = new Map();
  for (const a of stationData.arrivals) {
    if (a.t < t - 30_000) continue;
    const dir = (a.platform || '').replace(/\s*-\s*Platform.*$/i, '').replace(/^(\w)(\w*)bound/i, (m, a1, b1) => a1.toUpperCase() + b1.toLowerCase() + 'bound') || 'Platform';
    const k = `${a.line}|${dir}`;
    if (!groups.has(k)) groups.set(k, { line: a.line, dir, list: [] });
    const g = groups.get(k);
    if (!g.list.some(x => x.vehicleId === a.vehicleId && a.vehicleId && Math.abs(x.t - a.t) < 60_000)) g.list.push(a);
  }
  if (!groups.size) return html + '<p class="muted">No trains predicted in the next half hour.</p>';
  const order = [...groups.values()].sort((a, b) => model.lineById.get(a.line).order - model.lineById.get(b.line).order || a.dir.localeCompare(b.dir));
  for (const g of order) {
    const l = model.lineById.get(g.line);
    html += `<h3><i style="background:${l.c}"></i>${l.name} · ${esc(g.dir)}</h3><div class="arr">`;
    for (const a of g.list.slice(0, 3)) html += `<div class="d">${esc(/check front/i.test(a.destination || '') || !a.destination ? 'Check front of train' : a.destination)}</div><div class="t">${mins(a.t - t)}</div>`;
    html += '</div>';
  }
  return html + `<div class="disclaimer">Live predictions from TfL. Updated ${fmtAgo(Math.round((Date.now() - stationData.at) / 1000))}.</div>`;
}

function trainHTML(tr) {
  if (!tr || !tr.raw) return '<h2>Train</h2><p class="muted">This train is no longer being reported.</p>';
  const r = tr.raw, l = model.lineById.get(r.line), t = now();
  const loc = locate(tr.pts, t);
  const S = id => model.stations.get(id)?.name || id;
  const upcoming = tr.pts.filter((p, i) => i > 0 || !r.from).filter(p => p.arr === -Infinity ? false : p.arr > t - 20_000);
  const next = upcoming[0];
  const dir = (r.platform || '').match(/^(\w+bound)/i)?.[1];
  const age = Math.round((t - r.observedAt) / 1000);
  let html = `<h2 style="color:${l.c}">${esc(l.name)}</h2>
    <div class="sub">${r.destinationName ? `to <b style="color:var(--fg);font-weight:500">${esc(r.destinationName)}</b>` : 'Destination not given'}${dir ? ` · ${esc(dir[0].toUpperCase() + dir.slice(1).toLowerCase())}` : ''}</div>
    <dl class="kv">
      <dt>Train</dt><dd>Set ${esc(r.vehicleId)}</dd>
      <dt>Now</dt><dd>${loc && !loc.moving ? `At ${esc(S(loc.a))}` : loc ? `Between ${esc(S(loc.a))} and ${esc(S(loc.b))}` : '—'} <span class="muted">(est.)</span></dd>
      <dt>TfL says</dt><dd>${esc(r.location || '—')} <span class="muted">${fmtAgo(age)}</span></dd>
      ${next ? `<dt>Next</dt><dd>${esc(S(next.s))} · ${mins(next.arr - t)}</dd>` : ''}
    </dl>`;
  if (upcoming.length) {
    html += `<h3>Upcoming</h3><ul class="stops" style="--c:${l.c}">`;
    for (const p of upcoming.slice(0, 8)) html += `<li><span>${esc(S(p.s))}</span><span>${p.arr - t < 30_000 ? 'due' : new Date(p.arr - state.clockOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>`;
    html += '</ul>';
  }
  html += `<div class="disclaimer">Position is interpolated between stations from TfL arrival predictions, not measured. ${tr.uncertain ? 'The previous station is unknown, so this train is shown at its next stop (hollow marker).' : ''}</div>`;
  return html;
}

function lineHTML(l) {
  const st = state.status.get(l.id) || [];
  const n = state.trainCounts[l.id] || 0;
  let html = `<h2 style="color:${l.c}">${esc(l.name)}</h2><div class="sub">${n} trains reported · ${l.adj.size} stations</div>`;
  if (!st.length) html += '<p class="muted">Status loading…</p>';
  for (const s of st) {
    const cls = severityClass([s]);
    html += cls ? `<div class="status ${cls}"><b>${esc(s.text)}</b>${s.reason ? `<br>${esc(s.reason.replace(/^[^:]+:\s*/, ''))}` : ''}</div>` : `<p>${esc(s.text)}</p>`;
  }
  const others = model.lines.filter(o => o.id !== l.id && severityClass(state.status.get(o.id)));
  if (others.length) html += `<h3>Elsewhere</h3>` + others.map(o => `<div class="muted" style="margin:2px 0">${pill(o.id)} ${esc(state.status.get(o.id)[0].text)}</div>`).join('');
  return html;
}

// Live countdowns
setInterval(() => {
  updateLive();
  if (state.sel) renderPanel();
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
if (state.W < 640 && state.H > state.W) {
  const a = model.stations.get('940GZZLUOXC'), b = model.stations.get('940GZZLUBNK');
  if (a && b) state.cam = { x: (a.wx + b.wx) / 2, y: (a.wy + b.wy) / 2, s: state.fitScale * 2.6 };
}
renderLegend();
requestAnimationFrame(frame);
pollTrains(); pollStatus();
setInterval(pollTrains, 15_000);
setInterval(pollStatus, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollTrains(); pollStatus(); } });
// Stop iOS Safari from zooming the whole page on pinch / double-tap.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault());
// Home-screen app: cache the shell so it opens instantly (needs HTTPS or localhost).
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
