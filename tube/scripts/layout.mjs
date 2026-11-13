// Schematic (octilinear) layout for the Underground network.
//
// Input: stations with `x, y` already set to the radially compressed
// geographic position, and the unique physical edges [stationA, stationB].
// Output: `x, y` rewritten in place.
//
// Approach, in three passes:
//   1. Relax: nudge every edge towards a multiple of 45° while keeping stations
//      apart and loosely anchored to geography. This gives a good rough shape.
//   2. Skeleton: collapse the network into "chains" (runs of stations with no
//      branching) between key nodes (junctions, termini, crossings). Optimise
//      only the key nodes: chains with no stations in between must become
//      exactly octilinear, and every chain must be long enough for its stations.
//   3. Chains: draw each chain as a straight run, an L-shaped route (one
//      diagonal + one horizontal/vertical leg), or a detour when two chains
//      join the same pair of key nodes. A station is placed on every bend, so
//      every drawn segment between consecutive stations is exactly octilinear.

const STEP = Math.PI / 4;
const SPACING = 190; // minimum distance between neighbouring stations
const KEY_MIN = 260; // minimum distance between key nodes

export function schematicLayout(list, edges, { log = true } = {}) {
  for (const s of list) { s.ax = s.x; s.ay = s.y; }
  relax(list, edges, 500);
  for (const s of list) { s.rx = s.x; s.ry = s.y; }
  const chains = buildChains(list, edges);
  const keys = [...new Set(chains.flatMap(c => [c.nodes[0], c.nodes[c.nodes.length - 1]]))];
  skeleton(keys, chains, 900);
  placeChains(chains);
  separate(list, edges, chains);
  if (log) report(list, edges, chains);
  if (process.env.TRACE) for (const s of list) if (s.name.includes(process.env.TRACE)) console.log(s.name, 'anchor', s.ax|0, s.ay|0, 'relaxed', s.rx|0, s.ry|0, 'final', s.x|0, s.y|0);
}

// ---------------------------------------------------------------------------

function snapAngle(dx, dy) {
  const t = Math.round(Math.atan2(dy, dx) / STEP) * STEP;
  return [Math.cos(t), Math.sin(t)];
}

function relax(list, edges, iters) {
  const MIN_D = 210;
  for (let it = 0; it < iters; it++) {
    const w = 0.25 * (1 - it / (iters * 1.2));
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const [ux, uy] = snapAngle(dx, dy);
      const cx = (ux * L - dx) * 0.5 * w, cy = (uy * L - dy) * 0.5 * w;
      a.x -= cx; a.y -= cy; b.x += cx; b.y += cy;
    }
    repel(list, MIN_D, 0.25);
    for (const s of list) { s.x += (s.ax - s.x) * 0.03; s.y += (s.ay - s.y) * 0.03; }
  }
}

function repel(nodes, min, k) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 1, p = (min - d) * k;
      a.x -= (dx / d) * p; a.y -= (dy / d) * p; b.x += (dx / d) * p; b.y += (dy / d) * p;
    }
  }
}

function buildChains(list, edges) {
  const adj = new Map(list.map(s => [s, []]));
  for (const [a, b] of edges) { adj.get(a).push(b); adj.get(b).push(a); }
  const isKey = s => adj.get(s).length !== 2 || s.forceKey;
  const seen = new Set();
  const ek = (a, b) => (a.id < b.id ? a.id + b.id : b.id + a.id);
  const chains = [];
  const walk = (start, next) => {
    const nodes = [start, next];
    seen.add(ek(start, next));
    let prev = start, cur = next;
    while (!isKey(cur) && cur !== start) {
      const nxt = adj.get(cur).find(n => n !== prev);
      seen.add(ek(cur, nxt));
      nodes.push(nxt); prev = cur; cur = nxt;
    }
    return { nodes };
  };
  for (const s of list) if (isKey(s)) for (const n of adj.get(s)) if (!seen.has(ek(s, n))) chains.push(walk(s, n));
  // Pure loops without any key node (not present today, but be safe).
  for (const s of list) for (const n of adj.get(s)) if (!seen.has(ek(s, n))) { s.forcedKey = true; chains.push(walk(s, n)); }
  for (const c of chains) c.n = c.nodes.length - 2;
  return chains;
}

function skeleton(keys, chains, iters) {
  // Each chain's target direction is fixed from the relaxed layout, so the
  // optimisation can straighten chains but never flip their orientation
  // (e.g. Ealing Broadway must stay west of Ealing Common).
  // Two direct links leaving the same station may not share a direction, or
  // their far ends would be pulled onto the same spot (Aldgate / Aldgate East).
  const taken = new Map();
  const isTaken = (n, i) => taken.get(n)?.has(i);
  const take = (n, i) => (taken.get(n) || taken.set(n, new Set()).get(n)).add(i);
  const withErr = chains.map(c => {
    const A = c.nodes[0], B = c.nodes[c.nodes.length - 1];
    const t = Math.atan2(B.ry - A.ry, B.rx - A.rx);
    return { c, A, B, t, err: Math.abs(t - Math.round(t / STEP) * STEP) };
  }).sort((a, b) => a.err - b.err);
  for (const { c, A, B, t } of withErr) {
    const order = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ i, d: Math.abs(Math.atan2(Math.sin(t - i * STEP), Math.cos(t - i * STEP))) })).sort((a, b) => a.d - b.d);
    let pick = order[0].i;
    if (c.n === 0) {
      const free = order.find(o => o.d < Math.PI / 2 && !isTaken(A, o.i) && !isTaken(B, (o.i + 4) % 8));
      if (free) pick = free.i;
      take(A, pick); take(B, (pick + 4) % 8);
    }
    c.dir = [Math.cos(pick * STEP), Math.sin(pick * STEP)];
  }
  for (let it = 0; it < iters; it++) {
    const w = 1 - it / (iters * 1.1);
    for (const c of chains) {
      const A = c.nodes[0], B = c.nodes[c.nodes.length - 1];
      if (A === B) continue;
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
      // Room for the stations on this chain.
      const need = (c.n + 1) * SPACING * 0.9;
      if (L < need) {
        const p = (need - L) * 0.15 * w;
        A.x -= (dx / L) * p; A.y -= (dy / L) * p; B.x += (dx / L) * p; B.y += (dy / L) * p;
      }
      // Direct key-to-key links can't bend, so they must be octilinear.
      // Longer chains bend at a station, so only prefer straightness gently.
      const k = c.n === 0 ? 0.35 : c.n <= 2 ? 0.08 : 0.03;
      const [ux, uy] = c.n === 0 ? c.dir : snapAngle(dx, dy);
      const cx = (ux * L - dx) * 0.5 * k * w, cy = (uy * L - dy) * 0.5 * k * w;
      A.x -= cx; A.y -= cy; B.x += cx; B.y += cy;
    }
    repel(keys, KEY_MIN, 0.2);
    for (const s of keys) { s.x += (s.rx - s.x) * 0.01; s.y += (s.ry - s.y) * 0.01; }
  }
  // Final hard snap of direct links (alternating ends to avoid drift).
  // Chains that are already nearly straight get snapped too, so they can be
  // drawn as one straight octilinear run.
  for (let r = 0; r < 60; r++) for (const c of [...chains, null]) {
    if (!c) { if (r < 50) repel(keys, KEY_MIN * 0.7, 0.5); continue; } // never collapse two nodes
    const A = c.nodes[0], B = c.nodes[c.nodes.length - 1];
    if (A === B) continue;
    if (c.n !== 0 && !nearOctilinear(B.x - A.x, B.y - A.y)) continue;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    const [ux, uy] = c.n === 0 ? c.dir : snapAngle(dx, dy);
    const cx = (ux * L - dx) * 0.5, cy = (uy * L - dy) * 0.5;
    A.x -= cx; A.y -= cy; B.x += cx; B.y += cy;
  }
}

// --- Chain routing ----------------------------------------------------------

function nearOctilinear(dx, dy) {
  const adx = Math.abs(dx), ady = Math.abs(dy), L = Math.hypot(dx, dy) || 1;
  const diag = Math.min(adx, ady), straight = Math.abs(adx - ady);
  return Math.min(diag * Math.SQRT2, straight) < 0.12 * L;
}

// The two octilinear L-routes from A to B (as bend points).
function lRoutes(A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  const diagFirst = { x: A.x + sx * m, y: A.y + sy * m };
  const straightFirst = { x: B.x - sx * m, y: B.y - sy * m };
  return [[A, diagFirst, B], [A, straightFirst, B]];
}

function fit(path, interior) {
  let e = 0;
  for (const s of interior) e += distToPolyline(s.rx, s.ry, path) ** 2;
  return e;
}

function sideOf(A, B, interior) {
  const dx = B.x - A.x, dy = B.y - A.y;
  let c = 0;
  for (const s of interior) c += dx * (s.ry - A.y) - dy * (s.rx - A.x);
  return c >= 0 ? 1 : -1;
}

function detour(A, B, n, side, scale = 1) {
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, vx = -uy * side, vy = ux * side;
  const h = Math.min(L / 2 - SPACING * 0.3, SPACING * 1.1 * scale);
  if (n >= 2 && L > 2 * h + SPACING * 0.5) {
    return [A, { x: A.x + (ux + vx) * h, y: A.y + (uy + vy) * h }, { x: B.x + (-ux + vx) * h, y: B.y + (-uy + vy) * h }, B];
  }
  return [A, { x: (A.x + B.x) / 2 + vx * L / 2, y: (A.y + B.y) / 2 + vy * L / 2 }, B];
}

// Candidate octilinear routes between the chain's end nodes.
function candidates(A, B, n) {
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
  const out = [];
  if (nearOctilinear(dx, dy)) out.push([A, B]);
  else {
    out.push(...lRoutes(A, B));
    // Z (axis – diagonal – axis) and S (diagonal – axis – diagonal) routes.
    const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    const adx = Math.abs(dx), ady = Math.abs(dy), m = Math.min(adx, ady), r = Math.abs(adx - ady);
    const ax = adx > ady ? sx : 0, ay = adx > ady ? 0 : sy;
    if (n >= 2) {
      const h = r / 2;
      out.push([A, { x: A.x + ax * h, y: A.y + ay * h }, { x: A.x + ax * h + sx * m, y: A.y + ay * h + sy * m }, B]);
      const g = m / 2;
      out.push([A, { x: A.x + sx * g, y: A.y + sy * g }, { x: A.x + sx * g + ax * r, y: A.y + sy * g + ay * r }, B]);
    }
  }
  // Detours (needed when two chains join the same pair of nodes, e.g. loops).
  for (const side of [1, -1]) for (const scale of [1, 2, 3.5]) {
    if (scale > 1 && n < 4) continue;
    const d = detour(A, B, n, side, scale);
    d.detour = true;
    out.push(d);
  }
  return out.filter(p => p.length - 2 <= n);
}

function placeChains(chains) {
  // Already-drawn geometry used to avoid overlaps.
  const segs = [];   // [P, Q]
  const points = []; // fixed station positions
  const keySet = new Set(chains.flatMap(c => [c.nodes[0], c.nodes[c.nodes.length - 1]]));
  for (const k of keySet) points.push(k);
  for (const c of chains) if (c.n === 0) segs.push([c.nodes[0], c.nodes[1]]);

  const pairCount = new Map();
  const pairKey = c => { const A = c.nodes[0], B = c.nodes[c.nodes.length - 1]; return A.id < B.id ? A.id + B.id : B.id + A.id; };
  for (const c of chains) pairCount.set(pairKey(c), (pairCount.get(pairKey(c)) || 0) + 1);
  const order = chains.filter(c => c.n > 0).sort((a, b) => a.n - b.n);
  for (const c of order) {
    const A = c.nodes[0], B = c.nodes[c.nodes.length - 1];
    const interior = c.nodes.slice(1, -1);
    if (A === B) continue; // loop: keep relaxed shape
    let best = null;
    for (const path of candidates(A, B, interior.length)) {
      const pos = placeAlong(c, path, true);
      if (!pos) continue;
      let cost = routeCost(c, path, pos, segs, points);
      // Detours make spikes; only worth it when another chain shares both ends.
      if (path.detour) cost += pairCount.get(pairKey(c)) > 1 ? 0 : 12;
      if (!best || cost < best.cost) best = { cost, pos };
    }
    if (!best) continue;
    interior.forEach((s, i) => { s.x = best.pos[i].x; s.y = best.pos[i].y; points.push(s); });
    for (let i = 1; i < c.nodes.length; i++) segs.push([c.nodes[i - 1], c.nodes[i]]);
  }
}

function routeCost(c, path, pos, segs, points) {
  const A = c.nodes[0], B = c.nodes[c.nodes.length - 1];
  const pts = [A, ...pos, B];
  const interior = c.nodes.slice(1, -1);
  let cost = 0;
  // Stay close to the relaxed (roughly geographic) shape.
  interior.forEach((s, i) => { cost += 0.25 * ((s.rx - pos[i].x) ** 2 + (s.ry - pos[i].y) ** 2) / (SPACING * SPACING); });
  cost += 0.4 * (path.length - 2); // fewer bends
  for (let i = 1; i < pts.length; i++) {
    const P = pts[i - 1], Q = pts[i];
    for (const [U, V] of segs) {
      const shared = U === P || U === Q || V === P || V === Q;
      if (!shared && crosses(P, Q, U, V)) cost += 2;
      // Running on top of an existing segment.
      let near = 0;
      for (let t = 0.2; t < 1; t += 0.2) if (distToSeg(P.x + (Q.x - P.x) * t, P.y + (Q.y - P.y) * t, U, V) < 55) near++;
      if (near >= 2 && !(shared && near < 3)) cost += 6;
    }
    for (const o of points) if (o !== P && o !== Q && distToSeg(o.x, o.y, P, Q) < 70) cost += 4;
  }
  for (const p of pos) for (const o of points) if (Math.hypot(o.x - p.x, o.y - p.y) < SPACING * 0.6) cost += 4;
  for (const p of pos) for (const [U, V] of segs) if (distToSeg(p.x, p.y, U, V) < 60) cost += 4;
  return cost;
}

// Place interior stations along `path`, with a station on every bend.
function placeAlong(c, path, dry = false) {
  const interior = c.nodes.slice(1, -1), n = interior.length;
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) { const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y); seg.push(d); total += d; }
  if (!total) return null;
  // Desired fractions: half even spacing, half the relaxed spacing.
  const rel = [0];
  for (let i = 1; i < c.nodes.length; i++) rel.push(rel[i - 1] + Math.hypot(c.nodes[i].rx - c.nodes[i - 1].rx, c.nodes[i].ry - c.nodes[i - 1].ry));
  const R = rel[rel.length - 1] || 1;
  const f = c.nodes.map((_, i) => 0.5 * (i / (n + 1)) + 0.5 * (rel[i] / R));
  // Bend positions (as fractions of path length) and the stations pinned to them.
  const bends = [];
  let acc = 0;
  for (let i = 0; i < seg.length - 1; i++) { acc += seg[i]; bends.push(acc / total); }
  const anchors = [[0, 0]]; // [nodeIndex, fraction]
  let lastIdx = 0;
  for (let j = 0; j < bends.length; j++) {
    const remainingBends = bends.length - j - 1;
    let best = -1, bd = Infinity;
    for (let i = lastIdx + 1; i <= n - remainingBends; i++) {
      const d = Math.abs(f[i] - bends[j]);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null; // not enough stations for the bends
    anchors.push([best, bends[j]]);
    lastIdx = best;
  }
  anchors.push([n + 1, 1]);
  const pos = new Array(n + 2);
  for (let a = 0; a < anchors.length - 1; a++) {
    const [i0, f0] = anchors[a], [i1, f1] = anchors[a + 1];
    for (let i = i0; i <= i1; i++) {
      const t = f[i1] === f[i0] ? (i - i0) / (i1 - i0 || 1) : (f[i] - f[i0]) / (f[i1] - f[i0]);
      pos[i] = f0 + (f1 - f0) * t;
    }
  }
  const out = [];
  for (let i = 1; i <= n; i++) {
    let d = pos[i] * total, k = 0;
    while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; }
    const P = path[k], Q = path[k + 1], t = seg[k] ? Math.min(1, d / seg[k]) : 0;
    out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
  }
  if (!dry) interior.forEach((s, i) => { s.x = out[i].x; s.y = out[i].y; });
  return out;
}

// Stations that ended up almost on top of each other (different chains):
// nudge interior (non-key) stations apart along their own chain direction.
function separate(list, edges, chains) {
  const keySet = new Set(chains.flatMap(c => [c.nodes[0], c.nodes[c.nodes.length - 1]]));
  // Stations sitting on (or tracks running over) a line that doesn't serve
  // them: push the station clear of the foreign track.
  for (let it = 0; it < 60; it++) {
    for (const s of list) {
      if (keySet.has(s)) continue;
      for (const [a, b] of edges) {
        if (a === s || b === s) continue;
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((s.x - a.x) * dx + (s.y - a.y) * dy) / L2));
        const px = a.x + dx * t, py = a.y + dy * t, d = Math.hypot(s.x - px, s.y - py);
        if (d >= 70 || t <= 0.02 || t >= 0.98) continue;
        const L = Math.sqrt(L2);
        let nx = -dy / L, ny = dx / L;
        if ((s.x - px) * nx + (s.y - py) * ny < 0) { nx = -nx; ny = -ny; }
        s.x += nx * (70 - d) * 0.5; s.y += ny * (70 - d) * 0.5;
      }
    }
  }
  for (let it = 0; it < 40; it++) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= 90) continue;
      const movable = [a, b].filter(s => !keySet.has(s));
      for (const s of movable) {
        const o = s === a ? b : a;
        s.x += ((s.x - o.x) / (d || 1)) * (90 - d) * 0.3;
        s.y += ((s.y - o.y) / (d || 1)) * (90 - d) * 0.3;
      }
    }
  }
}

// --- Diagnostics ---------------------------------------------------------------

function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}
function distToPolyline(px, py, path) {
  let m = Infinity;
  for (let i = 1; i < path.length; i++) m = Math.min(m, distToSeg(px, py, path[i - 1], path[i]));
  return m;
}
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

export function report(list, edges, chains) {
  let oct = 0;
  for (const [a, b] of edges) {
    const t = Math.atan2(b.y - a.y, b.x - a.x);
    if (Math.abs(t - Math.round(t / STEP) * STEP) < 0.02) oct++;
  }
  let close = 0, minD = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
    minD = Math.min(minD, d);
    if (d < 120) { close++; if (process.env.TRACE) console.log('  close:', list[i].name, list[j].name, d | 0); }
  }
  let cross = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const [a, b] = edges[i], [c, d] = edges[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (crosses(a, b, c, d)) cross++;
  }
  let onEdge = [];
  for (const s of list) for (const [a, b] of edges) {
    if (s === a || s === b) continue;
    if (distToSeg(s.x, s.y, a, b) < 45) onEdge.push(`${s.name} on ${a.name}–${b.name}`);
  }
  // Tracks drawn on top of each other: two edges that don't share a station
  // but run within a line-width of each other for a stretch.
  const overlaps = [];
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const [a, b] = edges[i], [c, d] = edges[j];
    if (a === c || a === d || b === c || b === d) continue;
    let near = 0;
    for (let k = 1; k < 8; k++) { const t = k / 8; if (distToSeg(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, c, d) < 40) near++; }
    if (near >= 3) overlaps.push(`${a.name}–${b.name} over ${c.name}–${d.name}`);
  }
  console.log(`layout: ${chains.length} chains, ${oct}/${edges.length} edges octilinear, ${cross} crossings, ${close} pairs < 120 (min ${minD.toFixed(0)}), ${onEdge.length} stations sitting on foreign edges, ${overlaps.length} overlapping tracks`);
  if (overlaps.length) console.log('  overlap: ' + overlaps.join('\n  overlap: '));
  if (onEdge.length) console.log('  ' + onEdge.slice(0, 12).join('\n  '));
  return { oct, cross, close, onEdge: onEdge.length, overlaps: overlaps.length };
}
