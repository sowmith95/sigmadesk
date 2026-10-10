// The project registry and project homes (phase 1: the CLI uses this; the onboarding wizard will use the same calls).
// projects.json in the application folder is the registry: one entry per project with an immutable id, a display
// name, the repo, the desk's port and its service label. Writes are atomic (temp file + rename) under a lock file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appRoot, projectHome, deskPaths, ID_RE } from './app-paths.js';
import { compileTeam, teamCoverage, CORE_IDS } from './team-catalog.js';

const registryFile = (root) => path.join(root, 'projects.json');
const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

export function readRegistry(root = appRoot()) {
  try { return JSON.parse(fs.readFileSync(registryFile(root), 'utf8')); } catch (err) { if (err.code === 'ENOENT') return { version: 1, projects: [] }; throw err; }
}
function withRegistry(root, fn) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'projects.lock');
  let fd;
  for (let i = 0; i < 50 && fd === undefined; i++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); // abandoned by a crash
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (fd === undefined) throw new Error('the project registry is busy; try again');
  try {
    const reg = readRegistry(root);
    const out = fn(reg);
    const tmp = `${registryFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, registryFile(root));
    return out;
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

/** What a git checkout tells us without running anything in it (read-only: no scripts, no installs, no submodules). */
export function inspectRepo(repoPath) {
  const p = path.resolve(String(repoPath || ''));
  if (!fs.existsSync(path.join(p, '.git'))) bad(`${p} is not a git checkout`);
  const git = (...args) => { try { return execFileSync('git', ['-C', p, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const origin = git('remote', 'get-url', 'origin');
  const githubRepo = origin.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] || '';
  const head = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '') || git('rev-parse', '--abbrev-ref', 'HEAD') || 'main';
  return { repoPath: p, name: path.basename(p), githubRepo, baseBranch: head === 'HEAD' ? 'main' : head, hasOrigin: !!origin };
}

/**
 * A neutral starting profile for a new project: no trading persona, competitors or market window, research off until
 * the owner asks for it, and reviewers drawn from the engineering seats every project has. Legacy defaults are untouched.
 */
export function genericConfig({ name, repo, port, prefix }) {
  return {
    project: { name, repoPath: repo.repoPath, githubRepo: repo.githubRepo, baseBranch: repo.baseBranch, ticketPrefix: prefix, branchPrefix: 'sigmadesk/', playbook: 'playbook.md' },
    server: { port },
    github: { sync: false },
    pm: { enabled: false, persona: 'the people who use this project every day', competitors: [] },
    research: { programs: [], review: { minReviewers: 1, reviewers: ['principal-be', 'principal-fe', 'manager'] } },
    limits: { busyWindow: { enabled: false } },
  };
}
const PLAYBOOK = (name) => `# ${name}: how to work here

Describe what this project is, who uses it, and how to build and test it. Every seat reads this file.

## Build and test
- (the commands that prove a change works)

## Never touch without the owner
- (paths, systems or data that need a human decision)

## Standing rules the EM may apply alone
<!-- Yours alone: the desk and its seats never write here. A delegate (Settings → Autonomy) decides for you only under a
     rule listed in this section, and must cite it; left empty, every delegated decision stays yours. -->
`;

const usedPorts = (reg) => new Set(reg.projects.map((p) => p.port));
export function nextPort(reg, from = 8800) { let p = from; while (usedPorts(reg).has(p)) p += 1; return p; }

/** Create a project home for a git checkout and register it. Nothing starts: installing the service is a separate step. */
/** Validate a team manifest the way the desk will at startup: catalog problems and workflow coverage. */
export function checkTeam(team) {
  const compiled = compileTeam(team);
  const seats = [...CORE_IDS.map((id) => ({ id, enabled: compiled.core[id]?.enabled !== false })), ...compiled.advisors.map((a) => ({ id: a.id, enabled: true }))];
  return [...compiled.problems, ...(compiled.problems.length ? [] : teamCoverage(seats))];
}
export function createProject({ repoPath, name, id, port, team = { version: 1, advisors: [] }, root = appRoot() } = {}) {
  const teamProblems = checkTeam(team);
  if (teamProblems.length) bad(`the team is not valid: ${teamProblems.join('; ')}`);
  const repo = inspectRepo(repoPath);
  const display = String(name || repo.name).trim().slice(0, 80);
  return withRegistry(root, (reg) => {
    const pid = id || slugify(display);
    if (!ID_RE.test(pid)) bad('project id: 2-40 characters, lowercase letters, digits and dashes');
    if (reg.projects.some((p) => p.id === pid)) bad(`a project called ${pid} already exists`);
    if (reg.projects.some((p) => p.repoPath === repo.repoPath)) bad(`${repo.repoPath} already has a desk`);
    const deskPort = Number(port) || nextPort(reg);
    if (usedPorts(reg).has(deskPort)) bad(`port ${deskPort} is used by another project`);
    const home = projectHome(pid, root);
    const paths = deskPaths({ home, legacyRoot: home, env: {}, port: deskPort });
    for (const d of [home, paths.dataDir, paths.runDir, paths.workspaceRoot]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const prefix = (display.replace(/[^A-Za-z]/g, '').slice(0, 3) || 'SD').toUpperCase();
    fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(genericConfig({ name: display, repo, port: deskPort, prefix }), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(home, 'playbook.md'), PLAYBOOK(display), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(home, 'team.json'), `${JSON.stringify(team, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const entry = { id: pid, uid: crypto.randomUUID(), name: display, repoPath: repo.repoPath, githubRepo: repo.githubRepo, port: deskPort,
      service: `com.sigmadesk.${pid}`, home, created_at: new Date().toISOString(), state: 'created' };
    reg.projects.push(entry);
    return { ...entry, paths };
  });
}

export function listProjects(root = appRoot()) { return readRegistry(root).projects; }
export function getProject(id, root = appRoot()) { return readRegistry(root).projects.find((p) => p.id === id) || null; }
export function updateProject(id, patch, root = appRoot()) {
  return withRegistry(root, (reg) => { const p = reg.projects.find((x) => x.id === id); if (!p) bad(`no project ${id}`); Object.assign(p, patch); return p; });
}
