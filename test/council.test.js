import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-council-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg;

let store, council, dispatch;
before(async () => {
  const { config } = await import('../src/config.js');
  config.root = tmp;
  store = await import('../src/db.js');
  store.openDb(':memory:');
  council = await import('../src/council.js');
  dispatch = await import('../src/dispatch.js');
});

test('council reviews support all eligible engines with council_review capability', () => {
  const engines = [...new Set(council.models().map((m) => m.engine))];
  assert.ok(engines.includes('claude'));
  assert.ok(engines.includes('codex'));
  assert.ok(engines.includes('perplexity'), 'Perplexity models are available for council review');
});
