// Assembles the static website to deploy:
//   dist/            ← the personal site (top-level files of "Personal Site")
//   dist/tube/       ← Tube Live (tube/public), served as plain static files
// Run: node scripts/build-site.mjs
//
// Markdown notes and dot-folders are not published.

import { cp, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SITE = fileURLToPath(new URL('../../', import.meta.url));
const DIST = join(SITE, 'dist');
const SKIP = new Set(['dist', 'tube', 'node_modules']);

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const published = [];
for (const entry of await readdir(SITE, { withFileTypes: true })) {
  if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.name.endsWith('.md')) continue;
  await cp(join(SITE, entry.name), join(DIST, entry.name), { recursive: true });
  published.push(entry.name + (entry.isDirectory() ? '/' : ''));
}
await cp(fileURLToPath(new URL('../public/', import.meta.url)), join(DIST, 'tube'), { recursive: true });
published.push('tube/');
await writeFile(join(DIST, '.nojekyll'), ''); // GitHub Pages: serve files as-is

console.log(`dist/ ready: ${published.join(', ')}`);
