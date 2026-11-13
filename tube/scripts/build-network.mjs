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
import { schematicLayout } from './layout.mjs';

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
  .replace(/ Underground Station$/, '')
  .replace(/-Underground$/, '')
  .replace(/ \([^)]*(Line|Bakerloo)[^)]*\)$/i, '')
  .replace(/^Heathrow Terminals 1-2-3$/, 'Heathrow T1-2-3')
  .trim();

const stations = new Map(); // naptan -> station
const lines = [];

for (const line of LINES) {
  const d = await getJSON(`https://api.tfl.gov.uk/Line/${line.id}/Route/Sequence/all?serviceTypes=Regular&excludeCrowding=true${KEY}`);
  for (const seq of d.stopPointSequences) {
    for (const sp of seq.stopPoint) {
      const id = sp.stationId || sp.id;
      if (!stations.has(id)) {
        stations.set(id, {
          id, name: shortName(sp.name), lat: sp.lat, lon: sp.lon,
          hub: sp.topMostParentId || null, zone: sp.zone || null, lines: new Set(),
        });
      }
      stations.get(id).lines.add(line.id);
    }
  }
  const routes = d.orderedLineRoutes.map(r => r.naptanIds);
  // Unique undirected edges from both ordered routes and branch sequences.
  const edgeSet = new Map();
  const addEdge = (a, b) => { if (a === b) return; const k = a < b ? `${a}|${b}` : `${b}|${a}`; edgeSet.set(k, [a, b]); };
  for (const r of routes) for (let i = 1; i < r.length; i++) addEdge(r[i - 1], r[i]);
  for (const seq of d.stopPointSequences) {
    const ids = seq.stopPoint.map(s => s.stationId || s.id);
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
schematicLayout(list, E);

const round = v => Math.round(v);
const out = {
  generated: new Date().toISOString(),
  source: 'TfL Unified API /Line/{id}/Route/Sequence/all',
  stations: list.map(s => ({
    id: s.id, name: s.name, hub: s.hub, zone: s.zone, lines: [...s.lines],
    lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6),
    x: round(s.x), y: round(s.y), gx: round(s.gx), gy: round(s.gy),
  })).sort((a, b) => a.name.localeCompare(b.name)),
  lines: lines.map(l => ({ id: l.id, name: l.name, color: l.color, edges: l.edges, routes: l.routes })),
};
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`wrote ${out.stations.length} stations, ${E.length} physical edges`);
