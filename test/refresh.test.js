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
  ({ config } = await import('../src/config.js')); config.root = tmp;
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
