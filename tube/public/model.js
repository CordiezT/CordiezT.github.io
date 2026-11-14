// Network geometry + train timelines. No DOM here.

export function buildModel(network, lineDefs) {
  const stations = new Map(network.stations.map(s => [s.id, { ...s, lineSet: new Set(s.lines) }]));
  const lineMeta = new Map(lineDefs.map((l, i) => [l.id, { ...l, order: i }]));
  const lines = network.lines
    .map(l => ({ ...l, ...lineMeta.get(l.id) }))
    .sort((a, b) => a.order - b.order);

  // Physical edges shared by several lines -> parallel offsets.
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const physical = new Map(); // key -> { a, b, lines: [] }
  for (const l of lines) for (const [a, b] of l.edges) {
    const k = edgeKey(a, b);
    if (!physical.has(k)) physical.set(k, { a, b, lines: [] });
    physical.get(k).lines.push(l.id);
  }

  orientEdges(physical);

  // Adjacency per line.
  for (const l of lines) {
    l.adj = new Map();
    for (const [a, b] of l.edges) {
      (l.adj.get(a) || l.adj.set(a, []).get(a)).push(b);
      (l.adj.get(b) || l.adj.set(b, []).get(b)).push(a);
    }
    l.terminals = new Set([...l.adj].filter(([, n]) => n.length === 1).map(([id]) => id));
    for (const r of l.routes) { l.terminals.add(r[0]); l.terminals.add(r[r.length - 1]); }
    // Maximal chains (split at junctions and terminals) for smooth drawing.
    l.chains = chains(l.adj);
  }

  const model = { stations, lines, lineById: new Map(lines.map(l => [l.id, l])), physical, edgeKey, layout: 'schematic', riverRaw: network.river || [] };
  // Planned bends (waypoints) per line, keyed by sorted station pair.
  for (const l of lines) l.viaRaw = new Map(Object.entries(network.via?.[l.id] || {}));
  // World-space points of a line between two adjacent stations, a→b inclusive.
  model.edgePoints = (l, a, b) => {
    const A = stations.get(a), B = stations.get(b);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const v = l.via?.get(k);
    if (!v) return [[A.wx, A.wy], [B.wx, B.wy]];
    const mid = a < b ? v : [...v].reverse();
    return [[A.wx, A.wy], ...mid, [B.wx, B.wy]];
  };
  model.setLayout = (mode, t = 1) => setLayout(model, mode, t);
  model.setLayout('schematic');

  // Station categories
  for (const s of stations.values()) {
    const hubSiblings = s.hub ? [...stations.values()].filter(o => o.hub === s.hub && o.id !== s.id) : [];
    s.siblings = hubSiblings.map(o => o.id);
    s.interchange = s.lines.length > 1 || hubSiblings.length > 0;
    s.terminal = lines.some(l => l.terminals.has(s.id) && l.adj.get(s.id)?.length === 1);
  }

  const pathCache = new Map();
  model.path = (lineId, a, b) => {
    const k = `${lineId}:${a}:${b}`;
    if (pathCache.has(k)) return pathCache.get(k);
    const l = model.lineById.get(lineId);
    let p = null;
    if (l && l.adj.has(a) && l.adj.has(b)) {
      const prev = new Map([[a, null]]);
      const q = [a];
      while (q.length && !prev.has(b)) {
        const n = q.shift();
        for (const m of l.adj.get(n)) if (!prev.has(m)) { prev.set(m, n); q.push(m); }
      }
      if (prev.has(b)) { p = []; for (let n = b; n; n = prev.get(n)) p.push(n); p.reverse(); }
    }
    if (!p) p = [a, b];
    pathCache.set(k, p);
    return p;
  };
  // Real-world path length (m) for travel-time estimates.
  model.geoLength = (lineId, a, b) => {
    const p = model.path(lineId, a, b);
    let d = 0;
    for (let i = 1; i < p.length; i++) {
      const A = stations.get(p[i - 1]), B = stations.get(p[i]);
      d += Math.hypot(A.gx - B.gx, A.gy - B.gy);
    }
    return d;
  };
  return model;
}

function chains(adj) {
  const seen = new Set();
  const out = [];
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const isNode = id => adj.get(id).length !== 2;
  const walk = (start, next) => {
    const c = [start, next];
    seen.add(key(start, next));
    let prev = start, cur = next;
    while (!isNode(cur) && cur !== start) {
      const nxt = adj.get(cur).find(n => n !== prev);
      if (seen.has(key(cur, nxt))) break;
      seen.add(key(cur, nxt));
      c.push(nxt); prev = cur; cur = nxt;
    }
    return c;
  };
  for (const [id, ns] of adj) if (isNode(id)) for (const n of ns) if (!seen.has(key(id, n))) out.push(walk(id, n));
  for (const [id, ns] of adj) for (const n of ns) if (!seen.has(key(id, n))) out.push(walk(id, n)); // pure loops
  return out;
}

// Give every shared section a travel direction that is consistent along each
// line (an edge leaving a station continues the edge that arrived there), so a
// bundle of parallel lines keeps the same left-to-right order through bends
// instead of swapping sides from one segment to the next.
function orientEdges(physical) {
  const byStation = new Map();
  for (const [k, e] of physical) for (const id of [e.a, e.b]) (byStation.get(id) || byStation.set(id, []).get(id)).push(k);
  const dir = new Map();
  // Start from the busiest edges so the big corridors set the convention.
  const order = [...physical.keys()].sort((x, y) => physical.get(y).lines.length - physical.get(x).lines.length);
  for (const k0 of order) {
    if (dir.has(k0)) continue;
    const e0 = physical.get(k0);
    dir.set(k0, [e0.a, e0.b]);
    const queue = [k0];
    while (queue.length) {
      const k = queue.shift(), [from, to] = dir.get(k), e = physical.get(k);
      for (const [node, leaving] of [[to, true], [from, false]]) {
        for (const k2 of byStation.get(node)) {
          if (dir.has(k2)) continue;
          const e2 = physical.get(k2);
          if (!e2.lines.some(l => e.lines.includes(l))) continue;
          const other = e2.a === node ? e2.b : e2.a;
          dir.set(k2, leaving ? [node, other] : [other, node]);
          queue.push(k2);
        }
      }
    }
  }
  for (const [k, e] of physical) e.dir = dir.get(k);
}

// World coordinates for the current layout (morphable between two layouts).
const GEO_SCALE = 0.42;
function setLayout(model, mode, t) {
  model.layout = mode;
  const kk = mode === 'geo' ? t : 1 - t;
  // Waypoints: schematic positions morph to evenly spaced points on the
  // straight geographic connection.
  for (const l of model.lines || []) {
    l.via = new Map();
    for (const [k, pts] of l.viaRaw || []) {
      const [a, b] = k.split('|').map(id => model.stations.get(id));
      if (!a || !b) continue;
      l.via.set(k, pts.map(([x, y], i) => {
        const f = (i + 1) / (pts.length + 1);
        const gx = (a.gx + (b.gx - a.gx) * f) * GEO_SCALE, gy = (a.gy + (b.gy - a.gy) * f) * GEO_SCALE;
        return [x + (gx - x) * kk, y + (gy - y) * kk];
      }));
    }
  }
  model.river = (model.riverRaw || []).map(([x, y, gx, gy]) => [x + (gx * GEO_SCALE - x) * kk, y + (gy * GEO_SCALE - y) * kk]);
  for (const s of model.stations.values()) {
    const sx = s.x, sy = s.y, gx = s.gx * GEO_SCALE, gy = s.gy * GEO_SCALE;
    const k = mode === 'geo' ? t : 1 - t;
    s.wx = sx + (gx - sx) * k;
    s.wy = sy + (gy - sy) * k;
  }
  computeOffsets(model);
}

// Per line, per station: unit offset vector (in "gap" units) so that parallel
// lines sit side by side. Recomputed whenever the layout changes.
function computeOffsets(model) {
  const { stations, physical, lines } = model;
  for (const e of physical.values()) {
    const A = stations.get(e.dir[0]), B = stations.get(e.dir[1]);
    const dx = B.wx - A.wx, dy = B.wy - A.wy;
    const L = Math.hypot(dx, dy) || 1;
    e.nx = -dy / L; e.ny = dx / L;
    e.ofs = new Map(e.lines.map((id, i) => [id, i - (e.lines.length - 1) / 2]));
  }
  for (const l of lines) {
    l.vofs = new Map();
    for (const [id, ns] of l.adj) {
      let ox = 0, oy = 0;
      const vs = ns.map(n => { const e = physical.get(model.edgeKey(id, n)); const o = e.ofs.get(l.id); return [e.nx * o, e.ny * o, o, e]; });
      if (vs.length === 2 && Math.abs(vs[0][2] - vs[1][2]) < 1e-6 && vs[0][2] !== 0) {
        // Mitred corner: keep the full offset distance through the bend so
        // parallel lines stay evenly spaced instead of pinching together.
        const [a, b] = vs, o = a[2];
        const n1x = a[3].nx, n1y = a[3].ny, n2x = b[3].nx, n2y = b[3].ny;
        const dot = n1x * n2x + n1y * n2y;
        const k = 1 / Math.max(0.35, 1 + dot); // cap very sharp corners
        ox = (n1x + n2x) * o * k; oy = (n1y + n2y) * o * k;
      } else {
        for (const v of vs) { ox += v[0]; oy += v[1]; }
        ox /= vs.length; oy /= vs.length;
      }
      l.vofs.set(id, [ox, oy]);
    }
  }
}

// ---------------------------------------------------------------------------
// Train timeline: from server reconstruction to a position at time `now`.

const SPEED = 11; // m/s average for travel-time estimates
const MIN_DWELL = 20_000;

export function buildTimeline(model, t) {
  const pts = [];
  if (t.from && t.fromT != null) pts.push({ s: t.from, arr: -Infinity, dep: t.fromT });
  t.stops.forEach(([s, time], i) => pts.push({ s, arr: time, dep: Infinity }));
  if (pts.length && pts[0].arr !== -Infinity) pts[0].arr = -Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.dep !== Infinity && i === 0 && t.from) { a.dep = Math.min(a.dep, b.arr - 8_000); continue; }
    const travel = model.geoLength(t.line, a.s, b.s) / SPEED * 1000 + 6_000;
    let dep = Math.max((a.arr === -Infinity ? b.arr - travel : a.arr + MIN_DWELL), b.arr - travel);
    a.dep = Math.min(dep, b.arr - 5_000);
    if (a.arr !== -Infinity) a.dep = Math.max(a.dep, Math.min(a.arr, b.arr - 5_000));
  }
  return pts;
}

// Returns { a, b, f, moving } where a/b are station ids and f in [0,1].
export function locate(pts, now) {
  if (!pts.length) return null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (now < p.arr) {
      const prev = pts[i - 1];
      const span = p.arr - prev.dep;
      let f = span > 0 ? (now - prev.dep) / span : 1;
      f = Math.min(1, Math.max(0, f));
      f = 0.5 * f + 0.5 * f * f * (3 - 2 * f); // gentle ease in/out
      return { a: prev.s, b: p.s, f, moving: true, i };
    }
    if (now < p.dep) {
      const nxt = pts[i + 1];
      return { a: p.s, b: nxt ? nxt.s : p.s, f: 0, moving: false, i };
    }
  }
  const last = pts[pts.length - 1];
  return { a: last.s, b: last.s, f: 0, moving: false, i: pts.length - 1, ended: true };
}
