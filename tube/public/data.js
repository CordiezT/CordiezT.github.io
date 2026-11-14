// Data layer. TfL's API allows cross-origin requests, so the app talks to it
// directly and can be hosted as static files. The heavy lifting (fetching,
// parsing ~2 MB of predictions, rebuilding ~400 trains) runs in a Web Worker
// so the map animation never stutters when new data lands.

export function createData(network) {
  const worker = new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data: { id, ok, result, error } }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  const call = (type, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, args });
  });
  call('init', { network });

  let clockOffset = 0;
  return {
    get clockOffset() { return clockOffset; },
    async trains() { const r = await call('trains'); clockOffset = r.clockOffset; return r; },
    station: ids => call('station', { ids }),
    setModes: list => call('setModes', { list }),
    status: () => call('status'),
  };
}
