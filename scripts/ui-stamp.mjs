#!/usr/bin/env node
// Ties the committed UI bundle (public/app) to its sources. `node scripts/ui-stamp.mjs` (run by `npm run build:ui`)
// writes public/app/build.json: a hash of every input (ui/**, vite.config.js, package-lock.json, the public/ modules the
// UI imports, this script) and the name + sha256 of every output file. `--check` exits 1 when an input changed without a
// rebuild, or when an output is missing, extra or altered.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAMP = path.join(ROOT, 'public', 'app', 'build.json');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => !path.basename(f).startsWith('.'));
}
const OUT = path.join(ROOT, 'public', 'app');
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** public/*.js modules the UI imports (relative imports that leave ui/), found by scanning the sources. */
export function sharedInputs() {
  const found = new Set();
  for (const f of files(path.join(ROOT, 'ui')).filter((x) => /\.(jsx?|mjs)$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]((?:\.\.\/)+public\/[\w./-]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (fs.existsSync(target)) found.add(target);
    }
  }
  // Their own relative imports (e.g. conversation.js → runcard.js, prs.js → prs-model.js).
  for (const f of [...found]) for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+['"](\.\/[\w./-]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (fs.existsSync(target)) found.add(target);
  }
  return [...found];
}
export function outputs() {
  if (!fs.existsSync(OUT)) return {};
  return Object.fromEntries(files(OUT).filter((f) => path.basename(f) !== 'build.json').map((f) => [rel(f), sha(fs.readFileSync(f))]).sort(([a], [b]) => a.localeCompare(b)));
}
export function sourceHash() {
  const list = [...files(path.join(ROOT, 'ui')), path.join(ROOT, 'vite.config.js'), path.join(ROOT, 'package-lock.json'), fileURLToPath(import.meta.url), ...sharedInputs()]
    .map(rel).filter((x, i, a) => a.indexOf(x) === i).sort();
  const h = crypto.createHash('sha256');
  for (const rel of list) h.update(rel).update('\0').update(fs.readFileSync(path.join(ROOT, rel))).update('\0');
  return h.digest('hex');
}
export function check() {
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { /* missing */ }
  if (!stamp) return { ok: false, reason: 'public/app/build.json is missing' };
  if (stamp.source !== sourceHash()) return { ok: false, reason: 'the UI sources changed since the bundle was built' };
  const now = outputs(), want = stamp.outputs || {};
  const missing = Object.keys(want).filter((k) => !now[k]), extra = Object.keys(now).filter((k) => !want[k]), altered = Object.keys(want).filter((k) => now[k] && now[k] !== want[k]);
  if (missing.length || extra.length || altered.length) return { ok: false, reason: `bundle files differ from the stamp (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}; altered: ${altered.join(', ') || 'none'})` };
  if (!want['public/app/main.js'] || !want['public/app/main.css']) return { ok: false, reason: 'the stamp lists no main.js/main.css' };
  return { ok: true, stamp };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const r = check();
    console.log(r.ok ? 'UI bundle matches its sources' : `UI bundle is stale: ${r.reason}. Run \`npm run build:ui\` and commit public/app`);
    process.exit(r.ok ? 0 : 1);
  }
  fs.writeFileSync(STAMP, `${JSON.stringify({ source: sourceHash(), outputs: outputs() }, null, 2)}\n`);
  console.log(`stamped ${path.relative(ROOT, STAMP)}`);
}
