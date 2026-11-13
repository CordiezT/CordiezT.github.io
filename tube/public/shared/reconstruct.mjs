// Train-position reconstruction.
//
// TfL does not publish train positions. What it does publish, per train and per
// upcoming station, is a prediction: vehicleId (the train's "set number", unique
// per line at a given moment), station, expected arrival, destination and a free
// text `currentLocation` ("Between Oval and Kennington", "At Euston Platform 2").
//
// From those sightings we rebuild, for each train:
//   from   – the station it is leaving / last left (best effort)
//   stops  – the upcoming stations with expected arrival times (monotonic)
// The client animates along that timeline; positions between stations are
// therefore an interpolation, not a measurement.

const HOP_LIMIT = 99;

export function createReconstructor(network) {
  const lineGraphs = new Map();
  const stationById = new Map(network.stations.map(s => [s.id, s]));

  for (const line of network.lines) {
    const adj = new Map();
    const add = (a, b) => (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
    for (const [a, b] of line.edges) { add(a, b); add(b, a); }
    // All-pairs hop distance (≤ 60 stations per line, so BFS from each is cheap).
    const hops = new Map();
    for (const src of adj.keys()) {
      const d = new Map([[src, 0]]);
      const q = [src];
      while (q.length) {
        const n = q.shift();
        for (const m of adj.get(n)) if (!d.has(m)) { d.set(m, d.get(n) + 1); q.push(m); }
      }
      hops.set(src, d);
    }
    // Normalised name -> station id, for parsing `currentLocation`.
    const names = new Map();
    for (const id of adj.keys()) names.set(norm(stationById.get(id).name), id);
    lineGraphs.set(line.id, { adj, hops, names });
  }

  const hop = (g, a, b) => g.hops.get(a)?.get(b) ?? HOP_LIMIT;

  function findStation(g, text) {
    const n = norm(text);
    if (!n) return null;
    if (g.names.has(n)) return g.names.get(n);
    for (const [k, id] of g.names) if (n.startsWith(k) || k.startsWith(n)) return id;
    return null;
  }

  // Parse TfL's free-text location into { kind, a, b } with station ids.
  function parseLocation(g, text, ownStation) {
    if (!text) return null;
    const t = text.replace(/\s+/g, ' ').trim();
    if (/^at platform$/i.test(t)) return { kind: 'at', a: ownStation };
    let m = t.match(/^between (.+)$/i);
    if (m) {
      const parts = m[1].split(/ and /i);
      for (let i = 1; i < parts.length; i++) {
        const a = findStation(g, parts.slice(0, i).join(' and '));
        const b = findStation(g, parts.slice(i).join(' and '));
        if (a && b) return { kind: 'between', a, b };
      }
      return null;
    }
    m = t.match(/^(at|approaching|arriving at|arriving|left|departed|leaving|departing|near|north of|south of|east of|west of|outside)\s+(.+?)(\s+platform.*)?$/i);
    if (!m) return null;
    const verb = m[1].toLowerCase();
    const a = findStation(g, m[2]);
    if (!a) return null;
    const kind = verb === 'at' ? 'at'
      : /^(approaching|arriving|outside)/.test(verb) ? 'approaching'
      : /^(left|departed|leaving|departing)/.test(verb) ? 'left' : 'near';
    return { kind, a };
  }

  function distM(a, b) {
    const A = stationById.get(a), B = stationById.get(b);
    const k = Math.cos((A.lat * Math.PI) / 180);
    return Math.hypot((A.lon - B.lon) * k * 111320, (A.lat - B.lat) * 110540);
  }

  return function reconstruct(predictions, now = Date.now()) {
    const groups = new Map();
    let unidentified = 0, unknownStation = 0;
    for (const p of predictions) {
      const g = lineGraphs.get(p.lineId);
      if (!g) continue;
      const vid = (p.vehicleId || '').trim();
      if (!vid || /^0+$/.test(vid)) { unidentified++; continue; }
      if (!g.adj.has(p.naptanId)) { unknownStation++; continue; }
      const t = Date.parse(p.expectedArrival);
      if (!(t > now - 90_000)) continue; // already passed
      const key = `${p.lineId}:${vid}`;
      (groups.get(key) || groups.set(key, []).get(key)).push({ ...p, t, ts: Date.parse(p.timestamp) });
    }

    const trains = [];
    let split = 0;
    for (const [key, preds] of groups) {
      const lineId = preds[0].lineId;
      const g = lineGraphs.get(lineId);
      preds.sort((a, b) => a.t - b.t);

      // 1. Chain sightings: a set number can occasionally be shared by two trains,
      //    so split predictions that cannot physically belong to one train.
      const chains = [];
      for (const p of preds) {
        let best = null, bestH = Infinity;
        for (const c of chains) {
          const last = c[c.length - 1];
          if (last.naptanId === p.naptanId) { best = c; bestH = -1; break; }
          const h = hop(g, last.naptanId, p.naptanId);
          const allowed = 2 + (p.t - last.t) / 40_000;
          if (h <= allowed && h < bestH) { best = c; bestH = h; }
        }
        if (best) { if (bestH !== -1) best.push(p); else if (p.ts > best[best.length - 1].ts) best[best.length - 1] = p; }
        else chains.push([p]);
      }
      if (chains.length > 1) split += chains.length - 1;

      chains.forEach((chain, ci) => {
        // 2. Order by distance along the line from the first stop (predictions
        //    are sometimes out of order), then force arrival times to be monotonic.
        const first = chain[0].naptanId;
        chain.sort((a, b) => hop(g, first, a.naptanId) - hop(g, first, b.naptanId) || a.t - b.t);
        let tmax = 0;
        const stops = [];
        for (const p of chain) {
          tmax = Math.max(tmax, p.t);
          stops.push([p.naptanId, tmax]);
        }

        // 3. Where is it coming from? Use the freshest free-text location.
        const freshest = chain.reduce((a, b) => (b.ts > a.ts ? b : a));
        const loc = parseLocation(g, freshest.currentLocation, freshest.naptanId);
        // Predictions for stations the train has already passed linger in the
        // feed; trim them using the location text.
        let from = null;
        if (loc) {
          const ia = stops.findIndex(s => s[0] === loc.a);
          if ((loc.kind === 'left' || loc.kind === 'between') && ia >= 0 && ia < stops.length - 1) {
            stops.splice(0, ia + 1);
            from = loc.a;
          } else if (loc.kind === 'between' && loc.b) {
            const ib = stops.findIndex(s => s[0] === loc.b);
            if (ib > 0) stops.splice(0, ib);
          } else if (loc.kind === 'at' && ia > 0) {
            stops.splice(0, ia);
          }
        }
        // Drop leading stops well in the past when later ones exist.
        while (stops.length > 1 && stops[0][1] < now - 60_000 && stops[1][1] < now + 30_000) stops.shift();
        const s1 = stops[0][0], s2 = stops[1]?.[0];
        if (!from && loc) {
          if (loc.kind === 'between') from = loc.a;
          else if ((loc.kind === 'left' || loc.kind === 'at' || loc.kind === 'near') && loc.a !== s1) from = loc.a;
        }
        if (from === s1) from = null;
        if (from && hop(g, from, s1) > 3) from = null;
        if (!from) {
          // Graph fallback: the neighbour of s1 that lies "behind" it.
          const back = [...g.adj.get(s1)].filter(n => !s2 || hop(g, n, s2) > hop(g, s1, s2));
          if (back.length === 1) from = back[0];
          else if (back.length > 1 && loc?.a && back.includes(loc.a)) from = loc.a;
          else if (back.length > 1) from = null; // junction, unknown branch: show at/near s1
        }

        // 4. Estimate when it left `from`, calibrating speed on the next leg.
        let speed = 11; // m/s, typical average including acceleration
        if (s2) {
          const dt = (stops[1][1] - stops[0][1]) / 1000 - 25;
          const d = distM(s1, s2);
          if (dt > 20) speed = Math.min(22, Math.max(7, d / dt));
        }
        let fromT = null;
        if (from) {
          const travel = distM(from, s1) / speed * 1000 + 5_000;
          fromT = stops[0][1] - travel;
          if (loc?.kind === 'at' && loc.a === from) fromT = Math.max(fromT, Math.min(now, stops[0][1] - 15_000));
        }

        const observedAt = Math.max(...chain.map(p => p.ts));
        trains.push({
          id: ci ? `${key}#${ci + 1}` : key,
          line: lineId,
          vehicleId: chain[0].vehicleId.trim(),
          destination: chain[0].destinationNaptanId || null,
          destinationName: cleanName(chain[0].destinationName || chain[0].towards || ''),
          towards: chain[0].towards || '',
          platform: chain[0].platformName || '',
          location: freshest.currentLocation || '',
          from, fromT,
          stops: stops.slice(0, 10),
          observedAt,
        });
      });
    }
    return { trains, stats: { predictions: predictions.length, trains: trains.length, unidentified, unknownStation, split } };
  };
}

export function stationArrivals(predictions, ids, now = Date.now()) {
  const want = new Set(ids);
  return predictions
    .filter(p => want.has(p.naptanId))
    .map(p => ({
      line: p.lineId,
      vehicleId: (p.vehicleId || '').trim(),
      station: p.naptanId,
      platform: p.platformName,
      destination: cleanName(p.destinationName || p.towards || ''),
      towards: p.towards,
      location: p.currentLocation,
      t: Date.parse(p.expectedArrival),
    }))
    .filter(a => a.t > now - 30_000)
    .sort((a, b) => a.t - b.t);
}

export function cleanName(n) {
  return n.replace(/ Underground Station$/, '').replace(/-Underground$/, '').replace(/ \([^)]*(Line|Bakerloo)[^)]*\)$/i, '').trim();
}

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ underground station$/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/&/g, ' and ')
    .replace(/\bst\.?\b/g, 'st')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
