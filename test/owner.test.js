import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-owner-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let config, store, sched, dispatch;
before(async () => {
  ({config} = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:'); sched = await import('../src/scheduler.js'); dispatch = await import('../src/dispatch.js');
  dispatch.setAvailability([{ id: 'claude', available: false }, { id: 'codex', available: true }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const blocked = () => { const t = store.createTicket({title:'Owner workflow fixture', status:'needs_human', assignee:'senior-be'}); return store.updateTicket(t.key, {resume_status:'todo'}); };

test('owner messages distinguish design discussion, comment and answers without restarting blocked work', () => {
  const t = blocked();
  const r = sched.ownerReply(t.key, 'Discuss this design with manager and principal engineers: use a release branch for the feature.');
  assert.equal(r.message_route, 'discussion'); assert.equal(r.status, 'needs_human'); assert.equal(r.discussion.status, 'queued');
  assert.equal(sched.ownerReply(t.key, 'Keeping this for reference', 'comment').status, 'needs_human');
  assert.equal(sched.ownerReply(t.key, 'Use the documented baseline', 'answer').status, 'todo');
  assert.throws(() => sched.ownerReply(t.key, 'hello', 'unknown')); assert.throws(() => sched.ownerReply(t.key, ' '));
});

test('approve, correction and rejection keep decisions explicit, reject stale requests and retain local work', async () => {
  const t = blocked();
  await assert.rejects(sched.ownerDecision(t.key, {decision:'approve', expected_updated_at:'stale'}), {status:409});
  await assert.rejects(sched.ownerDecision(t.key, {decision:'correction', message:''}), /Describe the correction/);
  assert.equal((await sched.ownerDecision(t.key, {decision:'approve', message:'Use the exact supplied artifact'})).status, 'todo');
  const c = blocked(); await sched.ownerDecision(c.key, {decision:'correction', message:'Preserve source timestamps'});
  assert.equal(store.getTicket(c.key).status, 'todo'); assert.ok(store.listComments(c.key).at(-1).body.startsWith('🔁'));
  const r = blocked(); const dir = path.join(config.workspaceRoot, r.key); fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir,'partial.txt'),'retain');
  await sched.ownerDecision(r.key, {decision:'reject', message:'Wrong scope'});
  assert.equal(store.getTicket(r.key).status, 'wontdo'); assert.equal(fs.readFileSync(path.join(dir,'partial.txt'),'utf8'), 'retain');
  const published = store.createTicket({title:'Published draft',status:'ready_for_human'});
  store.updateTicket(published.key,{pr_url:'https://github.com/test/fixture/pull/1'});
  assert.equal((await sched.ownerDecision(published.key,{decision:'approve'})).status,'ready_for_human');
  assert.match(store.listComments(published.key).at(-1).body,/Owner review approved/);
});

test('discussion run can respond but cannot change ticket state, create work, or repeat principal consultations', async () => {
  const t = blocked(), d = store.createDiscussion(t.key, 'Review the feature integration branch');
  const run = store.createRun({agent_id:'manager', ticket_key:t.key, kind:'owner_discussion', token:'fixture', model:'codex:default'});
  store.updateDiscussion(d.id, {status:'running', run_id:run.id});
  for (const cmd of ['groom','create-task','needs-human','reject','submit','progress']) await assert.rejects(sched.deskAction(run,cmd,{}), /only read/);
  store.updateAgent('principal-be',{status:'working'}); store.updateAgent('principal-fe',{status:'working'});
  await assert.rejects(sched.deskAction(run,'consult',{agent:'principal-be',body:'Review dependency handling'}), /busy/);
  await assert.rejects(sched.deskAction(run,'consult',{agent:'principal-be',body:'Again'}), /once/);
  await assert.rejects(sched.deskAction(run,'consult',{agent:'principal-fe',body:'Review release UX'}), /busy/);
  await assert.rejects(sched.deskAction(run,'consult',{agent:'dba',body:'A third consult'}), /at most two/);
  await sched.deskAction(run,'discussion-result',{body:'Use a feature integration branch, combined QA and an owner-reviewed final PR.'});
  assert.equal(store.getDiscussion(d.id).status, 'complete'); assert.equal(store.getTicket(t.key).status, 'needs_human');
  await assert.rejects(sched.deskAction(run,'discussion-result',{body:'duplicate'}), /no active discussion/);
  store.updateRun(run.id,{status:'success', token:null, ended_at:store.now()});
  store.updateAgent('principal-be',{status:'idle'}); store.updateAgent('principal-fe',{status:'idle'});
});

test('real fixture process returns a manager response without consuming the implementation blocker', async () => {
  const cli = path.join(tmp,'discussion.mjs');
  fs.writeFileSync(cli, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Your proposal is a feature integration branch with independent slice QA and combined release QA.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));
});`); fs.chmodSync(cli,0o755); config.engines.codex.bin = cli;
  const t = blocked(), d = store.createDiscussion(t.key,'Please discuss the release workflow');
  await sched.launchDiscussion(d);
  assert.equal(store.getDiscussion(d.id).status,'complete'); assert.match(store.getDiscussion(d.id).response,/feature integration/);
  assert.equal(store.getTicket(t.key).status,'needs_human'); assert.equal(store.getTicket(t.key).active_run,null);
});

test('interrupted discussions return to their durable queue on restart', () => {
  const t = blocked(), d = store.createDiscussion(t.key,'Review'); store.updateDiscussion(d.id,{status:'running',run_id:10000});
  sched.recoverOrphans(); assert.equal(store.getDiscussion(d.id).status,'queued'); assert.equal(store.getDiscussion(d.id).run_id,null);
});

test('design approval, correction and rejection are separate from task decisions', async () => {
  const t = blocked();
  for (const decision of ['approve','correction','reject']) {
    const d = store.createDiscussion(t.key,'Feature integration design'); store.updateDiscussion(d.id,{status:'complete',response:'Use a scoped pilot with combined QA.'});
    const result = await sched.ownerDecision(t.key,{decision,discussion_id:d.id,message:'Keep the pilot bounded'});
    assert.equal(result.status,{approve:'approved',correction:'changes_requested',reject:'rejected'}[decision]);
    assert.equal(store.getTicket(t.key).status,'needs_human');
    await assert.rejects(sched.ownerDecision(t.key,{decision:'approve',discussion_id:d.id}), {status:409});
  }
  assert.ok(store.pendingDiscussions().some(d=>d.question.includes('Keep the pilot bounded')));
});

test('an answer carries the version it answers: a newer hold rejects it without resuming', () => {
  const t = blocked();
  assert.throws(() => sched.ownerReply(t.key, 'Old answer', 'answer', { expected_updated_at: '1999-01-01T00:00:00.000Z' }), { status: 409 });
  assert.equal(store.getTicket(t.key).status, 'needs_human');
  assert.equal(store.listComments(t.key).filter((c) => c.body === 'Old answer').length, 0);
  assert.equal(sched.ownerReply(t.key, 'Fresh answer', 'answer', { expected_updated_at: store.getTicket(t.key).updated_at }).status, 'todo');
  // comments never resume work, so they need no version
  assert.equal(sched.ownerReply(t.key, 'note', 'comment', { expected_updated_at: 'old' }).status, 'todo');
});

test('a generic edit cannot mark a ticket done; only a merge ships it', () => {
  const t = store.createTicket({ title: 'Patch guard fixture', status: 'todo' });
  assert.throws(() => sched.ownerPatch(t.key, { status: 'done' }), { status: 409 });
  assert.equal(store.getTicket(t.key).status, 'todo');
  assert.equal(sched.ownerPatch(t.key, { status: 'wontdo' }).status, 'wontdo');
});

test('scheduler waiting entries carry a structured code', () => {
  const w = sched.health().waiting;
  assert.ok(w.length > 0);
  for (const x of w) assert.ok(['paused', 'dependency', 'provider_hold', 'setup_retry', 'seat_busy', 'budget', 'tick'].includes(x.code), x.code);
});

test('grooming is pinned to Codex by default and only grooming may pin an engine', async () => {
  assert.equal(store.getSettings().groom_engine ?? 'codex', 'codex');
  assert.equal(sched.groomEngine(), 'codex');
  const pinned = dispatch.pinnedSelection('manager', 'codex', 'groom');
  assert.equal(pinned.seat.engine, 'codex'); assert.equal(pinned.seat.name, 'Morgan'); assert.equal(pinned.fallback, false);
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: false }]);
  assert.equal(dispatch.pinnedSelection('manager', 'codex', 'groom').seat, null, 'no silent fallback when Codex is down');
  dispatch.setAvailability([{ id: 'claude', available: false }, { id: 'codex', available: true }]);
  store.setSetting('groom_engine', 'seat'); assert.equal(sched.groomEngine(), null);
  assert.throws(() => store.setSetting('groom_engine', 'perplexity'), /codex or seat/);
  store.setSetting('groom_engine', 'codex');
  const runner = await import('../src/runner.js');
  assert.throws(() => runner.startRun({ agentId: 'manager', kind: 'implement', prompt: 'x', cwd: tmp, pinEngine: 'codex' }), /Only grooming/);
});

test('a failed design discussion can be retried, a queued one cancelled, and both are visible in the ticket thread', () => {
  const t = blocked();
  const d = sched.ownerReply(t.key, 'Talk it through with the manager', 'discussion').discussion;
  assert.throws(() => sched.ownerDiscussion(d.id, 'retry'), /only a failed/);
  assert.equal(sched.ownerDiscussion(d.id, 'cancel').status, 'cancelled');
  assert.throws(() => sched.ownerDiscussion(d.id, 'cancel'), /not started/);
  const e = sched.ownerReply(t.key, 'Second try', 'discussion').discussion;
  store.updateDiscussion(e.id, { status: 'failed', error: 'provider unavailable', attempts: 3 });
  const again = sched.ownerDiscussion(e.id, 'retry');
  assert.equal(again.status, 'queued'); assert.equal(again.attempts, 0);
  const routed = store.recentEvents({ ticket_key: t.key, limit: 50 }).find((x) => /Sent to the Engineering Manager/.test(x.text));
  assert.equal(routed.agent_id, 'system', 'desk routing notes are not attributed to Morgan');
});

test('a manager split keeps the parent open as an epic, enforces order, and closes it when the tasks settle', async () => {
  const parent = store.createTicket({ title: 'Fill-cost journal', status: 'proposed', type: 'feature' });
  const run = store.createRun({ agent_id: 'manager', ticket_key: parent.key, kind: 'groom', token: 'split-fixture', model: 'codex:fixture' });
  const made = (s) => s.match(/created (\S+)/)[1];
  const a = made(await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Verify fills', complexity: 'S', area: 'infra', body: 'Owner-run check' }));
  const b = made(await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Contract and DDL', complexity: 'M', area: 'db', body: 'Draft', after: a }));
  await assert.rejects(sched.deskAction(run, 'create-task', { parent: parent.key, title: 'x', complexity: 'S', area: 'db', body: 'y', after: 'SD-9999' }), /same feature/);
  assert.equal(store.getTicket(b).after_key, a, 'the order is recorded, not just described');
  // The old "reject the parent after splitting" instruction now records a split.
  await sched.deskAction(run, 'reject', { key: parent.key, body: 'split into the tasks above' });
  let p = store.getTicket(parent.key);
  assert.equal(p.status, 'in_progress'); assert.equal(p.assignee, 'manager');
  assert.match(store.listComments(parent.key).at(-1).body, /Split/);
  store.updateTicket(a, { status: 'done' }); sched.rollupParent(parent.key);
  assert.match(store.getTicket(parent.key).progress_msg, /1\/2/);
  store.updateTicket(b, { status: 'done' }); sched.rollupParent(parent.key);
  p = store.getTicket(parent.key);
  assert.equal(p.status, 'done', 'the epic closes when every task is settled');
  // A plain reject (no tasks) still closes the ticket.
  const lone = store.createTicket({ title: 'Duplicate idea', status: 'proposed' });
  const r2 = store.createRun({ agent_id: 'manager', ticket_key: lone.key, kind: 'groom', token: 'reject-fixture', model: 'codex:fixture' });
  await sched.deskAction(r2, 'reject', { key: lone.key, body: 'duplicate' });
  assert.equal(store.getTicket(lone.key).status, 'wontdo');
});

test('the owner can order a task after a sibling, without loops', () => {
  const parent = store.createTicket({ title: 'Epic', status: 'in_progress' });
  const [x, y, z] = ['X', 'Y', 'Z'].map((n) => store.createTicket({ title: n, status: 'todo', parent_key: parent.key }).key);
  assert.equal(sched.ownerPatch(y, { after_key: x }).after_key, x);
  assert.equal(sched.ownerPatch(z, { after_key: y }).after_key, y);
  assert.throws(() => sched.ownerPatch(x, { after_key: z }), /loop/);
  assert.throws(() => sched.ownerPatch(x, { after_key: x }), /same feature/);
  const other = store.createTicket({ title: 'Elsewhere', status: 'todo' }).key;
  assert.throws(() => sched.ownerPatch(y, { after_key: other }), /same feature/);
  const sub = store.createTicket({ title: 'Sub-epic', status: 'in_progress', parent_key: parent.key }).key;
  const slice = store.createTicket({ title: 'Slice', status: 'todo', parent_key: sub }).key;
  assert.equal(sched.ownerPatch(slice, { after_key: x }).after_key, x, 'a slice of a sub-epic can wait for a task elsewhere in the feature');
  assert.equal(sched.ownerPatch(y, { after_key: '' }).after_key, null);
});

test('a seat whose engine cannot run a job uses a capable engine for it, even with automatic fallback off', () => {
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }, { id: 'perplexity', available: true }]);
  const team = store.getSettings().team;
  store.setSetting('team', JSON.stringify({ ...JSON.parse(team || '{}'), manager: { engine: 'perplexity', model: '', effort: 'medium', enabled: true } }));
  return import('../src/team.js').then(({ applyTeamOverrides: apply }) => {
    apply(JSON.parse(store.getSettings().team));
    store.setSetting('auto_fallback', 'false');
    const review = dispatch.selectionFor('manager', Date.now(), null, 'pr_review');
    assert.ok(review.seat, review.reason);
    assert.notEqual(review.seat.engine, 'perplexity', 'Perplexity cannot review a PR');
    assert.equal(review.fallback, true); assert.match(review.reason, /cannot run pr_review/);
    assert.equal(dispatch.selectionFor('manager', Date.now(), null, 'groom').seat?.engine, dispatch.selectionFor('manager').seat?.engine, 'kinds it can run keep the seat engine');
    store.setSetting('auto_fallback', 'true');
    apply(JSON.parse(team || '{}'));
    store.setSetting('team', team || '{}');
  });
});

test('parents the manager closed while splitting are repaired once; an owner rejection is left alone', () => {
  const mk = (title, status = 'wontdo') => store.createTicket({ title, status, type: 'feature' });
  const live = mk('Split with open tasks'); const shipped = mk('Split, all shipped'); const owner = mk('Owner rejected');
  store.addComment(live.key, 'manager', 'Closed: Split into the tasks below');
  store.addComment(shipped.key, 'manager', 'Closed: split into two');
  store.addComment(owner.key, 'owner', 'Closed: not worth it, split or not');
  store.createTicket({ title: 'open task', status: 'todo', parent_key: live.key });
  store.createTicket({ title: 'shipped task', status: 'done', parent_key: live.key });
  store.createTicket({ title: 'done', status: 'done', parent_key: shipped.key });
  store.createTicket({ title: 'open under owner reject', status: 'todo', parent_key: owner.key });
  store.kvSet('migration:split-epics:v1', ''); // an earlier recoverOrphans() in this file already ran it once
  const fixed = sched.repairSplitEpics();
  assert.ok(fixed.includes(live.key) && fixed.includes(shipped.key) && !fixed.includes(owner.key));
  assert.equal(store.getTicket(live.key).status, 'in_progress'); assert.match(store.getTicket(live.key).progress_msg, /1\/2/);
  assert.equal(store.getTicket(shipped.key).status, 'done');
  assert.equal(store.getTicket(owner.key).status, 'wontdo');
  assert.match(store.listComments(live.key).at(-1).body, /Reopened as an epic/);
  assert.deepEqual(sched.repairSplitEpics(), [], 'runs once');
});
