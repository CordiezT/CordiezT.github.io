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

  const model = { stations, lines, lineById: new Map(lines.map(l => [l.id, l])), physical, edgeKey, layout: 'schematic' };
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

// World coordinates for the current layout (morphable between two layouts).
const GEO_SCALE = 0.42;
function setLayout(model, mode, t) {
  model.layout = mode;
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
    const A = stations.get(e.a), B = stations.get(e.b);
    let dx = B.wx - A.wx, dy = B.wy - A.wy;
    // Orient consistently (eastwards / southwards) so ordering is stable along corridors.
    let sign = dx > 1e-6 || (Math.abs(dx) <= 1e-6 && dy > 0) ? 1 : -1;
    const L = Math.hypot(dx, dy) || 1;
    e.nx = (-dy / L) * sign; e.ny = (dx / L) * sign;
    e.ofs = new Map(e.lines.map((id, i) => [id, i - (e.lines.length - 1) / 2]));
  }
  for (const l of lines) {
    l.vofs = new Map();
    for (const [id, ns] of l.adj) {
      let ox = 0, oy = 0;
      for (const n of ns) {
        const e = physical.get(model.edgeKey(id, n));
        const o = e.ofs.get(l.id);
        ox += e.nx * o; oy += e.ny * o;
      }
      // Average, but keep magnitude at corners (miter-like, capped).
      ox /= ns.length; oy /= ns.length;
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
