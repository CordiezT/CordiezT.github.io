// HTTP server: static frontend + a small JSON API in front of TfL.
// No dependencies. Start with `npm start` (reads ./.env if present).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { cached, hasKey } from './tfl.mjs';
import { createReconstructor, stationArrivals } from '../public/shared/reconstruct.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const ARRIVALS_TTL = 20_000; // TfL's CDN caches this feed for ~30 s anyway
const STATUS_TTL = 60_000;

const network = JSON.parse(await readFile(join(ROOT, 'public/data/network.json'), 'utf8'));
const reconstruct = createReconstructor(network);

let lastTrains = { fetchedAt: 0, body: null };
async function trains() {
  const r = await cached('/Mode/tube/Arrivals?count=-1', ARRIVALS_TTL);
  if (lastTrains.fetchedAt !== r.fetchedAt) {
    const { trains, stats } = reconstruct(r.value);
    lastTrains = { fetchedAt: r.fetchedAt, body: { fetchedAt: r.fetchedAt, stats, trains } };
  }
  return { ...lastTrains.body, stale: r.stale, error: r.error || null };
}

async function status() {
  const r = await cached('/Line/Mode/tube/Status', STATUS_TTL);
  return {
    fetchedAt: r.fetchedAt, stale: r.stale,
    lines: r.value.map(l => ({
      id: l.id,
      statuses: l.lineStatuses.map(s => ({
        severity: s.statusSeverity, text: s.statusSeverityDescription, reason: (s.reason || '').trim() || null,
      })),
    })),
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(req, res, code, body, type = 'application/json', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'content-type': type, ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|javascript|css|html/.test(type)) {
    buf = gzipSync(buf); headers['content-encoding'] = 'gzip';
  }
  res.writeHead(code, headers);
  res.end(buf);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/trains') return send(req, res, 200, { serverTime: Date.now(), ...(await trains()) }, 'application/json', { 'cache-control': 'no-store' });
    if (url.pathname === '/api/status') return send(req, res, 200, await status(), 'application/json', { 'cache-control': 'no-store' });
    if (url.pathname === '/api/station') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(id => /^[0-9A-Z]{6,16}$/.test(id)).slice(0, 4);
      const r = await cached('/Mode/tube/Arrivals?count=-1', ARRIVALS_TTL);
      return send(req, res, 200, { serverTime: Date.now(), fetchedAt: r.fetchedAt, arrivals: stationArrivals(r.value, ids) }, 'application/json', { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/health') return send(req, res, 200, { ok: true, key: hasKey() });

    // Static files from public/ (the app itself no longer needs /api: it calls
    // TfL directly, so public/ can be hosted anywhere as plain files).
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const base = join(ROOT, 'public');
    const file = normalize(join(base, rel));
    if (!file.startsWith(base)) return send(req, res, 403, 'forbidden', 'text/plain');
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) return send(req, res, 404, 'not found', 'text/plain');
    send(req, res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
  } catch (err) {
    console.error(err);
    send(req, res, 502, { error: String(err.message || err) });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (is Tube Live already running?). Stop it or run with PORT=8788 npm start`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`Tube Live on http://localhost:${PORT}  (TfL key: ${hasKey() ? 'yes' : 'no, anonymous'})`);
  // Addresses a phone on the same Wi-Fi can open.
  const lan = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
  if (lan.length) console.log(`On your phone (same Wi-Fi): ${lan.join('  ')}`);
});
