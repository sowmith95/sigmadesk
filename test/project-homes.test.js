// Project homes in the per-user application folder: paths, the registry, and two desks running side by side.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { appRoot, deskPaths, projectHome } from '../src/app-paths.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-homes-')));
// Every desk this file starts is force-stopped at the end, whatever happened (an abandoned child keeps the file alive).
const spawned = new Set();
after(() => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* exited */ } } fs.rmSync(tmp, { recursive: true, force: true }); });
const repo = (name) => {
  const r = path.join(tmp, 'repos', name); fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', r]); fs.writeFileSync(path.join(r, 'README.md'), name);
  execFileSync('git', ['-C', r, 'add', '.']); execFileSync('git', ['-C', r, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']);
  return r;
};

test('the legacy layout is unchanged when no project home is set', () => {
  const p = deskPaths({ home: null, legacyRoot: '/opt/sd', env: {}, port: 8790 });
  assert.deepEqual([p.id, p.configFile, p.dataDir, p.dbPath, p.socketPath, p.workspaceRoot], ['legacy', '/opt/sd/sigmadesk.config.json', '/opt/sd/data', '/opt/sd/data/sigmadesk.db', '/opt/sd/run/agent.sock', '/opt/sd/workspaces']);
  assert.equal(deskPaths({ home: null, legacyRoot: '/opt/sd', env: { SIGMADESK_DB: '/x.db' } }).dbPath, '/x.db', 'explicit overrides still win');
});

test('a project home keeps data, sockets and workspaces apart; long socket paths get a unique short directory', () => {
  assert.equal(appRoot({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/SigmaDesk');
  assert.equal(appRoot({}, 'linux', '/home/a'), '/home/a/.local/share/sigmadesk');
  const home = projectHome('shop', '/Users/a/Library/Application Support/SigmaDesk');
  const p = deskPaths({ home, legacyRoot: '/opt/sd', env: {}, port: 8801 });
  assert.equal(p.configFile, `${home}/config.json`); assert.equal(p.dbPath, `${home}/data/sigmadesk.db`);
  assert.equal(p.workspaceRoot, '/Users/a/Library/Application Support/SigmaDesk/workspaces/shop', 'workspaces sit outside every project home');
  assert.equal(p.appRoot, '/Users/a/Library/Application Support/SigmaDesk');
  const deep = deskPaths({ home: path.join('/Users/a', 'x'.repeat(90), 'projects', 'one'), legacyRoot: '/', env: {}, port: 1 });
  assert.equal(deskPaths({ home: path.join('/Users/a', 'x'.repeat(90), 'projects', 'one'), legacyRoot: '/', env: {}, port: 2 }).socketPath, deep.socketPath, 'the same project on another port finds the same socket directory (and lock)');
  assert.equal(deep.runDir, path.join('/Users/a', 'x'.repeat(90), 'projects', 'one', 'run'), 'the lock stays in the project');
  const deep2 = deskPaths({ home: path.join('/Users/a', 'x'.repeat(90), 'projects', 'two'), legacyRoot: '/', env: {}, port: 1 });
  assert.ok(deep.socketPath.length <= 100);
  assert.notEqual(path.dirname(deep.socketPath), path.dirname(deep2.socketPath), 'two desks never share a socket directory');
  assert.notEqual(path.dirname(deep.socketPath), os.tmpdir());
});

test('the registry gives each project an id, a repo and a port of its own, with a neutral starting profile', async () => {
  const root = path.join(tmp, 'reg-app');
  const { createProject, listProjects } = await import('../src/projects.js');
  const a = createProject({ repoPath: repo('Shop Front'), root });
  assert.equal(a.id, 'shop-front');
  assert.throws(() => createProject({ repoPath: a.repoPath, id: 'other', root }), /already has a desk/);
  assert.throws(() => createProject({ repoPath: repo('dup'), id: 'shop-front', root }), /already exists/);
  const b = createProject({ repoPath: repo('Billing'), root });
  assert.notEqual(a.port, b.port);
  const cfg = JSON.parse(fs.readFileSync(path.join(a.home, 'config.json'), 'utf8'));
  assert.equal(cfg.pm.competitors.length, 0); assert.doesNotMatch(JSON.stringify(cfg), /trad|quant|options|market/i);
  assert.ok(fs.existsSync(path.join(a.home, 'playbook.md')));
  assert.deepEqual(listProjects(root).map((p) => p.id), ['shop-front', 'billing']);
  assert.equal((fs.statSync(path.join(root, 'projects.json')).mode & 0o777), 0o600);
});

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
const startDesk = (home, port, app) => track(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, SIGMADESK_HOME: home, SIGMADESK_PORT: String(port), SIGMADESK_APP_ROOT: app, SIGMADESK_CONFIG: '', SIGMADESK_DB: '', SIGMADESK_SOCKET: '', SIGMADESK_WORKSPACES: '', SIGMADESK_DATA: '' },
  stdio: ['ignore', 'pipe', 'pipe'] }));
function track(c) { spawned.add(c); c.on('exit', () => spawned.delete(c)); c.stdout.resume(); return c; }
const ready = async (port) => { for (let i = 0; i < 240; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/state`); if (r.ok) return r.json(); } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`desk on ${port} never became ready`); };
// Resolves with the exit code; a desk that has not exited after `ms` is force-killed (the code is then null).
const exitOf = (child, ms = 20_000) => new Promise((r) => {
  if (child.exitCode !== null) return r(child.exitCode);
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } }, ms);
  child.on('exit', (code) => { clearTimeout(t); r(code); });
});

test('two project desks run side by side, refuse a duplicate, and restart independently', { timeout: 240_000 }, async () => {
  const app = path.join(tmp, 'app');
  const { createProject } = await import('../src/projects.js');
  const [pa, pb] = [await freePort(), await freePort()];
  const A = createProject({ repoPath: repo('alpha'), port: pa, root: app });
  const B = createProject({ repoPath: repo('beta'), port: pb, root: app });
  const procs = [];
  try {
    let a = startDesk(A.home, pa, app); procs.push(a);
    const b = startDesk(B.home, pb, app); procs.push(b);
    const [sa, sb] = [await ready(pa), await ready(pb)];
    assert.equal(sa.meta.project, 'alpha'); assert.equal(sb.meta.project, 'beta');
    const mk = (port, title) => fetch(`http://127.0.0.1:${port}/api/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then((r) => r.json());
    const [ta, tb] = [await mk(pa, 'Alpha thing'), await mk(pb, 'Beta thing')];
    assert.match(ta.key, /^ALP-1$/); assert.match(tb.key, /^BET-1$/, 'each desk numbers its own tickets');
    const locks = [[A, pa], [B, pb]].map(([P, port]) => path.join(deskPaths({ home: P.home, legacyRoot: P.home, env: {}, port }).runDir, 'desk.lock'));
    for (const h of [A.home, B.home]) assert.ok(fs.existsSync(path.join(h, 'data', 'sigmadesk.db')));
    assert.ok(locks.every((l) => fs.existsSync(l))); assert.notEqual(locks[0], locks[1], 'each desk has its own lock and socket directory');
    // A second copy of desk A is refused before it touches A's database.
    const dup = startDesk(A.home, await freePort(), app); procs.push(dup);
    let err = ''; dup.stderr.on('data', (d) => { err += d; });
    assert.equal(await exitOf(dup), 1); assert.match(err, /already running for this project/);
    // Restart A; B keeps serving throughout.
    a.kill('SIGTERM'); await exitOf(a);
    assert.equal((await ready(pb)).meta.project, 'beta');
    a = startDesk(A.home, pa, app); procs.push(a);
    const again = await ready(pa);
    assert.ok(again.tickets.some((t) => t.key === 'ALP-1'), 'desk A restarted with its own state');
  } finally { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* exited */ } } await Promise.all(procs.map((p) => exitOf(p, 10_000))); }
});
