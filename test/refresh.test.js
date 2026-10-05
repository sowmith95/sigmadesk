import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-refresh-'));
const owner = path.join(tmp, 'owner'), remote = path.join(tmp, 'remote.git');
const git = (dir, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
execFileSync('git', ['init', '-q', '--bare', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', owner]);
git(owner, ['config', 'user.name', 'Test']); git(owner, ['config', 'user.email', 'test@example.com']);
fs.writeFileSync(path.join(owner, 'shared.txt'), 'base\n'); fs.writeFileSync(path.join(owner, 'stable.txt'), 'stable\n');
git(owner, ['add', '.']); git(owner, ['commit', '-qm', 'base']);
git(owner, ['remote', 'add', 'origin', remote]); git(owner, ['push', '-q', '-u', 'origin', 'main']);
git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: owner }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let config, store, refresh, runner, sched;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  refresh = await import('../src/refresh.js'); runner = await import('../src/runner.js'); sched = await import('../src/scheduler.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
function fixture({ conflict = true } = {}) {
  const n = ++serial, branch = `feature-${n}`;
  const t = store.createTicket({ title: 'refresh fixture', status: 'needs_human', assignee: 'junior' });
  const ws = runner.workspaceDir(t.key);
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', remote, ws]);
  git(ws, ['config', 'user.name', 'Test']); git(ws, ['config', 'user.email', 'test@example.com']);
  git(ws, ['checkout', '-qb', branch]); fs.writeFileSync(path.join(ws, 'shared.txt'), `feature ${n}\n`);
  git(ws, ['add', '.']); git(ws, ['commit', '-qm', 'feature']); git(ws, ['push', '-q', 'origin', branch]);
  const head = git(ws, ['rev-parse', 'HEAD']);
  if (conflict) fs.writeFileSync(path.join(owner, 'shared.txt'), `main ${n}\n`);
  fs.writeFileSync(path.join(owner, `live-stop-${n}.txt`), 'preserve other feature\n');
  git(owner, ['add', '.']); git(owner, ['commit', '-qm', 'main advanced']); git(owner, ['push', '-q', 'origin', 'main']);
  return { t: store.updateTicket(t.key, { head_sha: head, branch, pr_url: 'https://github.com/test/repo/pull/1' }), ws, head, branch };
}

test('desk rebase preserves a backup, ignores seat config/hooks, and reconciles real conflicts before fresh QA', async () => {
  const { t, ws, head, branch } = fixture();
  const marker = path.join(tmp, 'unsafe-hook-ran');
  git(ws, ['config', 'core.fsmonitor', `touch ${marker}`]);
  fs.writeFileSync(path.join(ws, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const result = await sched.ownerRefreshBase(t.key, { expected_updated_at: t.updated_at });
  assert.equal(result.ticket.status, 'todo'); assert.equal(result.ticket.head_sha, null);
  assert.equal(result.refresh.original_head, head); assert.equal(result.refresh.status, 'conflicts');
  assert.deepEqual(result.refresh.conflicts, ['shared.txt']); assert.ok(!fs.existsSync(marker));
  assert.match(fs.readFileSync(path.join(ws, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.equal(git(path.join(tmp, 'data', 'refresh', t.key), ['rev-parse', 'desk-original']), head);
  await assert.rejects(refresh.continueRebase(t.key), /markers remain/);
  fs.writeFileSync(path.join(ws, 'stable.txt'), 'unrelated edit\n');
  await assert.rejects(refresh.continueRebase(t.key), /Only resolve/);
  fs.writeFileSync(path.join(ws, 'stable.txt'), 'stable\n');
  fs.writeFileSync(path.join(ws, 'shared.txt'), 'main and feature preserved\n');
  const done = await refresh.continueRebase(t.key);
  assert.equal(done.status, 'rebased'); assert.notEqual(done.head, head);
  assert.equal(git(ws, ['branch', '--show-current']), branch); assert.equal(git(ws, ['status', '--porcelain']), '');
  assert.ok(fs.existsSync(path.join(ws, 'live-stop-1.txt'))); assert.ok(!fs.existsSync(marker));
  assert.ok(refresh.validationBlockers(t.key, done.head, done.base).length);
  refresh.recordQa(t.key, done.head);
  assert.deepEqual(refresh.validationBlockers(t.key, done.head, done.base), []);
  assert.ok(refresh.validationBlockers(t.key, head, done.base).length);
  assert.ok(refresh.validationBlockers(t.key, done.head, 'a'.repeat(40)).length);
  const staged = await runner.stageApproved(t.key, ws, done.head); assert.equal(staged.baseSha, done.base);
  await runner.pushBranch(t.key, branch, done.head, { lease: head }); refresh.published(t.key, done.head);
  assert.equal(git(remote, ['rev-parse', branch]), done.head);
  assert.equal(refresh.current(t.key).remote_head, done.head);
  assert.equal(refresh.publicState(t.key).manifest, undefined);
});

test('clean refresh preserves untracked dependencies and concurrent remote updates reject the guarded push', async () => {
  const { t, ws, head, branch } = fixture({ conflict: false });
  fs.mkdirSync(path.join(ws, 'node_modules')); fs.writeFileSync(path.join(ws, 'node_modules', 'keep'), 'dependency');
  const done = await refresh.prepare(t); assert.equal(done.status, 'rebased');
  assert.equal(fs.readFileSync(path.join(ws, 'node_modules', 'keep'), 'utf8'), 'dependency');
  await runner.stageApproved(t.key, ws, done.head);
  // Another actor changes the remote branch after the lease was captured.
  git(owner, ['push', '-q', '--force', 'origin', `main:refs/heads/${branch}`]);
  await assert.rejects(runner.pushBranch(t.key, branch, done.head, { lease: head }), /stale info|rejected/);
  assert.equal(git(remote, ['rev-parse', branch]), git(owner, ['rev-parse', 'main']));
});

test('busy, stale, dirty and symlinked workspaces never get overwritten by refresh', async () => {
  const { t, ws } = fixture();
  await assert.rejects(sched.ownerRefreshBase(t.key, { expected_updated_at: 'stale' }), { status: 409 });
  store.updateTicket(t.key, { active_run: -1 }); await assert.rejects(sched.ownerRefreshBase(t.key), /workers to finish/);
  store.updateTicket(t.key, { active_run: null });
  fs.writeFileSync(path.join(ws, 'stable.txt'), 'local work'); await assert.rejects(refresh.prepare(t), /local edits/);
  assert.equal(fs.readFileSync(path.join(ws, 'stable.txt'), 'utf8'), 'local work');
  fs.unlinkSync(path.join(ws, 'stable.txt')); fs.symlinkSync(path.join(owner, 'stable.txt'), path.join(ws, 'stable.txt'));
  await assert.rejects(refresh.prepare(t), /Unsupported workspace/);
  assert.equal(fs.readFileSync(path.join(owner, 'stable.txt'), 'utf8'), 'stable\n');
});

test('seat commands are limited to the current implementer; interrupted preparation requires inspection', async () => {
  const { t } = fixture();
  for (const agent_id of ['manager', 'qa', 'principal-fe']) {
    await assert.rejects(sched.deskAction({ agent_id, kind: 'implement', ticket_key: t.key }, 'continue-rebase'), /cannot run/);
  }
  await assert.rejects(sched.deskAction({ agent_id: 'junior', kind: 'qa', ticket_key: t.key }, 'continue-rebase'), /current implementer/);
  store.kvSet(`refresh:${t.key}`, JSON.stringify({ status: 'preparing' })); store.updateTicket(t.key, { active_run: -1 });
  sched.recoverOrphans(); assert.equal(store.getTicket(t.key).status, 'needs_human');
  assert.match(store.getTicket(t.key).progress_msg, /interrupted/);
});

test('a commit held by the publish guard is ours: refresh accepts the desk\'s own last publish, and a failed refresh keeps the guard', async () => {
  const { t, ws, head } = fixture({ conflict: false });
  store.kvSet(`published:${t.key}`, head); // the desk published this commit
  fs.writeFileSync(path.join(ws, 'review-fix.txt'), 'fix\n'); git(ws, ['add', '.']); git(ws, ['commit', '-qm', 'review fix (held by the guard)']);
  const held = git(ws, ['rev-parse', 'HEAD']);
  const ticket = store.updateTicket(t.key, { head_sha: held, qa_sha: held, progress_msg: 'publish guard: needs owner approval' });
  const done = await refresh.prepare(ticket);
  assert.equal(done.status, 'rebased', 'GitHub having our earlier publish is not "someone else changed the branch"');

  // Someone else's commit on GitHub is still refused, and the guard hold survives the failed refresh.
  const other = fixture({ conflict: false });
  store.kvSet(`published:${other.t.key}`, other.head);
  git(owner, ['push', '-q', '--force', 'origin', `main:refs/heads/${other.branch}`]);
  store.updateTicket(other.t.key, { progress_msg: 'publish guard: needs owner approval' });
  await assert.rejects(sched.ownerRefreshBase(other.t.key), /Remote branch changed/);
  const after = store.getTicket(other.t.key);
  assert.equal(after.progress_msg, 'publish guard: needs owner approval', 'the hold stays recognisable');
  assert.match(store.listComments(other.t.key).at(-1).body, /branch refresh did not run/);
});

test('a guard hold that an old refresh message replaced is restored at start', () => {
  const t = store.createTicket({ title: 'guard repair', status: 'needs_human', assignee: 'junior' });
  store.updateTicket(t.key, { head_sha: 'b'.repeat(40), pr_url: 'https://github.com/test/repo/pull/9', progress_msg: 'Branch refresh held: Remote branch changed' });
  store.kvSet(`published:${t.key}`, 'a'.repeat(40));
  store.kvSet(`guard:${t.key}`, 'b'.repeat(40)); // the guard parked this exact commit
  sched.repairGuardHolds();
  assert.equal(store.getTicket(t.key).progress_msg, 'publish guard: needs owner approval');
  // A ticket held for another reason (QA failed repeatedly after an earlier guard was approved) is left alone.
  const other = store.createTicket({ title: 'qa loop', status: 'needs_human', assignee: 'junior' });
  store.updateTicket(other.key, { head_sha: 'd'.repeat(40), pr_url: 'https://github.com/test/repo/pull/10', progress_msg: 'QA failed repeatedly' });
  store.kvSet(`published:${other.key}`, 'c'.repeat(40)); store.kvSet(`guard:${other.key}`, '');
  sched.repairGuardHolds();
  assert.equal(store.getTicket(other.key).progress_msg, 'QA failed repeatedly');
});

test('SD-77: a guarded review fix is approved once; a failed push neither re-guards it nor hides the error', async () => {
  const { t, ws, head, branch } = fixture({ conflict: false });
  store.kvSet(`published:${t.key}`, head);
  fs.mkdirSync(path.join(ws, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'workflows', 'ci.yml'), 'on: push\n'); git(ws, ['add', '.']); git(ws, ['commit', '-qm', 'review fix touching CI']);
  const fix = git(ws, ['rev-parse', 'HEAD']);
  store.updateTicket(t.key, { status: 'ready_for_human', head_sha: fix, qa_sha: fix, issue_number: 1 });
  await sched.publishOnce(t.key);
  assert.equal(store.getTicket(t.key).progress_msg, 'publish guard: needs owner approval');
  assert.equal(store.kvGet(`guard:${t.key}`), fix);
  const why = JSON.parse(store.kvGet(`guard-reasons:${t.key}`));
  assert.equal(why.head, fix); assert.match(why.reasons.join(' '), /protected|workflow/i);

  // The owner approves while GitHub is unreachable: the push fails and is recorded for the owner to see.
  const away = `${remote}.away`; fs.renameSync(remote, away);
  try { await sched.ownerApprovePublish(t.key); } finally { fs.renameSync(away, remote); }
  const err = JSON.parse(store.kvGet(`publish-error:${t.key}`));
  assert.equal(err.head, fix); assert.equal(err.count, 1);
  assert.notEqual(store.getTicket(t.key).status, 'needs_human', 'approved: no longer held');

  // The retry pushes the approved commit without asking again.
  await sched.publishOnce(t.key);
  assert.equal(git(remote, ['rev-parse', branch]), fix);
  assert.equal(store.kvGet(`guard:${t.key}`), '');
  assert.equal(store.kvGet(`publish-error:${t.key}`), '');
  assert.notEqual(store.getTicket(t.key).status, 'needs_human');
  await assert.rejects(sched.ownerApprovePublish(t.key), /nothing awaiting publish approval/, 'one approval per parked commit');
});

test('the owner\'s priority is pinned: the manager cannot override it; unpinning hands it back', () => {
  const t = store.createTicket({ title: 'pin me', status: 'todo' });
  sched.ownerPatch(t.key, { priority: 'P1' });
  assert.equal(store.getTicket(t.key).priority_pinned, 1);
  assert.throws(() => sched.ownerPatch(t.key, { priority: 'P3' }, { by: 'manager' }), /set by the owner/);
  assert.equal(store.getTicket(t.key).priority, 'P1');
  sched.ownerPatch(t.key, { unpin_priority: true });
  assert.equal(store.getTicket(t.key).priority_pinned, 0);
  sched.ownerPatch(t.key, { priority: 'P3' }, { by: 'manager' });
  assert.equal(store.getTicket(t.key).priority, 'P3'); assert.equal(store.getTicket(t.key).priority_pinned, 0);
  assert.equal(sched.ownerPatch(t.key, { unpin_priority: true }, { by: 'manager' }).priority_pinned, 0, 'only the owner unpins');
  // Created with a deliberate priority: pinned; the form's default P2 is not.
  assert.equal(sched.ownerCreate({ title: 'urgent thing', priority: 'P0' }).priority_pinned, 1);
  assert.equal(sched.ownerCreate({ title: 'normal thing', priority: 'P2' }).priority_pinned, 0);
});
