import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, outputs, ROOT } from '../scripts/ui-stamp.mjs';

test('the committed UI bundle matches its sources and output inventory', () => {
  const r = check();
  assert.ok(r.ok, r.reason);
  assert.ok(r.stamp.outputs['public/app/main.js'] && r.stamp.outputs['public/app/main.css']);
  assert.ok(Object.keys(r.stamp.outputs).some((k) => k.startsWith('public/app/chunks/')), 'lazy sheets are separate chunks');
});

const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
test('a clean rebuild produces byte-identical output', { skip: !fs.existsSync(vite) && 'vite not installed', timeout: 120_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-ui-build-'));
  try {
    execFileSync(process.execPath, [vite, 'build', '--config', path.join(ROOT, 'vite.config.js'), '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, stdio: 'pipe' });
    const rebuilt = Object.fromEntries(Object.entries(Object.fromEntries((function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); })(out)
      .map((f) => [`public/app/${path.relative(out, f).split(path.sep).join('/')}`, f]))).map(([k, f]) => [k, (fs.readFileSync(f))]));
    const committed = outputs();
    assert.deepEqual(Object.keys(rebuilt).sort(), Object.keys(committed).sort(), 'same files');
    for (const [k, buf] of Object.entries(rebuilt)) assert.equal(require_sha(buf), committed[k], `${k} differs: run npm run build:ui`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
import crypto from 'node:crypto';
function require_sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
