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
