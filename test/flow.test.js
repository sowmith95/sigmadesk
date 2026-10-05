// Work order inside an epic: recorded and written gates (public/flow.js), owner tasks, the Inbox's one-question grouping,
// and the manager's epic review (parse, safe apply, one answer for many questions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as flow from '../public/flow.js';
import { board } from '../public/attention.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-flow-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let config, store, sched, review;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  sched = await import('../src/scheduler.js'); review = await import('../src/epic-review.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The live shape that prompted this: an epic whose tasks say "gated on" in text, and one step needs production access.
const T = (key, extra = {}) => ({ key, title: key, description: '', status: 'todo', ...extra });
const tree = () => [
  T('E-1', { status: 'in_progress' }),
  T('E-2', { parent_key: 'E-1', status: 'needs_human', title: 'Verify fills on the production box' }),
  T('E-3', { parent_key: 'E-1', status: 'needs_human', description: 'Contract and DDL. Gated on E-2 reporting nonzero rows.' }),
  T('E-4', { parent_key: 'E-1', description: 'Backfill. Blocked by E-3; after E-2 and E-3 are in.' }),
  T('E-5', { parent_key: 'E-1', description: 'Docs. This unblocks E-4 until the dashboard ships.' }),
];

test('text gates: only keys after the gate word, implied gates dropped, strong wording separate', () => {
  const ts = tree(); const ix = flow.index(ts); const t = (k) => ix.byKey.get(k);
  assert.deepEqual(flow.textGates(t('E-3'), ix), ['E-2']);
  assert.deepEqual(flow.textGates(t('E-4'), ix), ['E-3'], 'E-2 is implied by E-3, so only E-3 is suggested');
  assert.deepEqual(flow.textGates(t('E-5'), ix), [], '"unblocks E-4 until…" names E-4 before the gate word: not a gate');
  const weak = { ...T('E-9', { parent_key: 'E-1', description: 'Run this after E-2 for a fresh sample.' }) };
  const ix2 = flow.index([...ts, weak]);
  assert.deepEqual(flow.textGates(weak, ix2), ['E-2']);
  assert.deepEqual(flow.textGates(weak, ix2, { strong: true }), [], '"after" alone is only a suggestion');
});

test('recorded blockers include an epic\'s own dependency; waiting is transitive; the next step frees the most work', () => {
  const ts = [T('R-1', { status: 'in_progress' }), T('R-2', { parent_key: 'R-1' }), T('R-3', { parent_key: 'R-1', status: 'in_progress', after_key: 'R-2' }),
    T('R-4', { parent_key: 'R-3' }), T('R-5', { parent_key: 'R-3', after_key: 'R-4' }), T('R-6', { parent_key: 'R-1', owner_task: 1 })];
  const ix = flow.index(ts);
  assert.deepEqual(flow.recordedBlockers(ix.byKey.get('R-4'), ix).map((b) => b.key), ['R-2'], 'a slice waits with its epic');
  assert.deepEqual(flow.waitingOn('R-2', ts).map((t) => t.key).sort(), ['R-4', 'R-5']);
  const n = flow.nextStep('R-1', ts);
  assert.equal(n.task.key, 'R-6', 'a step only the owner can do comes first');
  assert.equal(n.who, 'owner');
  const m = flow.nextStep('R-1', ts.filter((t) => t.key !== 'R-6'));
  assert.equal(m.task.key, 'R-2'); assert.equal(m.who, 'team'); assert.equal(m.waiting.length, 2);
  assert.ok(flow.wouldCycle('R-2', 'R-5', ts), 'R-5 already waits on R-2 through its epic');
  assert.ok(flow.wouldCycle('R-3', 'R-4', ts), 'an epic cannot wait for its own task');
  assert.ok(!flow.wouldCycle('R-5', 'R-2', ts));
  assert.deepEqual(flow.gateSuggestions('E-1', tree()).map((g) => `${g.key}>${g.after}`), ['E-3>E-2', 'E-4>E-3']);
});

test('the Inbox asks one question: tasks waiting on another question fold under it, every decision stays reachable', () => {
  const tickets = tree().map((t) => ({ ...t, updated_at: '2026-10-01T00:00:00Z', assignee: 'senior-be' }));
  tickets.find((t) => t.key === 'E-4').status = 'needs_human';
  const B = board({ tickets, agents: [], events: [], meta: {} });
  assert.deepEqual(B.needs_you.map((d) => d.ticket.key), ['E-2']);
  assert.deepEqual(B.needs_you[0].waiting.map((w) => w.key).sort(), ['E-3', 'E-4']);
  assert.equal(B.counts.needs_you, 1);
  assert.equal(B.decisions.length, 3, 'the ticket sheet still finds each task\'s own decision');
  const R = board({ tickets, agents: [], events: [], meta: { epic_reviews: [{ key: 'E-1', round: 1, status: 'ready', question_state: 'open', close_state: null, result: { summary: 's', question: { text: 'One question', covers: ['E-2'] }, close: [] } }] } });
  assert.deepEqual(R.needs_you.map((d) => d.kind), ['epic_review']);
  assert.deepEqual(R.needs_you[0].waiting.map((w) => w.key).sort(), ['E-2', 'E-3', 'E-4'], 'questions behind a covered question follow it to the review');
  const owner = board({ tickets: [{ ...tickets[0] }, { ...tickets[1], status: 'todo', owner_task: 1 }], agents: [], events: [], meta: {} });
  assert.equal(owner.needs_you[0].kind, 'owner_task');
});

const epic = (title = 'Epic') => store.createTicket({ title, status: 'in_progress', type: 'feature' }).key;
const task = (parent, title, extra = {}) => { const t = store.createTicket({ title, status: 'todo', parent_key: parent, assignee: 'senior-be', area: 'backend', complexity: 'S' }); return store.updateTicket(t.key, extra).key; };
const made = (s) => s.match(/created (\S+)/)[1];

test('create-task records one strong written gate, refuses several, only notes weak ones, and never waits on its own epic', async () => {
  const e = epic(); const a = task(e, 'Verify fills'); const b = task(e, 'Contract');
  const run = store.createRun({ agent_id: 'manager', ticket_key: e, kind: 'groom', token: 'gate-fixture', model: 'codex:fixture' });
  const one = await sched.deskAction(run, 'create-task', { parent: e, title: 'DDL', complexity: 'S', area: 'db', body: `Gated on ${a} reporting rows.` });
  assert.equal(store.getTicket(made(one)).after_key, a); assert.match(one, /recorded the gate/);
  await assert.rejects(sched.deskAction(run, 'create-task', { parent: e, title: 'x', complexity: 'S', area: 'db', body: `Depends on ${a}. Blocked by ${b}.` }), /one prerequisite per task/);
  const weak = await sched.deskAction(run, 'create-task', { parent: e, title: 'y', complexity: 'S', area: 'db', body: `Compare with the sample taken after ${a}.` });
  assert.equal(store.getTicket(made(weak)).after_key, null); assert.match(weak, /mentions/);
  const none = await sched.deskAction(run, 'create-task', { parent: e, title: 'z', complexity: 'S', area: 'db', body: `Gated on ${a} only in history.`, after: 'none' });
  assert.equal(store.getTicket(made(none)).after_key, null);
  const sub = task(e, 'Sub-epic'); task(sub, 'Slice');
  await assert.rejects(sched.deskAction(run, 'create-task', { parent: sub, title: 'w', complexity: 'S', area: 'db', body: 'b', after: sub }), /same feature|wait forever/);
  const own = await sched.deskAction(run, 'create-task', { parent: e, title: 'Rotate the key', complexity: 'S', area: 'infra', body: 'Needs the vault', owner: true });
  const ot = store.getTicket(made(own));
  assert.equal(ot.owner_task, 1); assert.equal(ot.assignee, null);
});

test('owner tasks: never picked up, finished only with notes and never when code is in flight, and an epic\'s wait holds its tasks', () => {
  const e = epic(); const a = task(e, 'Run the prod check'); const b = task(e, 'Build on it', { after_key: a });
  sched.ownerTask(a, { owner_task: true, why: 'production access' });
  assert.equal(store.getTicket(a).owner_task, 1); assert.equal(store.getTicket(a).assignee, null);
  assert.equal(sched.health().waiting.find((w) => w.key === a)?.code, 'owner_task');
  assert.throws(() => sched.ownerTaskDone(a, { notes: '' }), /say what you did/);
  const sneaky = task(e, 'Has a commit'); sched.ownerTask(sneaky, { owner_task: true }); store.updateTicket(sneaky, { head_sha: 'abc' });
  assert.throws(() => sched.ownerTaskDone(sneaky, { notes: 'done it' }), /code in flight/);
  sched.ownerTaskDone(a, { notes: '0 rows affected, logs attached' });
  assert.equal(store.getTicket(a).status, 'done');
  assert.equal(store.getTicket(b).after_key, a, 'the next task starts from the owner\'s evidence');
  store.setSetting('paused', 'false');
  const sub = task(e, 'Sub-epic', { after_key: b, status: 'in_progress' }); const slice = task(sub, 'Slice');
  assert.equal(sched.ancestorWaits(store.getTicket(slice))?.key, sub);
  assert.match(sched.health().waiting.find((w) => w.key === slice)?.reason || '', /its epic/);
  sched.ownerTask(b, { owner_task: true }); sched.ownerTask(b, { owner_task: false, why: 'the team can do it after all' });
  assert.equal(store.getTicket(b).owner_task, 0); assert.ok(store.getTicket(b).assignee);
});

test('handing back a read-only production check routes it to the SRE when production read access is on', async () => {
  const { config } = await import('../src/config.js');
  const prev = config.ops.enabled; config.ops.enabled = true; store.setSetting('ops_enabled', 'true');
  try {
    const e = epic(); const v = task(e, 'Establish Timescale incident cause from production logs');
    sched.ownerTask(v, { owner_task: true });
    sched.ownerTask(v, { owner_task: false, why: 'the SRE can check it' });
    assert.equal(store.getTicket(v).assignee, 'sre'); assert.equal(store.kvGet(`verify:${v}`), '1');
    const w = task(e, 'Rotate the broker key'); sched.ownerTask(w, { owner_task: true }); sched.ownerTask(w, { owner_task: false });
    assert.notEqual(store.getTicket(w).assignee, 'sre', 'a write/credential task is never routed as a check');
  } finally { config.ops.enabled = prev; store.setSetting('ops_enabled', 'false'); }
});

test('epic review: parse, apply only safe changes, one answer resumes every covered question', () => {
  const e = epic('Fill-cost journal'); const a = task(e, 'Verify'); const b = task(e, 'DDL'); const c = task(e, 'Backfill', { after_key: b }); const d = task(e, 'Started', { status: 'in_progress' });
  store.updateTicket(a, { status: 'needs_human', resume_status: 'todo' }); store.updateTicket(b, { status: 'needs_human', resume_status: 'todo' });
  const dup = task(e, 'Duplicate');
  assert.equal(review.autoCandidate(), e, 'two parked questions in one epic start a review');
  const r = review.start(e, { by: 'owner' });
  assert.throws(() => review.start(e), /already under way/);
  assert.throws(() => review.start(a), /top of the tree/);
  const result = review.parseResult('```json\n' + JSON.stringify({ summary: 'Blocked on prod access.', next: { key: a, why: 'everything waits on it' },
    order: [{ key: b, after: a }, { key: c, after: a }, { key: a, after: c }, { key: d, after: a }, { key: 'SD-9999', after: a }],
    priorities: [{ key: a, priority: 'P0' }, { key: b, priority: 'bogus' }], owner_tasks: [{ key: dup, ask: 'Decide the retention window' }, { key: d, ask: 'x' }],
    question: { text: 'Can you run the check on the prod box?', covers: [a, b, c] }, close: [{ key: dup, why: 'duplicate of DDL' }] }) + '\n```');
  assert.equal(result.priorities.length, 1, 'an invalid priority is dropped');
  // The run: fenced by its attempt; a late result from another attempt is ignored.
  store.kvSet(`epic-review:${e}`, JSON.stringify({ ...r, status: 'running', attempt: 'A1', snapshot: null }));
  assert.equal(review.complete(r, 'other', { result }), null);
  const done = review.complete(r, 'A1', { result });
  assert.equal(done.status, 'ready');
  assert.equal(store.getTicket(b).after_key, a);
  assert.equal(store.getTicket(c).after_key, b, 'an existing open dependency is never silently replaced');
  assert.equal(store.getTicket(a).priority, 'P0');
  assert.equal(store.getTicket(dup).owner_task, 1);
  assert.equal(store.getTicket(d).after_key, null, 'started work is left alone');
  assert.ok(done.applied.skipped.some((s) => s.includes('loop') || s.includes('already waits')));
  assert.ok(done.applied.skipped.some((s) => s.startsWith(d)));
  assert.deepEqual(done.result.question.covers.sort(), [a, b].sort(), 'only parked questions are covered');
  assert.match(store.listComments(e).at(-1).body, /Epic review 1/);
  assert.throws(() => review.answer(e, { text: 'yes', round: 99 }), /changed/);
  const ans = review.answer(e, { text: 'Yes, running it tonight.', round: 1 });
  assert.deepEqual(ans.resumed.sort(), [a, b].sort());
  assert.equal(store.getTicket(a).status, 'todo'); assert.equal(store.getTicket(b).status, 'todo');
  assert.throws(() => review.answer(e, { text: 'again', round: 1 }), /already answered/);
  const closed = review.decideCloses(e, { approve: true, round: 1 });
  assert.deepEqual(closed.closed, [dup]); assert.equal(store.getTicket(dup).status, 'wontdo');
  assert.equal(review.autoCandidate(), null, 'no new questions: no new review');
});

test('a task edited during the review keeps the owner\'s edit', () => {
  const e = epic(); const a = task(e, 'A'); const b = task(e, 'B');
  const r = review.start(e);
  const snapshot = Object.fromEntries([e, a, b].map((k) => [k, store.getTicket(k).updated_at]));
  store.kvSet(`epic-review:${e}`, JSON.stringify({ ...r, status: 'running', attempt: 'S1', snapshot: { ...snapshot, [b]: '2000-01-01T00:00:00.000Z' } }));
  store.updateTicket(b, { priority: 'P3' }); // the owner's edit, after the manager read the tree
  const out = review.complete(r, 'S1', { result: review.parseResult(JSON.stringify({ summary: 's', order: [{ key: b, after: a }], priorities: [{ key: b, priority: 'P0' }] })) });
  assert.equal(store.getTicket(b).after_key, null); assert.equal(store.getTicket(b).priority, 'P3');
  assert.ok(out.applied.skipped.every((s) => s.includes('changed during the review')));
});

test('an epic review leaves a priority the owner set', () => {
  const e = epic(); const a = task(e, 'A'); const b = task(e, 'B');
  sched.ownerPatch(a, { priority: 'P3' }); // the owner chose it earlier: pinned
  const r = review.start(e);
  store.kvSet(`epic-review:${e}`, JSON.stringify({ ...r, status: 'running', attempt: 'P1', snapshot: null }));
  const out = review.complete(r, 'P1', { result: review.parseResult(JSON.stringify({ summary: 's', priorities: [{ key: a, priority: 'P0' }, { key: b, priority: 'P1' }] })) });
  assert.equal(store.getTicket(a).priority, 'P3'); assert.equal(store.getTicket(b).priority, 'P1');
  assert.ok(out.applied.skipped.some((s) => s.startsWith(a) && /you set it/.test(s)));
  assert.equal(store.getTicket(b).priority_pinned, 0, 'the manager\'s priority does not pin');
});

test('an epic review reads and consults; it cannot change tickets itself', async () => {
  const e = epic();
  const run = store.createRun({ agent_id: 'manager', ticket_key: e, kind: 'epic_review', token: 'review-fixture', model: 'codex:fixture' });
  for (const cmd of ['create-task', 'groom', 'reject', 'needs-human', 'comment']) await assert.rejects(sched.deskAction(run, cmd, { key: e }), /epic review reads and consults/);
  assert.match(await sched.deskAction(run, 'show', { key: e }), new RegExp(e));
  store.updateAgent('principal-be', { status: 'working' });
  await assert.rejects(sched.deskAction(run, 'consult', { agent: 'principal-be', body: 'Which first?' }), /busy|capacity/);
  await assert.rejects(sched.deskAction(run, 'consult', { agent: 'principal-be', body: 'Again' }), /once/);
  store.updateAgent('principal-be', { status: 'idle' });
  store.updateRun(run.id, { status: 'success', token: null, ended_at: store.now() });
});
