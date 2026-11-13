// Background thread: fetches TfL, parses the ~2 MB arrivals feed and rebuilds
// every train, so none of that work can stall the map animation.

import { createReconstructor, stationArrivals } from './shared/reconstruct.mjs';

const TFL = 'https://api.tfl.gov.uk';
const ARRIVALS_TTL = 25_000;

let reconstruct = null;
let clockOffset = 0;
let snap = null, inflight = null;

const now = () => Date.now() + clockOffset;

async function get(path) {
  const res = await fetch(TFL + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`TfL ${res.status}`);
  return res.json();
}

function arrivals() {
  if (snap && Date.now() - snap.localAt < ARRIVALS_TTL) return Promise.resolve(snap);
  inflight ??= get('/Mode/tube/Arrivals?count=-1')
    .then(preds => {
      let latest = 0;
      for (const p of preds) { const t = Date.parse(p.timestamp); if (t > latest) latest = t; }
      // A cross-origin page can't read TfL's Date header, so infer clock skew
      // from the newest prediction; only correct clearly wrong device clocks.
      const skew = latest ? latest - Date.now() : 0;
      clockOffset = Math.abs(skew) > 60_000 ? skew + 15_000 : 0;
      const { trains, stats } = reconstruct(preds, now());
      snap = { preds, trains, stats, fetchedAt: latest || now(), localAt: Date.now() };
      return snap;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

const handlers = {
  init({ network }) { reconstruct = createReconstructor(network); return true; },
  async trains() {
    const s = await arrivals();
    return { fetchedAt: s.fetchedAt, stats: s.stats, trains: s.trains, clockOffset };
  },
  async station({ ids }) {
    const s = await arrivals();
    return { fetchedAt: s.fetchedAt, arrivals: stationArrivals(s.preds, ids, now()) };
  },
  async status() {
    const lines = await get('/Line/Mode/tube/Status');
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
