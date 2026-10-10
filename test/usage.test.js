import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-usage-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = cfg;
let config, store, usage, dispatch;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  usage = await import('../src/usage.js'); dispatch = await import('../src/dispatch.js');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const window = (usedPercent, windowDurationMins = 10080) => ({ usedPercent, windowDurationMins, resetsAt: Math.floor(Date.now() / 1000) + 86400 });

test('Codex limits preserve unknown windows and identify durations and independent model buckets', () => {
  const q = usage.normalizeCodex({ rateLimitsByLimitId: { premium: { primary: window(100) }, codex: { primary: window(3), secondary: null, planType: 'prolite', credits: { balance: '0', hasCredits: false, unlimited: false } } } });
  assert.equal(q.seven_day, .03); assert.equal(q.five_hour, null); assert.equal(q.active_bucket, 'codex');
  assert.equal(q.windows[1].remaining_percent, 97); assert.equal(q.credits.balance, '0');
  store.kvSet('quota:codex', JSON.stringify(q));
  assert.equal(dispatch.providerHealth().find((p) => p.id === 'codex').ready, true, 'premium limits do not block the base execution model');
  const alternate = usage.normalizeCodex({ rateLimitsByLimitId: { base: { primary: window(90, 60) }, empty: null } });
  assert.equal(alternate.active_bucket, 'base'); assert.equal(alternate.windows.length, 1);
  store.kvSet('quota:codex', JSON.stringify(alternate));
  assert.equal(dispatch.providerHealth().find((p) => p.id === 'codex').ready, false);
  const unknown = usage.normalizeCodex({ rateLimits: { primary: { usedPercent: null }, secondary: null } });
  assert.deepEqual(unknown.windows, []); assert.equal(unknown.five_hour, null); assert.equal(unknown.seven_day, null);
});

test('read-only Codex RPC initializes, requests account limits without model turns, and releases stale holds', async () => {
  const cli = path.join(tmp, 'rpc.mjs'), calls = path.join(tmp, 'calls.jsonl');
  fs.writeFileSync(cli, `#!/usr/bin/env node
import readline from 'node:readline'; import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)}, line + '\\n');
  if (m.method === 'initialize') console.log(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));
  else if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:${JSON.stringify(window(3))}}}}));
});`); fs.chmodSync(cli, 0o755);
  config.engines.codex.bin = cli;
  store.kvSet('provider-hold:codex', JSON.stringify({ until: new Date(Date.now() + 3600000).toISOString(), reason: 'Credits exhausted' }));
  await Promise.all([usage.refresh(), usage.refresh()]);
  assert.equal(usage.status().codex.ok, true); assert.equal(JSON.parse(store.kvGet('quota:codex')).seven_day, .03);
  assert.equal(store.kvGet('provider-hold:codex'), 'null');
  const requests = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l).method);
  assert.deepEqual(requests, ['initialize', 'initialized', 'account/rateLimits/read']);
});

test('usage errors retain the previous limits and unknown limits do not release provider holds', async () => {
  const cli = path.join(tmp, 'error.mjs');
  fs.writeFileSync(cli, `#!/usr/bin/env node
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if(m.id) console.log(JSON.stringify({id:m.id,error:{message:'Authentication required'}}));
});`); fs.chmodSync(cli, 0o755);
  config.engines.codex.bin = cli;
  const before = store.kvGet('quota:codex');
  await usage.refresh(); assert.equal(usage.status().codex.ok, false); assert.equal(store.kvGet('quota:codex'), before);
  assert.match(usage.status().codex.error, /Authentication/);
  const hold = JSON.stringify({ until: new Date(Date.now() + 3600000).toISOString(), reason: 'Credits exhausted' });
  store.kvSet('provider-hold:codex', hold);
  fs.writeFileSync(cli, `#!/usr/bin/env node
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({id:m.id,result:{rateLimitsByLimitId:{codex:{primary:{usedPercent:null}},premium:{primary:${JSON.stringify(window(3))}}}}}));
});`);
  await usage.refresh();
  assert.equal(usage.status().codex.ok, true);
  assert.equal(store.kvGet('provider-hold:codex'), hold, 'another model bucket cannot clear an unknown execution quota');
});

test('Perplexity desktop credits are a validated observed snapshot separate from API funds', () => {
  for (const remaining of [null, '', -1, 'invalid', 1e10]) assert.throws(() => usage.recordDesktop({ remaining }));
  assert.throws(() => usage.recordDesktop({ remaining: 1, used_month: -1 }));
  const q = usage.recordDesktop({ remaining: 44985, used_month: 14.87 });
  assert.equal(q.source, 'Observed desktop snapshot'); assert.equal(q.reset_at, null);
  assert.equal(usage.status().perplexity_desktop.credits_remaining, 44985);
});

test('shutdown stops a Codex usage RPC still running and waits until it has exited, so it writes nothing into the desk afterwards', async () => {
  const cli = path.join(tmp, 'slow.mjs'), pidFile = path.join(tmp, 'rpc.pid');
  // An app-server that never answers and ignores SIGTERM (the real one keeps writing into CODEX_HOME while it shuts down).
  fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.resume(); setInterval(() => {}, 1000);`); fs.chmodSync(cli, 0o755);
  config.engines.codex.bin = cli;
  fs.rmSync(pidFile, { force: true });
  const pending = usage.readCodexLimits().then(() => 'answered', (e) => e.message);
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 30));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(await usage.stopAll(200), 1, 'one RPC was running');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'it has exited by the time stopAll returns');
  assert.match(await pending, /exited before reporting limits/);
  assert.equal(await usage.stopAll(200), 0, 'nothing left to stop');
});
