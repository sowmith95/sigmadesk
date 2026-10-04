// Git history operations belong to the desk. Agents only resolve file contents.
// Rebase state/config live in desk data; no privileged command uses a seat's .git.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, publisherPath } from './config.js';
import * as store from './db.js';
import { stageApproved, workspaceDir, withGitLock } from './runner.js';

const exec = promisify(execFile);
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.sshCommand=ssh', '-c', 'commit.gpgSign=false'];
const SHA = /^[0-9a-f]{40}$/;
const fail = (s) => { throw Object.assign(new Error(s), { status: 409 }); };
export function current(key) { return JSON.parse(store.kvGet(`refresh:${key}`) || 'null'); }
export function publicState(key) { const r = current(key); if (!r) return null; const { manifest, ...safe } = r; return safe; }
function save(key, p) {
  const r = { ...current(key), ...p, updated_at: store.now() }; store.kvSet(`refresh:${key}`, JSON.stringify(r));
  store.bus.emit('msg', { type: 'branch-refresh', data: { ticket_key: key, ...publicState(key) } });
  return r;
}
export function qaEvidence(key) { return JSON.parse(store.kvGet(`refresh-qa:${key}`) || 'null'); }
export function recordQa(key, head) {
  const r = current(key);
  if (r) {
    if (!['rebased', 'published'].includes(r.status) || !SHA.test(head)) fail('Finish the desk rebase before QA');
    if (r.status === 'published') save(key, { status: 'rebased' });
    store.kvSet(`refresh-qa:${key}`, JSON.stringify({ head, base: r.base }));
  }
}
export function validationBlockers(key, head, base) {
  const r = current(key); if (!r) return [];
  const q = qaEvidence(key);
  return r.status !== 'rebased' && r.status !== 'published' || !q || q.head !== head || q.base !== base
    ? ['branch refresh requires fresh QA on this exact head and current base'] : [];
}
export function published(key, head) {
  const r = current(key);
  if (r?.reservation) store.releaseReservation(key, r.reservation, 'refresh'); // the branch is free for the merge train again
  return save(key, { status: 'published', published_head: head, remote_head: head });
}

const env = () => {
  const e = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
  for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(k)) delete e[k];
  return e;
};
const git = (dir, args) => exec(config.bins.git, [...SAFE, '-C', dir, ...args], { env: env(), timeout: 180000, maxBuffer: 32 << 20 });
const lines = (s) => s.split('\0').filter(Boolean);
const trustedDir = (key) => path.join(config.dataDir, 'refresh', key);

// Check each ancestor, including the workspace itself. Never follow agent symlinks.
function safePath(root, rel = '') {
  if (path.isAbsolute(rel) || rel.split('/').includes('..')) fail('Unsafe workspace path');
  let p = root;
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    if (part) p = path.join(p, part);
    if (fs.existsSync(p) || (() => { try { fs.lstatSync(p); return true; } catch { return false; } })()) {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) fail(`Unsupported workspace path: ${rel || root}`);
    }
  }
  return p;
}
function fingerprint(root, rel) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p)) return null;
  if (!fs.lstatSync(p).isFile()) fail(`Expected a file: ${rel}`);
  return `${fs.statSync(p).mode & 0o777}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
}

async function materialize(key) {
  const dir = trustedDir(key), ws = workspaceDir(key), r = current(key);
  const names = [...new Set(lines((await git(dir, ['ls-files', '-z'])).stdout))];
  const old = Object.keys(r.manifest || {});
  // A newly tracked path must not clobber an untracked file/dependency in the seat.
  for (const name of names) {
    const target = safePath(ws, name); safePath(dir, name);
    if (!old.includes(name) && fs.existsSync(target)) fail(`Refresh would overwrite an untracked file: ${name}`);
  }
  for (const name of old.filter((n) => !names.includes(n))) {
    const p = safePath(ws, name); if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  for (const name of names) {
    const src = safePath(dir, name), dst = safePath(ws, name);
    if (!fs.existsSync(src)) { if (fs.existsSync(dst)) fs.unlinkSync(dst); continue; }
    if (!fs.lstatSync(src).isFile()) fail(`Unsupported tracked file: ${name}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
  }
  // Independent metadata copy for ordinary sandboxed status/diff/commit commands.
  const metadata = safePath(ws, '.git');
  if (!fs.lstatSync(metadata).isDirectory()) fail('Workspace must be an isolated clone');
  fs.cpSync(metadata, `${dir}-seat-metadata-${Date.now()}`, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(metadata, { recursive: true });
  fs.cpSync(path.join(dir, '.git'), metadata, { recursive: true });
  return Object.fromEntries(names.map((n) => [n, fingerprint(ws, n)]));
}

async function settle(key) {
  const dir = trustedDir(key);
  const conflicts = [...new Set(lines((await git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout))];
  const rebasing = fs.existsSync(path.join(dir, '.git', 'rebase-merge')) || fs.existsSync(path.join(dir, '.git', 'rebase-apply'));
  if (rebasing && !conflicts.length) fail('Rebase stopped without file conflicts; inspect the preserved desk recovery clone');
  const manifest = await materialize(key);
  return save(key, { status: conflicts.length ? 'conflicts' : 'rebased', conflicts, manifest,
    head: (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim() });
}

/**
 * `reservation`: the ticket reservation the caller took synchronously as its first step (ownerRefreshBase). Called
 * without one (standalone/tests), prepare takes it itself before any await. It is held until the refreshed branch is
 * published, or released here if preparation fails before any refresh state was saved.
 */
export async function prepare(ticket, { reservation = null } = {}) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket.key) || !SHA.test(ticket.head_sha) || !ticket.branch || ticket.branch.startsWith('-')) fail('A submitted branch is required');
  const previous = current(ticket.key);
  if (previous && !['published', 'rebased'].includes(previous.status)) fail('A refresh is already pending; finish or inspect its preserved recovery clone');
  let token = reservation;
  if (token) { if (store.reservationOf(ticket.key)?.token !== token) fail('The refresh no longer holds this ticket\'s reservation'); }
  else {
    const r = store.reserve(ticket.key, 'refresh', 'owner branch refresh');
    if (!r.ok) fail(`This branch is busy (${r.holder.note || r.holder.kind}); wait for it to finish`);
    token = r.token;
  }
  try { return await prepareClaimed(ticket, previous, token); }
  catch (err) {
    const st = current(ticket.key);
    if (!(['preparing', 'conflicts', 'rebased'].includes(st?.status) && st?.reservation === token)) store.releaseReservation(ticket.key, token);
    throw err;
  }
}
async function prepareClaimed(ticket, previous, reservation) {
  // stageApproved extracts the exact submitted objects into the trusted publisher.
  await stageApproved(ticket.key, workspaceDir(ticket.key), ticket.head_sha);
  return withGitLock(async () => {
    const key = ticket.key, ws = workspaceDir(key), dir = trustedDir(key);
    safePath(config.workspaceRoot, key); safePath(ws, '.git');
    if (fs.existsSync(dir)) fs.renameSync(dir, `${dir}-${Date.now()}-backup`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await exec(config.bins.git, [...SAFE, 'clone', '-q', '--no-hardlinks', '--no-checkout', publisherPath(), dir], { env: env() });
    await git(dir, ['check-ref-format', '--branch', ticket.branch]);
    await git(dir, ['config', 'user.name', 'SigmaDesk']); await git(dir, ['config', 'user.email', 'desk@local.invalid']);
    await git(dir, ['checkout', '-q', '-b', ticket.branch, ticket.head_sha]);
    const { stdout: url } = await git(config.project.repoPath, ['remote', 'get-url', 'origin']);
    await git(dir, ['remote', 'set-url', 'origin', url.trim()]);
    // Fetch must succeed. Cached local refs are insufficient for a refresh.
    await git(dir, ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${config.project.baseBranch}:refs/remotes/origin/${config.project.baseBranch}`, `+refs/heads/${ticket.branch}:refs/remotes/origin/${ticket.branch}`]);
    const base = (await git(dir, ['rev-parse', `origin/${config.project.baseBranch}`])).stdout.trim();
    const remote_head = (await git(dir, ['rev-parse', `origin/${ticket.branch}`])).stdout.trim();
    if (remote_head !== ticket.head_sha && remote_head !== previous?.published_head) fail('Remote branch changed; reconcile its commits before rebasing');
    // Trusted index/config, seat worktree. This checks edits without executing seat hooks or filters.
    const names = lines((await git(dir, ['ls-files', '-z'])).stdout);
    const manifest = Object.fromEntries(names.map((n) => [n, fingerprint(ws, n)]));
    const dirty = (await git(dir, [`--work-tree=${ws}`, 'diff', '--name-only', ticket.head_sha, '--'])).stdout.trim();
    if (dirty) fail(`Commit or preserve local edits before refresh: ${dirty.slice(0, 240)}`);
    save(key, { status: 'preparing', original_head: ticket.head_sha, remote_head, base, branch: ticket.branch, conflicts: [], manifest, head: null, published_head: null, reservation });
    store.kvSet(`refresh-qa:${key}`, 'null');
    try {
      await git(dir, ['branch', 'desk-original', ticket.head_sha]);
      await git(dir, ['rebase', base]);
    } catch (err) {
      if (!(await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim()) throw err;
    }
    return settle(key);
  });
}

export function continueRebase(key) {
  return withGitLock(async () => {
    const r = current(key); if (r?.status !== 'conflicts') fail('No desk rebase is awaiting conflict resolution');
    const ws = workspaceDir(key), dir = trustedDir(key);
    for (const [name, hash] of Object.entries(r.manifest)) {
      if (!r.conflicts.includes(name) && fingerprint(ws, name) !== hash) fail(`Only resolve the listed conflicts before continuing: ${name}`);
    }
    const resolutions = [];
    for (const name of r.conflicts) {
      const src = safePath(ws, name);
      if (fs.existsSync(src)) {
        if (!fs.lstatSync(src).isFile()) fail(`Expected conflict file: ${name}`);
        const data = fs.readFileSync(src);
        if (/^(<<<<<<< |=======\r?$|>>>>>>> )/m.test(data.toString('utf8'))) fail(`Conflict markers remain in ${name}`);
        resolutions.push({ name, data, mode: fs.statSync(src).mode & 0o777 });
      } else resolutions.push({ name, data: null });
    }
    // Persist the transition before mutating Git state: a restart must not replay a completed step.
    save(key, { status: 'preparing' });
    for (const { name, data, mode } of resolutions) {
      const dst = safePath(dir, name);
      if (data != null) {
        fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, data);
        fs.chmodSync(dst, mode);
      } else if (fs.existsSync(dst)) fs.unlinkSync(dst);
    }
    await git(dir, ['add', '--all', '--', ...r.conflicts]);
    try { await git(dir, ['rebase', '--continue']); }
    catch (err) { if (!(await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim()) throw err; }
    return settle(key);
  });
}

export const instructions = (r) => r.status === 'conflicts'
  ? `Desk rebase onto ${r.base.slice(0, 10)} has conflicts in: ${r.conflicts.join(', ')}. Edit only these files, preserving both features. Do not commit, stage, rebase or fetch. Run desk continue-rebase after resolving them. Then run all required tests and desk submit; independent QA must rerun.`
  : `Desk rebased onto ${r.base.slice(0, 10)}. Recheck the combined behavior, run the required tests, and desk submit for fresh independent QA. Do not fetch, rebase or push.`;
