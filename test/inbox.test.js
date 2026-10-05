// The smart Inbox: lanes by what the owner is doing, a readable order (priority, tasks waiting, real waiting time),
// "Do first", and snoozes that never hide what protects production and come back when the decision changes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arrange, reasons, isProtected, versionOf, laneOf } from '../public/inbox.js';
import { board } from '../public/attention.js';

const T = (key, extra = {}) => ({ key, title: key, status: 'todo', priority: 'P2', updated_at: '2026-10-05T00:00:00Z', ...extra });
const row = (id, kind, t) => ({ id, key: t.key, kind, verb: `${kind} ${t.key}`, ticket: t });
const NOW = Date.parse('2026-10-05T12:00:00Z');

test('lanes and order: priority, then tasks waiting (each once), then the real waiting time', () => {
  const a = T('A-1', { priority: 'P3' }), b = T('A-2', { priority: 'P1' }), c = T('A-3'), d = T('A-4'), m = T('A-5'), r = T('A-6');
  const waiter = T('A-9', { parent_key: null, after_key: 'A-3' });
  const tickets = [a, b, c, d, m, r, waiter];
  const rows = [row('q1', 'question', a), row('q2', 'question', b), row('q3', 'question', c), row('q4', 'question', d), row('m1', 'merge', m), row('r1', 'research', r)];
  rows[2].waiting = [{ key: 'A-9', name: 'x', id: 'A-9:question' }]; // the same task through the graph and folding counts once
  const since = { q1: '2026-10-05T01:00:00Z', q2: '2026-10-05T11:00:00Z', q3: '2026-10-05T11:30:00Z', q4: '2026-10-05T02:00:00Z', m1: '2026-10-04T00:00:00Z', r1: '2026-10-01T00:00:00Z' };
  const out = arrange(rows, { tickets, since, now: NOW });
  assert.deepEqual(out.active.map((x) => x.id), ['q2', 'q3', 'q4', 'q1', 'm1', 'r1']);
  assert.equal(out.active.find((x) => x.id === 'q3').waits, 1);
  assert.equal(out.doFirst, 'q2');
  assert.deepEqual(reasons(out.active[0], NOW), ['P1', 'waiting 1 h']);
  assert.equal(laneOf({ kind: 'owner_task' }), 'mine'); assert.equal(laneOf({ kind: 'research' }), 'proposals');
});

test('Do first: a publish guard or a P0 jumps every lane', () => {
  const g = T('G-1'), o = T('G-2', { priority: 'P0' }), q = T('G-3', { priority: 'P1' });
  assert.equal(arrange([row('q', 'question', q), row('g', 'guard', g)], { tickets: [g, q], now: NOW }).doFirst, 'g');
  assert.equal(arrange([row('q', 'question', q), row('o', 'owner_task', o)], { tickets: [o, q], now: NOW }).doFirst, 'o');
});

test('snooze: hides until the time or until the decision changes; never a guard, page or incident ticket', () => {
  const t = T('S-1', { status: 'needs_human', progress_msg: 'Which?' });
  const r = row('S-1:question', 'question', t);
  const later = '2026-10-06T09:00:00Z';
  let out = arrange([r], { tickets: [t], snoozes: { 'S-1:question': { until: later, version: versionOf(r) } }, now: NOW });
  assert.equal(out.active.length, 0); assert.equal(out.snoozed[0].snoozed_until, later);
  out = arrange([r], { tickets: [t], snoozes: { 'S-1:question': { until: '2026-10-05T11:00:00Z', version: versionOf(r) } }, now: NOW });
  assert.equal(out.active.length, 1, 'its time passed');
  const changed = { ...r, ticket: { ...t, progress_msg: 'A new question' } };
  out = arrange([changed], { tickets: [changed.ticket], snoozes: { 'S-1:question': { until: later, version: versionOf(r) } }, now: NOW });
  assert.equal(out.active.length, 1, 'a new question brings it back');
  assert.ok(isProtected({ kind: 'guard' })); assert.ok(isProtected({ kind: 'page' }));
  assert.ok(isProtected(r, [{ ticket_key: 'S-1', status: 'paged' }]), 'an SRE-paged ticket is protected even as a question');
  out = arrange([r], { tickets: [t], incidents: [{ ticket_key: 'S-1', status: 'ticketed' }], snoozes: { 'S-1:question': { until: later, version: versionOf(r) } }, now: NOW });
  assert.equal(out.active.length, 1, 'an existing snooze cannot hide an incident');
});

test('board: counts describe what is shown; every decision stays reachable', () => {
  const t = T('B-1', { status: 'needs_human', assignee: 'junior' });
  const st = { tickets: [t], agents: [], events: [], meta: {} };
  const id = board(st).needs_you[0].id;
  const b = board({ ...st, meta: { snoozes: { [id]: { until: '2999-01-01T00:00:00Z', version: versionOf(board(st).needs_you[0]) } } } });
  assert.equal(b.counts.needs_you, 0); assert.equal(b.counts.snoozed, 1);
  assert.equal(b.decisions.length, 1, 'the ticket sheet still finds its decision');
});

let store, inboxState;
before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-inbox-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ project: { repoPath: tmp }, github: { sync: false } }));
  process.env.SIGMADESK_CONFIG = path.join(tmp, 'config.json');
  store = await import('../src/db.js'); store.openDb(':memory:');
  inboxState = await import('../src/inbox-state.js');
});

test('server: waiting time starts when the decision appears and survives ticket edits; snoozes are validated', () => {
  const since1 = inboxState.trackSince([{ id: 'x' }], '2026-10-05T01:00:00.000Z');
  const since2 = inboxState.trackSince([{ id: 'x' }, { id: 'y' }], '2026-10-05T05:00:00.000Z');
  assert.equal(since2.x, since1.x); assert.equal(since2.y, '2026-10-05T05:00:00.000Z');
  assert.deepEqual(Object.keys(inboxState.trackSince([{ id: 'y' }])), ['y'], 'gone decisions are forgotten');
  const q = row('Q-1:question', 'question', T('Q-1', { status: 'needs_human' }));
  const g = row('G-1:guard', 'guard', T('G-1'));
  const ctx = { decisions: [q, g], now: NOW };
  assert.throws(() => inboxState.setSnooze({ id: 'nope', until: '2026-10-06T00:00:00Z' }, ctx), /no longer in your Inbox/);
  assert.throws(() => inboxState.setSnooze({ id: 'G-1:guard', until: '2026-10-06T00:00:00Z' }, ctx), /protects production/);
  assert.throws(() => inboxState.setSnooze({ id: 'Q-1:question', until: '2026-10-05T00:00:00Z' }, ctx), /future/);
  assert.throws(() => inboxState.setSnooze({ id: 'Q-1:question', until: '2027-10-05T00:00:00Z' }, ctx), /At most 30 days/);
  const s = inboxState.setSnooze({ id: 'Q-1:question', until: '2026-10-06T09:00:00Z' }, ctx);
  assert.equal(s.version, versionOf(q));
  assert.ok(inboxState.snoozes(new Set(['Q-1:question']), NOW)['Q-1:question']);
  inboxState.setSnooze({ id: 'Q-1:question', until: null }, ctx);
  assert.deepEqual(inboxState.snoozes(null, NOW), {});
});
