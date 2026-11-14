// Builds public/data/network.json from the TfL Unified API.
// Run: node --env-file-if-exists=.env scripts/build-network.mjs
//
// Produces stations (geo + schematic coordinates), per-line track edges and
// ordered routes. The schematic layout is computed here once, offline:
//   1. equirectangular projection around Charing Cross
//   2. logarithmic radial compression (central London gets room, outskirts shrink)
//   3. octilinear layout (see layout.mjs)

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { LINES } from '../public/shared/lines.mjs';
import { schematicLayout, anchoredLayout } from './layout.mjs';
import { ANCHORS, RIVER, UNIT, PASS_THROUGH, WAYPOINTS } from './anchors.mjs';
import { loadThames, simplify } from './river.mjs';

const KEY = process.env.TFL_APP_KEY ? `&app_key=${process.env.TFL_APP_KEY}` : '';
const OUT = new URL('../public/data/network.json', import.meta.url);

// Raw TfL responses are cached so the layout can be iterated offline.
// Pass --refresh to re-download.
const CACHE = new URL('./.cache/routes.json', import.meta.url);
const cache = process.argv.includes('--refresh') ? {} : JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
async function getJSON(url) {
  const k = url.replace(/&app_key=[^&]*/, '');
  if (!cache[k]) { cache[k] = await fetchJSON(url); await mkdir(new URL('.', CACHE), { recursive: true }); await writeFile(CACHE, JSON.stringify(cache)); }
  return cache[k];
}
async function fetchJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`rate limited: ${url}`);
}

const shortName = n => n
  .replace(/ (Underground|Rail|DLR) Station$/, '')
  .replace(/^London (Liverpool Street|Euston|Paddington|Fenchurch Street|Victoria)$/, '$1')
  .replace(/ \(London\)$/, '')
  .replace(/-Underground$/, '')
  .replace(/ \([^)]*(Line|Bakerloo)[^)]*\)$/i, '')
  .replace(/^Heathrow Terminals 1-2-3$/, 'Heathrow T1-2-3')
  .trim();

const stations = new Map(); // node id -> station
const lines = [];
// Rail, DLR and Tube platforms of the same interchange have different NaPTAN
// codes but share a TfL hub: they become one node on the map. `aliases` maps
// every code to its node so live arrivals can be matched.
const aliases = new Map();
const byHub = new Map();
const metres = (a, b) => Math.hypot((a.lon - b.lon) * 69400, (a.lat - b.lat) * 111320);
const resolve = (sp, mode) => {
  const raw = sp.stationId || sp.id;
  if (stations.has(raw)) return raw;
  if (aliases.has(raw)) return aliases.get(raw);
  const hub = sp.topMostParentId;
  // Only merge across modes: separate Tube stations sharing a hub (the two
  // Paddingtons, the two Hammersmiths) stay separate, as on the Tube map.
  if (hub && mode !== 'tube' && byHub.has(hub)) {
    const near = byHub.get(hub).map(s => [s, metres(s, sp)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] < 700) { aliases.set(raw, near[0].id); return near[0].id; }
  }
  const s = { id: raw, name: shortName(sp.name), lat: sp.lat, lon: sp.lon, hub: hub || null, zone: sp.zone || null, lines: new Set() };
  stations.set(raw, s);
  if (hub) (byHub.get(hub) || byHub.set(hub, []).get(hub)).push(s);
  return raw;
};

for (const line of LINES) {
  const d = await getJSON(`https://api.tfl.gov.uk/Line/${line.id}/Route/Sequence/all?serviceTypes=Regular&excludeCrowding=true${KEY}`);
  for (const seq of d.stopPointSequences) {
    for (const sp of seq.stopPoint) stations.get(resolve(sp, line.mode)).lines.add(line.id);
  }
  const node = id => aliases.get(id) || id;
  const routes = d.orderedLineRoutes.map(r => r.naptanIds.map(node).filter((id, i, a) => i === 0 || a[i - 1] !== id));
  // Unique undirected edges from both ordered routes and branch sequences.
  const edgeSet = new Map();
  const addEdge = (a, b) => { if (a === b) return; const k = a < b ? `${a}|${b}` : `${b}|${a}`; edgeSet.set(k, [a, b]); };
  for (const r of routes) for (let i = 1; i < r.length; i++) addEdge(r[i - 1], r[i]);
  for (const seq of d.stopPointSequences) {
    const ids = seq.stopPoint.map(s => node(s.stationId || s.id));
    for (let i = 1; i < ids.length; i++) addEdge(ids[i - 1], ids[i]);
  }
  lines.push({ ...line, edges: [...edgeSet.values()], routes });
  console.log(`${line.id}: ${edgeSet.size} raw edges, ${routes.length} routes`);
}

// --- Express-only edges ---------------------------------------------------------
// TfL lists a Metropolitan stopping pattern via Willesden Green (shared with the
// Jubilee). The schematic convention is to draw the Met non-stop between
// Finchley Road and Wembley Park, so drop those two Met edges.
const DROP = { metropolitan: [['940GZZLUWYP', '940GZZLUWIG'], ['940GZZLUWIG', '940GZZLUFYR']] };
for (const line of lines) {
  const drop = new Set((DROP[line.id] || []).map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  line.edges = line.edges.filter(([a, b]) => !drop.has(a < b ? `${a}|${b}` : `${b}|${a}`));
}
const dist = (a, b) => {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * k * 111320, (a.lat - b.lat) * 110540);
};

// --- Schematic layout ----------------------------------------------------------
const LAT0 = 51.5074, LON0 = -0.1278; // Charing Cross-ish
const K = Math.cos((LAT0 * Math.PI) / 180);
const R = Number(process.env.LAYOUT_R) || 3500; // compression radius (m): smaller = bigger central London
const list = [...stations.values()];
for (const s of list) {
  const x = (s.lon - LON0) * K * 111320, y = -(s.lat - LAT0) * 110540;
  s.gx = x; s.gy = y;
  const r = Math.hypot(x, y) || 1;
  const rr = R * Math.log1p(r / R);
  s.x = (x / r) * rr; s.y = (y / r) * rr;
  s.ax = s.x; s.ay = s.y;
}

// Unique physical edges across all lines.
const allEdges = new Map();
for (const line of lines) for (const [a, b] of line.edges) {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  allEdges.set(k, [stations.get(a), stations.get(b)]);
}
const E = [...allEdges.values()];
// A line's terminus is a fixed point of the layout even where the network
// itself carries on (e.g. Ealing Broadway: end of the Central and District).
for (const line of lines) {
  const deg = new Map();
  for (const [a, b] of line.edges) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
  for (const [id, d] of deg) if (d === 1) stations.get(id).forceKey = true;
}
// Hand-anchored schematic (see anchors.mjs); `--auto` uses the fully automatic layout.
const useAnchors = !process.argv.includes('--auto');
if (useAnchors) {
  const byKey = new Map();
  for (const s of list) { byKey.set(s.id, s); if (!byKey.has(s.name)) byKey.set(s.name, s); }
  const anchors = new Map();
  for (const [k, [gx, gy]] of Object.entries(ANCHORS)) {
    const s = byKey.get(k);
    if (!s) throw new Error(`anchors: no station "${k}"`);
    anchors.set(s, [gx * UNIT, gy * UNIT]);
  }
  anchoredLayout(list, E, anchors);
} else {
  schematicLayout(list, E);
}

// --- Pass-throughs and waypoints (anchored layout only) -------------------------
const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const findOn = (name, lineId) => {
  const c = list.filter(s => s.name === name);
  return c.find(s => !lineId || s.lines.has(lineId)) || c[0];
};
const via = {};
if (useAnchors) {
  for (const [lineId, from, to, through] of PASS_THROUGH) {
    const l = lines.find(x => x.id === lineId);
    const a = findOn(from, lineId), b = findOn(to, lineId);
    const mids = through.map(n => findOn(n));
    if (!a || !b || mids.some(m => !m)) { console.warn(`pass-through: unknown station in ${lineId} ${from}→${to}`); continue; }
    const k = ekey(a.id, b.id);
    if (!l.edges.some(([x, y]) => ekey(x, y) === k)) { console.warn(`pass-through: ${lineId} has no edge ${from}–${to}`); continue; }
    l.edges = l.edges.filter(([x, y]) => ekey(x, y) !== k);
    const seq = [a, ...mids, b];
    for (let i = 1; i < seq.length; i++) if (!l.edges.some(([x, y]) => ekey(x, y) === ekey(seq[i - 1].id, seq[i].id))) l.edges.push([seq[i - 1].id, seq[i].id]);
  }
  for (const [lineId, from, to, pts] of WAYPOINTS) {
    const a = findOn(from, lineId), b = findOn(to, lineId);
    if (!a || !b) { console.warn(`waypoints: unknown station in ${lineId} ${from}→${to}`); continue; }
    // Stored in the a→b direction of the sorted key, so clients can orient them.
    const [p, q] = a.id < b.id ? [a, b] : [b, a];
    const world = pts.map(([x, y]) => [Math.round(x * UNIT), Math.round(y * UNIT)]);
    (via[lineId] ||= {})[ekey(a.id, b.id)] = p === a ? world : world.reverse();
  }
}

// --- The Thames -------------------------------------------------------------
// Schematic mode: a smooth curve threaded between stations on opposite banks
// (Embankment | Waterloo, Cannon Street | London Bridge, …), so every station
// is on its real bank whatever the layout does. Geographic mode: the real
// course from OpenStreetMap. Both are resampled to the same number of points
// so the app can morph between them.
const byName = new Map(list.map(s => [s.name, s]));
const st = n => { const s = byName.get(n); if (!s) throw new Error(`river: unknown station ${n}`); return s; };
const mid = (n, sth) => ({ x: (st(n).x + st(sth).x) / 2, y: (st(n).y + st(sth).y) / 2 });
const off = (n, dx, dy) => ({ x: st(n).x + dx, y: st(n).y + dy }); // river passes at this offset from a station
const D = 150;
const bankAnchors = [
  off('Richmond', -D, -D),
  mid('Gunnersbury', 'Kew Gardens'),
  off('Hammersmith', 0, D * 1.2),
  mid('Putney Bridge', 'East Putney'),
  off('Battersea Power Station', 0, -D),
  mid('Pimlico', 'Vauxhall'),
  mid('Westminster', 'Lambeth North'),
  mid('Embankment', 'Waterloo'),
  mid('Blackfriars', 'Southwark'),
  mid('Cannon Street', 'London Bridge'),
  mid('Tower Hill', 'Bermondsey'),
  mid('Canary Wharf', 'Canada Water'),
  off('Canary Wharf', 0, D),
  mid('Canary Wharf', 'North Greenwich'),
  mid('Canning Town', 'North Greenwich'),
  off('Barking', D, D * 2),
];
const catmull = (pts, per = 16) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const resample = (pts, n) => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const L = cum[cum.length - 1], out = [];
  for (let k = 0, j = 0; k < n; k++) {
    const d = (k / (n - 1)) * L;
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * t, y: pts[j].y + (pts[j + 1].y - pts[j].y) * t });
  }
  return out;
};
const N = 220;
// Octilinear river with rounded corners (anchored layout), else the spline.
const roundCorners = (pts, r) => {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y), d2 = Math.hypot(n.x - c.x, n.y - c.y), rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: c.x - (c.x - p.x) / d1 * rr, y: c.y - (c.y - p.y) / d1 * rr }, b = { x: c.x + (n.x - c.x) / d2 * rr, y: c.y + (n.y - c.y) / d2 * rr };
    for (let k = 0; k <= 8; k++) { const t = k / 8; out.push({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y }); }
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const schem = useAnchors
  ? resample(roundCorners(RIVER.map(([x, y]) => ({ x: x * UNIT, y: y * UNIT })), UNIT * 1.2), N)
  : resample(catmull(bankAnchors), N);
// Geographic course, trimmed to the same stretch (Richmond → Barking).
const geoAll = (await loadThames(process.argv.includes('--refresh')))
  .map(([lon, lat]) => ({ x: (lon - LON0) * K * 111320, y: -(lat - LAT0) * 110540, lon }))
  .filter(p => p.lon > -0.32 && p.lon < 0.10);
const geo = resample(geoAll, N);
const river = schem.map((p, i) => ({ x: p.x, y: p.y, gx: geo[i].x, gy: geo[i].y }));
console.log(`thames: ${river.length} points (${useAnchors ? 'hand-drawn' : 'bank-threaded'} schematic; geographic from OpenStreetMap)`);
{
  // Every station within 1.5 km of the real river must be on the same bank in the schematic.
  const sideOf = (pts, X, Y, px, py) => {
    let best = Infinity, sgn = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[X] - a[X], dy = b[Y] - a[Y], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - a[X]) * dx + (py - a[Y]) * dy) / L2));
      const d = Math.hypot(px - a[X] - dx * t, py - a[Y] - dy * t);
      if (d < best) { best = d; sgn = Math.sign(dx * (py - a[Y]) - dy * (px - a[X])); }
    }
    return { sgn, d: best };
  };
  const wrong = [], checked = [];
  for (const s of list) {
    const g = sideOf(geoAll, 'x', 'y', s.gx, s.gy);
    if (g.d > 1500) continue;
    checked.push(s.name);
    if (sideOf(river, 'x', 'y', s.x, s.y).sgn !== g.sgn) wrong.push(s.name);
  }
  console.log(`thames: ${checked.length} riverside stations checked; ${wrong.length ? 'WRONG BANK: ' + wrong.join(', ') : 'all on the correct bank'}`);
}

const round = v => Math.round(v);
const out = {
  generated: new Date().toISOString(),
  source: 'TfL Unified API /Line/{id}/Route/Sequence/all',
  stations: list.map(s => ({
    id: s.id, name: s.name, hub: s.hub, zone: s.zone, lines: [...s.lines],
    lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6),
    x: round(s.x), y: round(s.y), gx: round(s.gx), gy: round(s.gy),
  })).sort((a, b) => a.name.localeCompare(b.name)),
  lines: lines.map(l => ({ id: l.id, name: l.name, color: l.color, mode: l.mode, edges: l.edges, routes: l.routes })),
  aliases: Object.fromEntries(aliases),
  via,
  river: river.map(p => [round(p.x), round(p.y), round(p.gx), round(p.gy)]),
  attribution: 'Station and route data: TfL Open Data. River Thames: © OpenStreetMap contributors (ODbL).',
};
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`wrote ${out.stations.length} stations, ${E.length} physical edges`);
