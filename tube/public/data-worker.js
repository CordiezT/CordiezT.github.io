// Background thread: fetches TfL, parses the arrivals feeds and rebuilds every
// train, so none of that work can stall the map animation.
//
// Four feeds (Underground, Elizabeth line, Overground, DLR) are fetched on
// their own schedules; only the modes currently shown are downloaded.

import { createReconstructor, stationArrivals } from './shared/reconstruct.mjs';

const TFL = 'https://api.tfl.gov.uk';
const FEEDS = {
  tube: { path: '/Mode/tube/Arrivals?count=-1', ttl: 25_000 },
  elizabeth: { path: '/Mode/elizabeth-line/Arrivals?count=-1', ttl: 40_000 },
  overground: { path: '/Mode/overground/Arrivals?count=-1', ttl: 40_000 },
  dlr: { path: '/Mode/dlr/Arrivals?count=-1', ttl: 30_000 },
};

let reconstruct = null, aliases = {};
let clockOffset = 0;
let modes = new Set(Object.keys(FEEDS));
const feeds = new Map(); // mode -> { preds, at, inflight }
let snap = null;          // combined result
let anonPrev = [], anonSeq = 0;

const now = () => Date.now() + clockOffset;

async function get(path) {
  const res = await fetch(TFL + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`TfL ${res.status}`);
  return res.json();
}

async function refresh(mode) {
  const f = feeds.get(mode) || feeds.set(mode, { preds: [], at: 0, inflight: null }).get(mode);
  if (Date.now() - f.at < FEEDS[mode].ttl) return false;
  f.inflight ??= get(FEEDS[mode].path)
    .then(p => { f.preds = p; f.at = Date.now(); return true; })
    .catch(() => false)
    .finally(() => { f.inflight = null; });
  return f.inflight;
}

// Trains without ids (DLR) get stable ids by matching them to the previous
// snapshot: same line and destination, and either the same next stop at a
// similar time, or the stop it was heading for is now behind it.
function trackAnonymous(trains) {
  const used = new Set();
  for (const t of trains) {
    if (!t.anonymous) continue;
    let best = null, bd = Infinity;
    for (const p of anonPrev) {
      if (used.has(p.id) || p.line !== t.line || p.destination !== t.destination) continue;
      const s1 = t.stops[0];
      const same = p.stops.find(([s]) => s === s1[0]);
      let d = same ? Math.abs(same[1] - s1[1]) : Infinity;
      if (t.from && p.stops[0][0] === t.from) d = Math.min(d, 30_000);
      if (d < 150_000 && d < bd) { bd = d; best = p; }
    }
    t.id = best ? best.id : `${t.line}:a${++anonSeq}`;
    if (best) used.add(best.id);
  }
  anonPrev = trains.filter(t => t.anonymous);
}

async function arrivals() {
  const changed = await Promise.all([...modes].map(refresh));
  if (snap && !changed.some(Boolean)) return snap;
  const preds = [...modes].flatMap(m => feeds.get(m)?.preds || []);
  // Freshness = newest prediction in any feed (at night the Tube feed goes
  // quiet while Night Tube, Overground or DLR may still be reporting).
  let latest = 0;
  for (const p of preds) { const t = Date.parse(p.timestamp); if (t > latest) latest = t; }
  // A cross-origin page can't read TfL's Date header, so infer clock skew
  // from the newest prediction; only correct clearly wrong device clocks.
  const skew = latest ? latest - Date.now() : 0;
  clockOffset = Math.abs(skew) > 60_000 ? skew + 15_000 : 0;
  const { trains, stats } = reconstruct(preds, now());
  trackAnonymous(trains);
  snap = { preds, trains, stats, fetchedAt: latest || now() };
  return snap;
}

const handlers = {
  init({ network }) { reconstruct = createReconstructor(network); aliases = network.aliases || {}; return true; },
  setModes({ list }) { modes = new Set(list.filter(m => FEEDS[m])); snap = null; return true; },
  async trains() {
    const s = await arrivals();
    return { fetchedAt: s.fetchedAt, stats: s.stats, trains: s.trains, clockOffset };
  },
  async station({ ids }) {
    const s = await arrivals();
    return { fetchedAt: s.fetchedAt, arrivals: stationArrivals(s.preds, ids, now(), aliases) };
  },
  async status() {
    const lines = await get('/Line/Mode/tube,elizabeth-line,overground,dlr/Status');
    return {
      lines: lines.map(l => ({
        id: l.id,
        statuses: l.lineStatuses.map(s => ({ severity: s.statusSeverity, text: s.statusSeverityDescription, reason: (s.reason || '').trim() || null })),
      })),
    };
  },
};

self.onmessage = async ({ data: { id, type, args } }) => {
  try { self.postMessage({ id, ok: true, result: await handlers[type](args || {}) }); }
  catch (err) { self.postMessage({ id, ok: false, error: String(err.message || err) }); }
};
