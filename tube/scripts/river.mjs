// The Thames, for the optional minimalist background.
// Source: OpenStreetMap (waterway=river, name=River Thames) via Overpass,
// cached in scripts/.cache/thames.json. © OpenStreetMap contributors (ODbL).

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CACHE = new URL('./.cache/thames.json', import.meta.url);
const QUERY = '[out:json][timeout:60];way["waterway"="river"]["name"="River Thames"](51.36,-0.50,51.56,0.30);out geom;';

export async function loadThames(refresh = false) {
  let raw = refresh ? null : await readFile(CACHE, 'utf8').catch(() => null);
  if (!raw) {
    const res = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(QUERY), { headers: { 'User-Agent': 'tube-live-build/1.0' } });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    raw = await res.text();
    await mkdir(new URL('.', CACHE), { recursive: true });
    await writeFile(CACHE, raw);
  }
  const ways = JSON.parse(raw).elements.filter(e => e.geometry?.length > 1).map(e => e.geometry.map(p => [p.lon, p.lat]));
  return stitch(ways);
}

// Treat every way as graph edges between OSM nodes and take the shortest path
// from the westernmost to the easternmost point: one continuous course through
// London (side channels around islands are dropped automatically).
function stitch(ways) {
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const pos = new Map(), adj = new Map();
  const add = (a, b) => {
    const ka = key(a), kb = key(b);
    pos.set(ka, a); pos.set(kb, b);
    const d = Math.hypot((a[0] - b[0]) * 69400, (a[1] - b[1]) * 111320);
    (adj.get(ka) || adj.set(ka, []).get(ka)).push([kb, d]);
    (adj.get(kb) || adj.set(kb, []).get(kb)).push([ka, d]);
  };
  for (const w of ways) for (let i = 1; i < w.length; i++) add(w[i - 1], w[i]);
  const keys = [...pos.keys()];
  const west = keys.reduce((m, k) => (pos.get(k)[0] < pos.get(m)[0] ? k : m));
  const east = keys.reduce((m, k) => (pos.get(k)[0] > pos.get(m)[0] ? k : m));
  // Dijkstra (binary heap)
  const dist = new Map([[west, 0]]), prev = new Map(), heap = [[0, west]];
  const push = x => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, k] = pop();
    if (k === east) break;
    if (d > dist.get(k)) continue;
    for (const [n, w] of adj.get(k)) if (d + w < (dist.get(n) ?? Infinity)) { dist.set(n, d + w); prev.set(n, k); push([d + w, n]); }
  }
  const out = [];
  for (let k = east; k; k = prev.get(k)) out.push(pos.get(k));
  return out.reverse();
}

// Douglas–Peucker in projected metres.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}
