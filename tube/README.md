# Underground Live

Live London Underground map. Every train on the 11 lines is rebuilt from TfL arrival predictions and animated on a network drawn from scratch.

```
npm start               # local dev server: http://localhost:8787 (also prints a URL for your phone)
npm run build:site      # assemble ../dist: personal site + Tube Live at /tube/ (plain static files)
npm run build:network   # regenerate public/data/network.json from TfL
```

**The app is fully static.** TfL's API allows cross-origin requests, so the page fetches live data and reconstructs train positions in the browser (`public/data.js` and `public/shared/reconstruct.mjs`). `public/` can be hosted on any static host, in any subfolder. Each visitor uses TfL's anonymous rate limit, which is ample at one request every 25 s.

The Node server in `server/` is optional, for local development. It still exposes `/api/*` and keeps an optional `TFL_APP_KEY` server-side, if you ever want a shared, cached backend.

## Layout

| Layer | File | Role |
|---|---|---|
| Ingestion | `public/data-worker.js` (via `public/data.js`) | Fetches and parses TfL in a Web Worker, so the animation never stalls; one cached arrivals snapshot feeds the trains and every station board |
| Reconstruction | `public/shared/reconstruct.mjs` | Turns predictions into trains: `from` station, then upcoming stops with times |
| Network | `scripts/build-network.mjs` | Stations and track edges from TfL (cached in `scripts/.cache`, `--refresh` to re-download) |
| Layout | `scripts/layout.mjs` | Octilinear schematic layout, computed offline |
| Rendering & UI | `public/model.js`, `public/app.js` | Canvas renderer (cached map + label layers, live trains every frame), map-style label placement, gestures, search, bottom sheet |
| Home-screen app | `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` | Install to Home Screen, offline-cached app shell |

## What the TfL data actually provides (tested Nov 2026)

- **`/Mode/tube/Arrivals?count=-1`**: one request returns about 3,800 predictions for all 11 lines, roughly 380 trains. It's CDN-cached for about 30 s, so the server polls it every 20 s at most. Station panels are served from the same snapshot and cost no extra TfL calls.
- **No GPS and no track positions.** Each prediction gives `vehicleId`, station, `expectedArrival`, destination, platform, and a free-text `currentLocation` ("Between Oval and Kennington", "At Euston Platform 2").
- **`vehicleId` is the train's set number.** It is unique within a line at a given moment, but it isn't a permanent hardware ID. About 2% of predictions have no ID or `000` and are skipped. Occasionally two trains share an ID; these are split by checking whether the stops are physically consistent.
- **Platform names aren't reliable for direction.** The bound flips along a route (Circle, Metropolitan), so trains are chained using the line graph instead.
- **Predictions are noisy.** They are sometimes out of order, and they linger after a train has left a station. Stops are re-ordered by distance along the line, arrival times are forced to be monotonic, and stops the train has passed are cut using `currentLocation`.
- **TrackerNet** (`/trackernet/PredictionSummary`, `PredictionDetailed`) needs a subscription key. It returns 401 without one, so it isn't used yet.
- **No push mechanism** (no WebSocket or SSE) for tube data. Polling is the only option.
- **Line status** comes from `/Line/Mode/tube/Status` (polled every 60 s).

## How positions are estimated

For each train the server sends `from` (the last station, parsed from `currentLocation` or inferred from the graph) and the upcoming stops with arrival times. The client builds a timeline:

- it dwells at each station for at least about 20 s,
- it leaves early enough to cover the distance at about 11 m/s,
- it arrives at TfL's predicted time.

Between stations the marker moves along that timeline. When new data arrives, the marker eases to the corrected position over about a second instead of jumping.

How estimates are shown:

- Every position is an interpolation. The UI says so in the footer and in the train panel.
- A **hollow** marker means the previous station is unknown (often at a junction or a terminus). The train is drawn at its next stop.
- A **faded** marker means TfL hasn't updated the train for more than 3 minutes.

## Schematic layout

Built offline in `scripts/layout.mjs`:

1. **Projection.** Stations are projected around Charing Cross with logarithmic radial compression (`LAYOUT_R`, default 3500 m) to make room for central London.
2. **Relaxation.** A force-based pass nudges edges towards 45° multiples.
3. **Skeleton.** The network is split into *chains*: runs of stations between junctions or line termini. Only the chain ends are optimised. Direct links are snapped to exact 45° multiples in a fixed direction, so stations can't swap sides (Ealing Broadway stays west of Ealing Common). Two links leaving the same station never share a direction.
4. **Routing.** Each chain is drawn as a straight run, an L, Z or S route, or a detour. The detour is only used when two chains share both end stations, such as the Hainault loop. A station sits on every bend, so each drawn segment is exactly 45° or 90°. Routes are scored on staying close to the real shape, overlap with already-drawn lines, crossings and the number of bends.

The build prints diagnostics. Currently: 299 of 312 segments on exact angles, 12 crossings, minimum station spacing 125.
