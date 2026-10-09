// Structured hold reasons (#9): the code that holds a ticket records why (hold_kind), who asked (hold_seat) and what it
// refers to (hold_ref); a status change clears them; owner tasks state their kind. The Inbox reads the structured reason
// before any progress-message pattern, and delegation (src/delegation.js) routes on these fields only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-holds-')));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'D' }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false }, ops: { enabled: true, containers: [] } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, store, sched, attention;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  sched = await import('../src/scheduler.js'); attention = await import('../public/attention.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const ticket = (patch = {}) => { const t = store.createTicket({ title: `Hold fixture ${++n}`, status: 'todo', area: 'backend', complexity: 'S', assignee: 'junior', reporter: 'owner' }); return store.updateTicket(t.key, { risk: 'low', ...patch }); };
/** An engineer asks the owner through the real desk command. */
async function ask(t, seat = 'junior', q = 'Which test file covers the retry helper?') {
  store.updateTicket(t.key, { status: 'in_progress', assignee: seat });
  const run = store.createRun({ agent_id: seat, ticket_key: t.key, kind: 'implement', token: `i-${Math.random()}`, model: 'claude:opus' });
  await sched.deskAction(run, 'needs-human', { body: q });
  store.updateRun(run.id, { status: 'success', token: null });
  return store.getTicket(t.key);
}
const reset = () => store.setSetting('ops_enabled', 'false');

test('structured holds: the holding code records why and who; a status change clears it; the Inbox reads it before any message pattern', async () => {
  reset();
  const t = await ask(ticket(), 'junior', 'Is the retry helper in utils/net.py?');
  assert.deepEqual([t.status, t.hold_kind, t.hold_seat], ['needs_human', 'question', 'junior']);
  assert.match(store.listComments(t.key).find((c) => String(c.id) === t.hold_ref).body, /Question for the owner:\*\* Is the retry helper/);
  store.updateTicket(t.key, { progress_msg: 'QA failed repeatedly' }); // a misleading message never reclassifies a structured hold
  assert.equal(attention.decisionsFor(store.getTicket(t.key))[0].kind, 'question');
  sched.setStatus(t.key, 'todo');
  assert.deepEqual([store.getTicket(t.key).hold_kind, store.getTicket(t.key).hold_seat, store.getTicket(t.key).hold_ref], [null, null, null], 'leaving the hold clears its reason');
  // Older holds (no structured reason) still read their message.
  assert.equal(attention.decisionsFor({ key: 'X-1', title: 'x', status: 'needs_human', progress_msg: 'QA failed repeatedly' })[0].kind, 'stuck');
  assert.equal(attention.decisionsFor({ key: 'X-2', title: 'x', status: 'needs_human', hold_kind: 'qa_loops', progress_msg: 'anything' })[0].kind, 'stuck');
  assert.equal(attention.decisionsFor({ key: 'X-3', title: 'x', status: 'needs_human', hold_kind: 'guard', progress_msg: 'x' })[0].kind, 'guard');
  // An owner task states its kind; making it the owner's again without one leaves it unknown.
  const o = ticket(); sched.ownerTask(o.key, { owner_task: true });
  assert.equal(store.getTicket(o.key).owner_task_kind, 'owner', 'the owner took it: never routed away');
  store.updateTicket(o.key, { owner_task: 1 });
  assert.equal(store.getTicket(o.key).owner_task_kind, null);
});

test('create-task --owner-kind: structured owner steps (check → the SRE when access is on; others stay yours)', async () => {
  reset();
  const parent = ticket({ status: 'in_progress', assignee: 'manager' });
  const run = store.createRun({ agent_id: 'manager', ticket_key: parent.key, kind: 'groom', token: `g-${Math.random()}`, model: 'claude:opus' });
  await assert.rejects(sched.deskAction(run, 'create-task', { parent: parent.key, title: 'x', complexity: 'S', area: 'db', body: 'b', owner: 'y', 'owner-kind': 'magic' }), /--owner-kind must be one of check, package/);
  await assert.rejects(sched.deskAction(run, 'create-task', { parent: parent.key, title: 'x', complexity: 'S', area: 'db', body: 'b', 'owner-kind': 'write' }), /goes with --owner/);
  const w = await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Run the backfill', complexity: 'S', area: 'db', body: 'b', owner: 'it writes to production', 'owner-kind': 'write' });
  const wk = w.match(/D-\d+/)[0];
  assert.deepEqual([store.getTicket(wk).owner_task, store.getTicket(wk).owner_task_kind], [1, 'write']);
  // A check with production read access off stays the owner's but keeps its kind, so delegation can route it later.
  const c = await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Look at the jobs', complexity: 'S', area: 'db', body: 'b', owner: 'needs production access', 'owner-kind': 'check' });
  const ck = c.match(/D-\d+/)[0];
  assert.deepEqual([store.getTicket(ck).owner_task, store.getTicket(ck).owner_task_kind], [1, 'check']);
});

test('hold sites name their kind: QA and CI loop limits, a support route to the owner, and the asker of a review loop', async () => {
  const q = ticket({ status: 'qa', qa_loops: 2, head_sha: 'abc' });
  const qaRun = store.createRun({ agent_id: 'qa', ticket_key: q.key, kind: 'qa', token: `q-${Math.random()}`, model: 'claude:sonnet', nonce: 'n1' });
  await sched.deskAction(qaRun, 'qa', { verdict: 'fail', code: 'n1', reason: 'bug', body: '1. still wrong' });
  assert.deepEqual([store.getTicket(q.key).status, store.getTicket(q.key).hold_kind], ['needs_human', 'qa_loops']);
  const c = ticket({ status: 'review', qa_loops: 2 });
  sched.prChecksFailed(store.getTicket(c.key), 'tests');
  assert.equal(store.getTicket(c.key).hold_kind, 'ci_loops');
  const s = ticket({ status: 'triage' });
  const tri = store.createRun({ agent_id: 'support', ticket_key: s.key, kind: 'triage', token: `t-${Math.random()}`, model: 'claude:haiku' });
  await sched.deskAction(tri, 'route', { to: 'human', body: 'needs an account decision' });
  assert.deepEqual([store.getTicket(s.key).hold_kind, store.getTicket(s.key).hold_seat], ['route', 'support']);
  const a = store.updateTicket(store.createTicket({ title: 'Requester loop', status: 'review', reporter: 'manager' }).key, { qa_loops: 2 });
  const acc = store.createRun({ agent_id: 'manager', ticket_key: a.key, kind: 'review', token: `r-${Math.random()}`, model: 'claude:opus', nonce: 'n2' });
  const { config } = await import('../src/config.js');
  const prev = config.review.acceptance; config.review.acceptance = true;
  try {
    await sched.deskAction(acc, 'accept', { verdict: 'changes', code: 'n2', body: '1. not what I asked' });
    assert.deepEqual([store.getTicket(a.key).hold_kind, store.getTicket(a.key).hold_seat], ['review_loops', 'manager'], 'the requester who keeps asking is recorded');
  } finally { config.review.acceptance = prev; }
});
