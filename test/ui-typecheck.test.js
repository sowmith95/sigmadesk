// The UI is TypeScript checked with `tsc --noEmit` (Vite strips types without checking them). Skipped when the
// dev dependencies are not installed, like the build test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
test('the UI typechecks', { skip: !fs.existsSync(tsc) && 'typescript not installed', timeout: 180_000 }, () => {
  try { execFileSync(process.execPath, [tsc, '--noEmit', '-p', root], { cwd: root, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { assert.fail(`tsc --noEmit failed:\n${e.stdout || ''}${e.stderr || ''}`); }
});
