// Data layer, running entirely in the browser.
//
// TfL's Unified API allows cross-origin requests, so the page talks to it
// directly and the whole app can be hosted as static files. One arrivals
// request (≈220 KB gzipped, all 11 lines) feeds both the trains and every
// station panel; TfL's CDN caches it for ~30 s, so polling faster is pointless.

import { createReconstructor, stationArrivals } from './shared/reconstruct.mjs';

const TFL = 'https://api.tfl.gov.uk';
const ARRIVALS_TTL = 25_000;

export function createData(network) {
  const reconstruct = createReconstructor(network);
  let clockOffset = 0; // TfL clock minus local clock (phones can be off by minutes)
  let snap = null;     // { preds, fetchedAt, trains, stats }
  let inflight = null;

  const now = () => Date.now() + clockOffset;

  async function get(path) {
    const res = await fetch(TFL + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`TfL ${res.status}`);
    return res.json();
  }

  async function arrivals() {
    if (snap && Date.now() - snap.localAt < ARRIVALS_TTL) return snap;
    if (!inflight) {
      inflight = get('/Mode/tube/Arrivals?count=-1')
        .then(preds => {
          // Prediction timestamps are TfL's clock; use the newest as "fetched at".
          let latest = 0;
          for (const p of preds) { const t = Date.parse(p.timestamp); if (t > latest) latest = t; }
          // A cross-origin page can't read TfL's Date header, so infer clock
          // skew from the newest prediction. Only correct clearly wrong clocks:
          // the feed itself legitimately lags real time by up to ~30 s.
          const skew = latest ? latest - Date.now() : 0;
          clockOffset = Math.abs(skew) > 60_000 ? skew + 15_000 : 0;
          const { trains, stats } = reconstruct(preds, now());
          snap = { preds, trains, stats, fetchedAt: latest || now(), localAt: Date.now() }; // fetchedAt = age of TfL's newest data
          return snap;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    now,
    get clockOffset() { return clockOffset; },
    async trains() {
      const s = await arrivals();
      return { serverTime: now(), fetchedAt: s.fetchedAt, stale: false, stats: s.stats, trains: s.trains };
    },
    async station(ids) {
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
}
