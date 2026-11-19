// Builder workspaces are copy-on-write copies of the desk's trusted template's .git (2026-11-18): base history only,
// object files shared on disk until a seat rewrites them, yet behaving like the `git clone` they replace — no
// template filters, raw committed bytes, the owner's CURRENT origin and base. Local git fixtures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-cow-')));
const remote = path.join(tmp, 'remote.git');
const repo = path.join(tmp, 'repo');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const commit = (msg) => g(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', msg);
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
// A length-preserving round-trip filter the OWNER defines: the template smudges note.up to upper case.
fs.writeFileSync(path.join(repo, '.gitattributes'), '*.up filter=upper\n');
fs.writeFileSync(path.join(repo, 'note.up'), 'quiet text\n');
g(repo, 'add', '.'); commit('fixture');
g(repo, 'config', 'filter.upper.smudge', 'tr a-z A-Z'); g(repo, 'config', 'filter.upper.clean', 'tr A-Z a-z');
g(repo, 'remote', 'add', 'origin', remote); g(repo, 'push', '-q', 'origin', 'main');
fs.mkdirSync(path.join(repo, 'web', 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(repo, 'web', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

// core.checkStat=minimal: the stat cache trusts only mtime + size, so a smudged file whose index entry was copied from
// the template could survive a checkout and still read as clean. The workspace must hold raw bytes regardless.
const globalCfg = path.join(tmp, 'gitconfig');
fs.writeFileSync(globalCfg, '[core]\n\tcheckStat = minimal\n\ttrustctime = false\n');
process.env.GIT_CONFIG_GLOBAL = globalCfg;

const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'W', copyPaths: ['web/node_modules'] }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false }, sandbox: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, runner;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  (await import('../src/db.js')).openDb(':memory:');
  runner = await import('../src/runner.js');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const objectFiles = (gitDir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p); } };
  walk(path.join(gitDir, 'objects'));
  return out;
};
const leftovers = () => fs.readdirSync(config.workspaceRoot).filter((n) => n.startsWith('.stage-'));

test('a builder workspace is a copy of the template .git: own inodes, raw bytes, no template filters, current base', async () => {
  const tpl = await runner.scratchTemplate({ force: true });
  assert.equal(fs.readFileSync(path.join(tpl, 'note.up'), 'utf8'), 'QUIET TEXT\n', 'the template is smudged (precondition)');
  // The base moves AFTER the template was built; the template (fetched <10 min ago) is reused, not rebuilt.
  fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n'); g(repo, 'add', '.'); commit('later'); g(repo, 'push', '-q', 'origin', 'main');
  const { dir, branch } = await runner.ensureWorkspace({ key: 'W-1', title: 'First ticket' });
  assert.equal(branch, 'sigmadesk/w-1-first-ticket');
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  assert.equal(g(dir, 'rev-parse', 'origin/main'), g(repo, 'rev-parse', 'main'), 'branched from the current base, not the template\'s');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), g(repo, 'rev-parse', 'main'));
  assert.equal(fs.readFileSync(path.join(dir, 'note.up'), 'utf8'), 'quiet text\n', 'the committed bytes, not the template\'s smudged ones');
  assert.equal(g(dir, 'status', '--porcelain'), '', 'clean');
  assert.throws(() => g(dir, 'config', '--local', '--get-regexp', '^filter\\.'), 'no filter driver copied from the template');
  assert.equal(fs.existsSync(path.join(dir, '.git', 'info', 'attributes')), false);
  assert.equal(g(dir, 'remote', 'get-url', 'origin'), remote, 'the owner\'s origin');
  assert.equal(fs.readFileSync(path.join(dir, 'web', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n', 'copyPaths still copied');
  assert.deepEqual(leftovers(), []);

  // Every object file the copy shares with the template is its own inode, never a hardlink, and a byte written to
  // the copy's object never reaches the template's.
  const tplObjects = new Map(objectFiles(path.join(tpl, '.git')).map((p) => [path.relative(path.join(tpl, '.git'), p), p]));
  const shared = objectFiles(path.join(dir, '.git')).filter((p) => tplObjects.has(path.relative(path.join(dir, '.git'), p)));
  assert.ok(shared.length > 0, 'the copy came from the template');
  for (const p of shared) {
    const t = tplObjects.get(path.relative(path.join(dir, '.git'), p));
    assert.notEqual(fs.statSync(p).ino, fs.statSync(t).ino);
    assert.equal(fs.statSync(p).nlink, 1);
  }
  const before = fs.readFileSync(tplObjects.get(path.relative(path.join(dir, '.git'), shared[0])));
  fs.chmodSync(shared[0], 0o644); fs.writeFileSync(shared[0], 'seat wrote this');
  assert.deepEqual(fs.readFileSync(tplObjects.get(path.relative(path.join(dir, '.git'), shared[0]))), before, 'the template object is untouched');
  // The template itself is still intact (its tree manifest and stamp), so the next copy needs no rebuild.
  const stamp = JSON.parse(fs.readFileSync(`${runner.templateDir()}.stamp.json`, 'utf8'));
  assert.equal(runner.treeManifest(tpl), stamp.manifest);
});

test('an existing workspace is reused as is', async () => {
  const { dir } = await runner.ensureWorkspace({ key: 'W-2', title: 'Second' });
  fs.writeFileSync(path.join(dir, 'work-in-progress.txt'), 'mine\n');
  const head = g(dir, 'rev-parse', 'HEAD');
  const again = await runner.ensureWorkspace({ key: 'W-2', title: 'Second' });
  assert.equal(again.dir, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'work-in-progress.txt'), 'utf8'), 'mine\n');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
});

test('a ticket branch that already exists on origin is checked out from it', async () => {
  g(repo, 'checkout', '-q', '-b', 'sigmadesk/w-3-pushed');
  fs.writeFileSync(path.join(repo, 'branch.txt'), 'b\n'); g(repo, 'add', '.'); commit('on the branch');
  g(repo, 'push', '-q', 'origin', 'sigmadesk/w-3-pushed'); const tip = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'checkout', '-q', 'main');
  const { dir } = await runner.ensureWorkspace({ key: 'W-3', title: 'Pushed' });
  assert.equal(g(dir, 'rev-parse', 'HEAD'), tip);
});

test('the owner\'s origin removed at an unchanged base: the copy uses the local checkout, not the stale URL', async () => {
  g(repo, 'remote', 'remove', 'origin');
  try {
    const { dir } = await runner.ensureWorkspace({ key: 'W-4', title: 'Local only' });
    assert.equal(g(dir, 'remote', 'get-url', 'origin'), repo);
    assert.equal(g(dir, 'rev-parse', 'origin/main'), g(repo, 'rev-parse', 'main'));
  } finally { g(repo, 'remote', 'add', 'origin', remote); }
});

test('the template cannot be built: the old full clone is used instead', async () => {
  const pub = path.join(config.dataDir, 'publisher.git'), aside = `${pub}.aside`;
  fs.renameSync(pub, aside); fs.writeFileSync(pub, 'not a repository'); // publisher() cannot init over a file
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  try {
    const { dir } = await runner.ensureWorkspace({ key: 'W-5', title: 'Fallback' });
    assert.match(warned.join('\n'), /template copy failed/);
    assert.equal(g(dir, 'rev-parse', 'origin/main'), g(repo, 'rev-parse', 'main'));
    assert.equal(g(dir, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(dir, 'note.up'), 'utf8'), 'quiet text\n', 'a plain clone never had the filter');
    assert.deepEqual(leftovers(), []);
  } finally { console.warn = warn; fs.rmSync(pub, { force: true }); fs.renameSync(aside, pub); }
});

test('a base that cannot be fetched fails the ticket, with no second clone and nothing left behind', async () => {
  g(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  try {
    await assert.rejects(runner.ensureWorkspace({ key: 'W-6', title: 'No remote' }));
    assert.equal(fs.existsSync(path.join(config.workspaceRoot, 'W-6')), false, 'no half-built workspace for the next call to trust');
    assert.deepEqual(leftovers(), []);
    assert.doesNotMatch(warned.join('\n'), /cloning the owner's checkout/, 'a fetch failure is not retried as a full clone');
  } finally { console.warn = warn; g(repo, 'remote', 'set-url', 'origin', remote); }
});

test('something already in the workspace\'s place is kept and refused; an empty dir is replaced', async () => {
  const busy = path.join(config.workspaceRoot, 'W-7');
  fs.mkdirSync(busy, { recursive: true }); fs.writeFileSync(path.join(busy, 'keep.txt'), 'keep\n');
  await assert.rejects(runner.ensureWorkspace({ key: 'W-7', title: 'Busy' }), /non-empty workspace/);
  assert.equal(fs.readFileSync(path.join(busy, 'keep.txt'), 'utf8'), 'keep\n');
  assert.deepEqual(leftovers(), []);
  fs.mkdirSync(path.join(config.workspaceRoot, 'W-8'));
  const { dir } = await runner.ensureWorkspace({ key: 'W-8', title: 'Empty' });
  assert.equal(g(dir, 'status', '--porcelain'), '');
});

test('review round 3: a filter lookup that FAILS (not "none found") never keeps the template filters', async () => {
  // A git wrapper that fails only the copy's filter lookup with exit 128, as a broken config read would.
  const real = config.bins.git, wrap = path.join(tmp, 'git-wrap.sh');
  fs.writeFileSync(wrap, `#!/bin/sh\ncase "$*" in *"--get-regexp ^filter"*) exit 128;; esac\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  config.bins.git = wrap;
  try {
    const { dir } = await runner.ensureWorkspace({ key: 'W-9', title: 'Lookup fails' });
    assert.match(warned.join('\n'), /template copy failed/, 'it fell back to a plain clone');
    assert.equal(fs.readFileSync(path.join(dir, 'note.up'), 'utf8'), 'quiet text\n');
    assert.throws(() => g(dir, 'config', '--local', '--get-regexp', '^filter\\.'));
  } finally { config.bins.git = real; console.warn = warn; }
});

test('review round 3: closing a ticket while its workspace is being built leaves nothing behind', async () => {
  const building = runner.ensureWorkspace({ key: 'W-10', title: 'Closed mid build' }); // holds the git lock first
  const removing = runner.removeWorkspace('W-10'); // queued behind the build, not racing it
  await building; await removing;
  assert.equal(fs.existsSync(path.join(config.workspaceRoot, 'W-10')), false, 'the finished build does not reappear');
  assert.deepEqual(leftovers(), []);
});

test('review round 3: build stages a crashed process left are removed (by the next build of that ticket, by removal, at startup)', async () => {
  const plant = (name) => { const d = path.join(config.workspaceRoot, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); fs.writeFileSync(path.join(d, 'big.txt'), 'x'); return d; };
  const a = plant('.stage-W-11-99991');
  await runner.ensureWorkspace({ key: 'W-11', title: 'After a crash' });
  assert.equal(fs.existsSync(a), false, 'the next build of the ticket clears it');
  const b = plant('.stage-W-12-99992');
  await runner.removeWorkspace('W-12');
  assert.equal(fs.existsSync(b), false, 'closing the ticket clears it');
  const c = plant('.stage-W-13-99993'), keep = plant('.stage-notes'); // not a build stage (no pid): left alone
  const other = path.join(config.workspaceRoot, 'W-11');
  await runner.sweepStages();
  assert.equal(fs.existsSync(c), false, 'the startup sweep clears it');
  assert.ok(fs.existsSync(keep) && fs.existsSync(path.join(other, '.git')), 'nothing else is touched');
  fs.rmSync(keep, { recursive: true, force: true });
});
