// "Your step": every hold names the owner's one step (or says the desk is on it), merges the desk does by itself
// never ask the owner, a failed deploy asks once, and the program update reads from the same board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board } from '../public/attention.js';
import { arrange, isProtected } from '../public/inbox.js';
import { programUpdate } from '../public/program.js';

const T = (key, status, extra = {}) => ({ key, status, title: `Fix ${key} thing`, updated_at: '2026-10-05T00:00:00Z', ...extra });
const kindOf = (b, key) => b.needs_you.find((d) => d.key === key)?.kind;

test('each hold has its own kind and step; anything unknown stays a question', () => {
  const tickets = [
    T('H-1', 'needs_human', { progress_msg: 'merge conflict needs your call' }),
    T('H-2', 'needs_human', { progress_msg: 'no eligible code reviewer' }),
    T('H-3', 'needs_human', { progress_msg: 'base changed — refresh and rerun QA' }),
    T('H-4', 'needs_human', { progress_msg: 'remote branch changed — reconcile before publishing' }),
    T('H-5', 'needs_human', { progress_msg: 'QA failed repeatedly' }),
    T('H-6', 'needs_human', { progress_msg: 'Which index should I use?', assignee: 'junior' }),
    T('H-7', 'needs_human', { progress_msg: 'workspace setup failed: disk full' }),
  ];
  const b = board({ agents: [{ id: 'junior', name: 'Sage Kim' }], tickets, events: [], meta: {} });
  assert.deepEqual(['H-1', 'H-2', 'H-3', 'H-4', 'H-5', 'H-6', 'H-7'].map((k) => kindOf(b, k)), ['conflict', 'setup', 'refresh', 'refresh', 'stuck', 'question', 'setup']);
  assert.match(b.needs_you.find((d) => d.key === 'H-3').verb, /^Refresh .* onto the latest code$/);
  assert.equal(b.needs_you.find((d) => d.key === 'H-6').verb, 'Answer Sage');
  assert.equal(b.needs_you.find((d) => d.key === 'H-7').reason.includes('workspace'), true);
});

test('the guard says why it held the commit; a stale record for another commit is not shown', () => {
  const t = T('G-1', 'needs_human', { progress_msg: 'publish guard: needs owner approval', head_sha: 'b'.repeat(40) });
  const b = board({ tickets: [t], meta: { guard_reasons: { 'G-1': { head: 'b'.repeat(40), reasons: ['411 changed lines (cap 400 for S)'] } } } });
  const g = b.needs_you[0];
  assert.equal(g.kind, 'guard'); assert.match(g.verb, /^Approve publishing /); assert.match(g.reason, /411 changed lines/);
  assert.equal(b.do_first, g.id);
  assert.doesNotMatch(board({ tickets: [t], meta: {} }).needs_you[0].reason, /411/);
  // A record for the previous commit (the stream moved head_sha before the next snapshot) is not this commit's reason.
  const stale = board({ tickets: [t], meta: { guard_reasons: { 'G-1': { head: 'a'.repeat(40), reasons: ['old reason'] } } } });
  assert.doesNotMatch(stale.needs_you[0].reason, /old reason/);
});

test('a merge the desk does by itself never needs the owner; held and owner merges do', () => {
  const pr = (k) => T(k, 'ready_for_human', { pr_url: `https://github.com/o/r/pull/${k.slice(2)}` });
  const tickets = [pr('M-1'), pr('M-2'), pr('M-3'), pr('M-4'), pr('M-5'), pr('M-6')];
  const b = board({ tickets, meta: { merge_states: { 'M-1': 'queued', 'M-2': 'scheduled', 'M-3': 'merging', 'M-4': 'held', 'M-5': 'owner', 'M-6': 'conflict' } } });
  assert.deepEqual(b.needs_you.map((d) => d.key).sort(), ['M-4', 'M-5']);
  assert.match(b.needs_you.find((d) => d.key === 'M-4').verb, /you paused it/);
  assert.deepEqual(b.queued.map((x) => x.key).sort(), ['M-1', 'M-2', 'M-3', 'M-6']);
  assert.match(b.queued.find((x) => x.key === 'M-2').reason, /after the busy hours/);
  // Without a merge state (train off, or not yet seen) the owner keeps the merge.
  assert.equal(board({ tickets: [pr('M-7')], meta: {} }).needs_you[0].kind, 'merge');
});

test('a failed or unconfirmed deploy asks the owner once, first, and cannot be snoozed', () => {
  const tickets = [T('D-1', 'done', { pr_url: 'https://github.com/o/r/pull/3' }), T('D-2', 'needs_human', { progress_msg: 'Which?' })];
  const lock = { state: 'failed', key: 'D-1', merge_sha: 'c'.repeat(40), note: 'Deploy run 42 failed' };
  const b = board({ tickets, meta: { deploy_lock: lock, snoozes: { [`deploy:${'c'.repeat(40)}:failed`]: { until: '2099-01-01T00:00:00Z', version: 'x' } } } });
  const d = b.needs_you.find((x) => x.kind === 'deploy');
  assert.ok(d, 'the deploy is a decision'); assert.match(d.verb, /deploy of .* failed/); assert.match(d.reason, /Deploy run 42 failed/);
  assert.ok(isProtected(d)); assert.equal(b.counts.snoozed, 0);
  assert.equal(b.decisions[0].kind, 'deploy');
  assert.equal(board({ tickets, meta: { deploy_lock: { ...lock, state: 'running' } } }).needs_you.some((x) => x.kind === 'deploy'), false, 'a running deploy is the desk\'s');
  assert.match(board({ tickets, meta: { deploy_lock: { ...lock, state: 'escalated' } } }).needs_you.find((x) => x.kind === 'deploy').verb, /never confirmed/);
});

test('a publish that fails is the desk\'s until it keeps failing', () => {
  const t = T('P-1', 'ready_for_human', { pr_url: 'https://github.com/o/r/pull/8', head_sha: 'e'.repeat(40) });
  const ms = { 'P-1': 'queued' };
  const once = board({ tickets: [t], meta: { merge_states: {}, publish_errors: { 'P-1': { head: t.head_sha, message: 'network down', count: 1 } } } });
  assert.equal(once.counts.needs_you, 0, 'the PR holds an older commit while the desk retries: nothing to merge yet');
  assert.match(once.queued[0].reason, /network down/);
  const q = board({ tickets: [{ ...t, status: 'review' }], meta: { publish_errors: { 'P-1': { head: t.head_sha, message: 'network down', count: 1 } } } });
  assert.equal(q.queued[0].key, 'P-1'); assert.match(q.queued[0].reason, /network down.*retries/);
  const stuck = board({ tickets: [{ ...t, status: 'review' }], meta: { merge_states: ms, publish_errors: { 'P-1': { head: t.head_sha, message: 'auth failed', count: 3 } } } });
  assert.equal(stuck.blocked[0].key, 'P-1'); assert.match(stuck.blocked[0].verb, /keeps failing/); assert.match(stuck.blocked[0].reason, /3 times/);
});

test('new kinds sort sensibly: a deploy and a conflict jump questions; time hints exist', () => {
  const rows = [{ id: 'q', kind: 'question', ticket: T('A-1', 'needs_human') }, { id: 'd', kind: 'deploy', ticket: T('A-2', 'done') }];
  const out = arrange(rows, { now: Date.parse('2026-10-05T12:00:00Z') });
  assert.equal(out.doFirst, 'd');
  assert.ok(out.active.every((r) => r.time_hint), 'every kind says how long it takes');
});

test('the program update: shipped, working, stuck with reasons, and the one thing to do first', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const tickets = [
    T('S-1', 'done', { done_at: '2026-10-05T08:00:00Z' }), T('S-2', 'done', { done_at: '2026-09-01T08:00:00Z', updated_at: '2026-10-05T11:00:00Z' }), // S-2: renamed today, shipped last month
    T('S-3', 'in_progress', { assignee: 'junior' }), T('S-4', 'todo'),
    T('S-5', 'needs_human', { progress_msg: 'publish guard: needs owner approval' }),
  ];
  const state = { agents: [{ id: 'junior', name: 'Sage Kim', status: 'working', current_ticket: 'S-3' }], tickets, events: [],
    meta: { scheduler: { waiting: [{ key: 'S-4', reason: 'Credits or rate limit reached' }] } } };
  const p = programUpdate(state, board(state, { now }), now);
  assert.equal(p.shipped, 1); assert.equal(p.stuck, 1); assert.equal(p.needs, 1);
  const text = p.lines.map((l) => l.text).join('\n');
  assert.match(text, /Shipped in the last 24 h: .*S-1/); assert.doesNotMatch(text, /S-2/);
  assert.match(text, /1 being worked on now/);
  assert.match(text, /Stuck without you: .*Credits or rate limit reached/);
  assert.match(text, /1 needs you; first: Approve publishing/);
  assert.deepEqual(p.lines.find((l) => l.tone === 'needs').keys, ['S-5']);
  const quiet = programUpdate({ tickets: [], meta: {} }, board({ tickets: [], meta: {} }), now);
  assert.match(quiet.lines.map((l) => l.text).join(' '), /Nothing shipped .* Nothing needs you right now/);
});

test('review findings: every desk hold message has its step, free text is not misread, a refresh is the desk\'s', () => {
  const tickets = [
    T('R-1', 'needs_human', { progress_msg: 'CI failed (review loop limit)' }),
    T('R-2', 'needs_human', { progress_msg: 'predecessor SD-3 closed unmerged' }),
    T('R-3', 'needs_human', { progress_msg: 'Reviewers and Rowan disagree — your call' }),
    T('R-4', 'needs_human', { progress_msg: 'Sage Kim is switched off' }),
    T('R-5', 'needs_human', { progress_msg: 'The nightly cron is switched off, should I enable it?', assignee: 'junior' }),
    T('R-6', 'needs_human', { progress_msg: 'desk refreshing remote base', active_run: -1 }),
  ];
  const b = board({ agents: [{ id: 'junior', name: 'Sage Kim' }], tickets, meta: {} });
  assert.deepEqual(['R-1', 'R-2', 'R-3', 'R-4', 'R-5'].map((k) => kindOf(b, k)), ['stuck', 'stuck', 'conflict', 'setup', 'question']);
  assert.equal(kindOf(b, 'R-6'), undefined, 'nothing to do while the desk refreshes');
  assert.equal(b.working.find((x) => x.key === 'R-6').stage, 'Refreshing');
});

test('a merge waiting on the owner only says "risk or policy" when the train said so; a deploy without a ticket still reads', () => {
  const t = T('W-1', 'ready_for_human', { pr_url: 'https://github.com/o/r/pull/11' });
  assert.doesNotMatch(board({ tickets: [t], meta: {} }).needs_you[0].reason, /risk or policy/);
  assert.match(board({ tickets: [t], meta: { merge_states: { 'W-1': 'owner' } } }).needs_you[0].reason, /risk or policy/);
  const d = board({ tickets: [], meta: { deploy_lock: { state: 'escalated', key: null, merge_sha: null, id: 'L9' } } }).needs_you[0];
  assert.equal(d.name, 'the last merge'); assert.equal(d.id, 'deploy:L9:escalated'); assert.match(d.verb, /the last merge was never confirmed/);
});

test('Codex findings: a retry beats an automatic merge, desk holds are not "you paused it", owner reasons are said', () => {
  const head = 'e'.repeat(40);
  const t = T('C-1', 'ready_for_human', { pr_url: 'https://github.com/o/r/pull/21', head_sha: head });
  const retry = board({ tickets: [t], meta: { merge_states: { 'C-1': 'queued' }, publish_errors: { 'C-1': { head, message: 'push rejected', count: 1 } } } });
  assert.match(retry.queued[0].reason, /push rejected/, 'the PR holds an older commit: the retry is what is happening');
  const old = board({ tickets: [t], meta: { merge_states: { 'C-1': 'queued' }, publish_errors: { 'C-1': { head: 'd'.repeat(40), message: 'push rejected', count: 5 } } } });
  assert.equal(old.queued[0].reason, 'Approved; the desk merges it when CI and the deploy allow', 'an error about an earlier commit is ignored');
  const foreign = board({ tickets: [{ ...t, merge_hold: 'the PR branch changed outside the desk (abc1234)' }], meta: { merge_states: { 'C-1': 'held' } } }).needs_you[0];
  assert.match(foreign.verb, /^Check the branch of /); assert.doesNotMatch(foreign.verb, /you paused/); assert.match(foreign.reason, /changed outside the desk/);
  const guarded = board({ tickets: [{ ...t, merge_hold: 'publish guard: 900 changed lines' }], meta: { merge_states: { 'C-1': 'held' } } }).needs_you[0];
  assert.match(guarded.verb, /^Review the protected update/);
  const mine = board({ tickets: [{ ...t, merge_hold: 'held by the owner' }], meta: { merge_states: { 'C-1': 'held' } } }).needs_you[0];
  assert.match(mine.verb, /you paused it/);
  const stalled = board({ tickets: [t], meta: { merge_states: { 'C-1': 'owner' }, merge_reasons: { 'C-1': 'the desk has waited 7 h: CI coverage needs your waiver' } } }).needs_you[0];
  assert.match(stalled.reason, /waited 7 h: CI coverage needs your waiver/);
  assert.match(board({ tickets: [T('C-2', 'needs_human', { progress_msg: 'no eligible code reviewer' })], meta: {} }).needs_you[0].reason, /Switch a reviewer seat on/);
});
