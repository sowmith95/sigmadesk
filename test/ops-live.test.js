// Opt-in, against a THROWAWAY TimescaleDB that scripts/provision-role.sql has been run on (never production):
//   SIGMADESK_OPS_LIVE_PG=127.0.0.1:55433 SIGMADESK_OPS_LIVE_PASSWORD=<sigmadesk_ro password> \
//   SIGMADESK_OPS_LIVE_PSQL=/opt/homebrew/opt/libpq/bin/psql node --test test/ops-live.test.js
// Runs the real desk ops DB probes through the real host psql, a pgpass file and the read-only role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIVE = process.env.SIGMADESK_OPS_LIVE_PG || '';
const skip = !LIVE && 'set SIGMADESK_OPS_LIVE_PG=host:port of a throwaway provisioned TimescaleDB to run';
const [host, port] = LIVE.split(':');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-ops-live-'));
let ops, access, store, config;

before(async () => {
  if (skip) return;
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const pgpass = path.join(tmp, 'pgpass');
  fs.writeFileSync(pgpass, ['trading_ts', 'trading_app'].map((db) => `${host}:${port}:${db}:sigmadesk_ro:${process.env.SIGMADESK_OPS_LIVE_PASSWORD}`).join('\n') + '\n', { mode: 0o600 });
  const cfg = path.join(tmp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    project: { name: 'live', repoPath: repo, githubRepo: '', ticketPrefix: 'L' }, github: { sync: false },
    ops: { enabled: true, psql: process.env.SIGMADESK_OPS_LIVE_PSQL || 'psql', pgpassFile: pgpass,
      databases: { timescale: { host, port: Number(port), dbname: 'trading_ts', user: 'sigmadesk_ro' }, app: { host, port: Number(port), dbname: 'trading_app', user: 'sigmadesk_ro' } },
      freshness: [{ label: 'bar_ticks 1s', db: 'timescale' }, { label: 'bar_ticks_1s', db: 'timescale' }, { label: 'whale_trades', db: 'timescale' }, { label: 'bars_1m', db: 'timescale' }] },
  }));
  process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_DB = ':memory:';
  ({ config } = await import('../src/config.js'));
  store = await import('../src/db.js'); store.openDb(':memory:');
  ops = await import('../src/ops.js'); access = await import('../src/access.js');
  ops.setNow(() => new Date('2026-10-03T15:00:00Z')); // off hours: normal limits
  store.setSetting('ops_enabled', 'true');
  access.ownerGrant({ seat: 'sre', probes: ['*'], minutes: 60, reason: 'live test' });
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const run = () => store.createRun({ agent_id: 'sre', kind: 'investigate', token: `tok-${Math.random()}`, model: 'x' });

test('live: ingest_freshness through the SECURITY DEFINER function returns every source', { skip }, async () => {
  const out = await ops.handle(run(), { probe: 'ingest_freshness', minutes: '120' });
  assert.match(out, /outcome="ok"/, out);
  for (const label of ['bar_ticks 1s', 'bar_ticks_1s', 'whale_trades', 'bars_1m']) assert.match(out, new RegExp(`^${label}\\t\\d{4}-`, 'm'), out);
  console.log(out);
});
test('live: db_health on both databases', { skip }, async () => {
  for (const db of ['timescale', 'app']) {
    const out = await ops.handle(run(), { probe: 'db_health', db });
    assert.match(out, /outcome="ok"/, out);
    assert.match(out, /# sessions by state and application/);
    assert.match(out, /# database/);
    console.log(out.split('\n').slice(0, 12).join('\n'));
  }
});
test('live: timescale_jobs', { skip }, async () => {
  const out = await ops.handle(run(), { probe: 'timescale_jobs', db: 'timescale' });
  assert.match(out, /outcome="ok"/, out);
  assert.match(out, /# jobs[\s\S]*# continuous aggregates[\s\S]*bars_1m/);
  console.log(out.split('\n').slice(0, 14).join('\n'));
});
