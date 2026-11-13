// Renders the app icons (PNG) with no dependencies: a few thick octilinear
// "lines" meeting at an interchange, Mini Metro style.
// Run: node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const BG = hex('#101114');

// Shapes in a 100×100 design space.
const lines = [
  { c: hex('#E32017'), w: 8, pts: [[-10, 50], [110, 50]] },                              // red: straight across
  { c: hex('#0098D4'), w: 8, pts: [[26, -10], [26, 26], [50, 50], [50, 110]] },           // blue: down, diagonal, down
  { c: hex('#FFD300'), w: 8, pts: [[74, -10], [74, 26], [50, 50], [26, 74], [-10, 74]] }, // yellow: down, diagonal, across
];
const station = { x: 50, y: 50, r: 12, ring: 4 };

function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function shade(x, y, maskable) {
  // maskable icons need content within the central 80% safe zone
  const s = maskable ? 0.8 : 1;
  x = (x - 50) / s + 50; y = (y - 50) / s + 50;
  let col = BG;
  for (const l of lines) {
    for (let i = 1; i < l.pts.length; i++) if (distSeg(x, y, l.pts[i - 1], l.pts[i]) < l.w / 2) { col = l.c; break; }
  }
  const d = Math.hypot(x - station.x, y - station.y);
  if (d < station.r) col = d > station.r - station.ring ? [245, 245, 245] : BG;
  return col;
}

function png(size, maskable) {
  const SS = 4; // supersampling for anti-aliasing
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade(((x + (sx + 0.5) / SS) / size) * 100, ((y + (sy + 0.5) / SS) / size) * 100, maskable);
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3, n = SS * SS;
      raw[o] = r / n; raw[o + 1] = g / n; raw[o + 2] = b / n;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

for (const [name, size, maskable] of [['apple-touch-icon.png', 180, false], ['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['favicon-32.png', 32, false]]) {
  writeFileSync(new URL(name, OUT), png(size, maskable));
  console.log('wrote', name);
}
