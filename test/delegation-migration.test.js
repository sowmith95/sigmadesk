// Delegation (#9) on an existing desk: a database the desk created before delegation existed (test/fixtures/
// pre-delegation.sql, built by main at eebced8 with its own openDb and store API, synthetic rows only) is upgraded in
// place by openDb. Pins the additive migration (new columns, the records table, settings defaults), that nothing the
// old desk wrote is changed or delegated, and that opening it again is a no-op.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-migrate-')));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'SD' }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

const file = path.join(tmp, 'pre-delegation.db');
let config, store, delegation, attention, before_;
before(async () => {
  { // the old desk's database, exactly as it left it
    const db = new DatabaseSync(file);
    db.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'pre-delegation.sql'), 'utf8'));
    before_ = { tickets: db.prepare('SELECT * FROM tickets ORDER BY id').all(), settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name) };
    db.close();
  }
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js');
  delegation = await import('../src/delegation.js'); attention = await import('../public/attention.js');
  store.openDb(file);
});
after(() => { try { store.handle().close(); } catch { /* closed */ } fs.rmSync(tmp, { recursive: true, force: true }); });

const columns = (table) => new Set(store.handle().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

test('migration: the old database gains every delegation column and the records table, with the old rows untouched', () => {
  assert.ok(!before_.tables.includes('delegated_decisions'), 'the fixture predates delegation');
  for (const col of ['hold_kind', 'hold_seat', 'hold_ref', 'hold_scope', 'owner_task_kind', 'owner_task_by']) assert.ok(columns('tickets').has(col), `tickets.${col}`);
  for (const col of ['kind', 'decision_id', 'version', 'policy_version', 'delegation_version', 'mode', 'seat', 'allowed', 'status', 'citables', 'citations', 'reserved_usd', 'brief', 'provenance'])
    assert.ok(columns('delegated_decisions').has(col), `delegated_decisions.${col}`);
  const now = store.listTickets().sort((a, b) => a.id - b.id);
  assert.equal(now.length, before_.tickets.length);
  for (const [i, t] of now.entries()) {
    for (const [k, v] of Object.entries(before_.tickets[i])) assert.deepEqual(t[k], v, `${t.key}.${k} unchanged`);
    for (const col of ['hold_kind', 'hold_seat', 'hold_ref', 'hold_scope', 'owner_task_kind', 'owner_task_by']) assert.equal(t[col], null, `${t.key}.${col} starts empty`);
  }
  assert.equal(store.recentDelegations(10).length, 0);
});

test('migration: settings gain the delegation defaults, keep everything the owner set, and every kind starts in shadow', () => {
  const s = store.getSettings();
  for (const [k, v] of Object.entries(before_.settings)) assert.equal(s[k], v, `${k} kept`);
  assert.deepEqual([s.delegation, s.delegation_escalate_all, s.delegation_epoch], ['', 'false', '0']);
  const pol = delegation.policy();
  assert.deepEqual(Object.values(pol.kinds), ['shadow', 'shadow', 'shadow', 'shadow', 'shadow']);
  assert.deepEqual([pol.peerAccess, pol.escalateAll, pol.enabled], [false, false, true]);
});

test('migration: holds the old desk wrote carry no structured reason, so nothing of them is delegated or changed', () => {
  const q = store.listTickets().find((t) => t.title === 'Normalize equity fills');
  assert.equal(delegation.ticketDecision(q), null, 'a question parked without hold_kind is not a delegable decision');
  const loop = store.listTickets().find((t) => t.title === 'Retry helper');
  assert.equal(delegation.ticketDecision(loop), null, 'neither is a loop hold without one');
  // The board still shows them as the owner's, read the old way.
  const B = attention.board({ tickets: store.listTickets(), agents: [], events: [], settings: { ...store.getSettings(), paused: 'false' }, meta: { delegation: delegation.summary() } });
  assert.ok(B.needs_you.some((d) => d.ticket?.key === q.key || d.key === q.key), 'the old question is still in the Inbox');
  // An old owner task has no kind: the sweep may record it in shadow, but it stays the owner's task.
  const o = store.listTickets().find((t) => t.owner_task);
  const snapshot = JSON.stringify(store.listTickets());
  delegation.sweep({ paused: false });
  const r = store.delegationsForTicket(o.key)[0];
  assert.ok(!r || (r.mode === 'shadow' && r.status === 'escalated' && /nobody said what kind of step it is/.test(r.why)), JSON.stringify(r));
  assert.equal(JSON.stringify(store.listTickets()), snapshot, 'no ticket changed');
  assert.equal(store.kvByPrefix('delegation:owed:').length, 0, 'no notice is owed for anything the old desk announced');
});

test('migration: opening the upgraded database again changes nothing', () => {
  const schema = () => store.handle().prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const was = schema(), settings = store.getSettings();
  store.handle().close();
  store.openDb(file);
  assert.deepEqual(schema(), was);
  assert.deepEqual(store.getSettings(), settings);
});
