// Package installs for seats (#8): a typed capability, separate from production probe grants.
//
// Seats have no network and the shared project venv is read-only to them. When a seat needs a Python package:
//  1. it asks with exact pins: `desk pkg request name==version [...] --why "…"` (canonical names; no extras, markers,
//     URLs, ranges or options), within per-seat, per-run and global budgets for unapproved sets;
//  2. the DESK resolves the full set with the shared venv's interpreter and pip, started with no startup hooks
//     (`-I -S`, pip run from its directory, so no .pth or sitecustomize of the shared venv executes), in a scrubbed
//     environment, temp cwd and hard time and disk limits, wheels only, `--index-url https://pypi.org/simple` only. The
//     constraints are the COMPLETE ticket lock — the shared venv's distributions, read statically from their METADATA
//     (no code runs), plus what was already approved for this ticket — so nothing existing changes version. pip's
//     answer is only a PROPOSAL: every wheel is then re-downloaded by the desk's own HTTPS client (files.pythonhosted.org
//     only, redirects re-checked, one deadline, size caps), bound to the sha256 of the report, and read back without
//     executing anything: its RECORD is checked file by file and becomes the exact inventory it installs. The set is
//     staged under data/pkg/<id>/ (desk-owned, read-only);
//  3. the OWNER approves the manifest in the Inbox (every wheel, transitive ones too, versions, sizes, hashes, startup
//     hooks). Probe `*`, owner-mention auto-grants and post-deploy grants never cover packages;
//  4. the seat's next run on that ticket can read that stage (and only that stage), and `desk pkg install` installs it
//     OFFLINE inside its sandbox into <workspace>/.venv, layered read-only on the shared venv through a .pth file,
//     with --no-index --no-deps --require-hashes and pip run from a wheel in the stage, then checks imports and the
//     added distributions' requirements;
//  5. the desk reads the venv back (never executing it): interpreter identity, every installed file hashed against the
//     approved inventories, no unexpected file or startup hook, the shared venv unchanged since approval. That
//     fingerprint is recorded; QA passes only through `desk test`, which runs the canonical interpreter and records the
//     real exit status with the fingerprint and commit.
// Revoking, expiry or the ticket closing ends the grant: in-flight resolution is cancelled, the stage is deleted and
// further installs are refused (what was already installed stays in that one workspace, which dies with the ticket).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import { agentById } from './team.js';
import { notify } from './notify.js';
import * as net from './netfetch.js';
import { wheelInventory } from './wheel.js';
import { startProxy, RESOLVER_HOSTS } from './pkgproxy.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const nowIso = () => new Date().toISOString();
const nameOf = (seat) => agentById[seat]?.name || seat;
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const mb = (n) => `${(Number(n || 0) / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
const P = () => config.packages || {};

export const PYPI_INDEX = 'https://pypi.org/simple';
export const FILE_HOSTS = ['files.pythonhosted.org'];
/** Run kinds that may request and install packages: the ones that build on their own ticket. */
export const INSTALL_KINDS = new Set(['implement', 'respond', 'resolve']);
const OPEN = ['resolving', 'owner', 'approved'];
const PENDING = ['resolving', 'owner'];
const CLOSED_TICKET = ['done', 'wontdo'];

// ---------------- parsing ----------------
/** PEP 503 normalized name. */
export const canonicalName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION_RE = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;
/** `name==version` pins → [{name, version}] (canonical names), or a plain refusal. */
export function parseSpecs(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/\s+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!arr.length) throw err('name the packages: desk pkg request name==version [...] --why "<what needs it>"');
  const max = Number(P().maxPackages) || 10;
  if (arr.length > max) throw err(`at most ${max} packages per request`);
  const out = [];
  for (const s of arr) {
    if (s.startsWith('-')) throw err(`pip options are not accepted (${s}): only name==version pins`);
    if (/[[\]]/.test(s)) throw err(`extras are not accepted (${s}): pin the extra's packages themselves`);
    if (s.includes(';')) throw err(`environment markers are not accepted (${s})`);
    if (/@|:\/\/|[/\\]/.test(s)) throw err(`URLs and paths are not accepted (${s}): packages come from PyPI only`);
    const m = s.match(/^([^=<>!~*\s]+)==([^=<>!~*\s,]+)$/);
    if (!m) throw err(`"${s}" must be an exact pin name==version (no ranges, wildcards or other operators)`);
    if (!NAME_RE.test(m[1])) throw err(`"${m[1]}" is not a valid package name`);
    const version = m[2].toLowerCase();
    if (!VERSION_RE.test(version)) throw err(`"${m[2]}" is not an exact public release version (e.g. 1.4.2, 2.0rc1)`);
    const name = canonicalName(m[1]);
    if (out.some((x) => x.name === name)) throw err(`${name} is listed twice`);
    out.push({ name, version });
  }
  return out;
}

// ---------------- reading files without following seat links ----------------
function readSmall(p, max = 262_144) {
  let st; try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.size > max) return null;
  return fs.readFileSync(p, 'utf8');
}
const realDir = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

// ---------------- the shared environment ----------------
/**
 * The shared venv: interpreter, its directory, Python version and site-packages. Throws when none is configured, or
 * when the interpreter (or what it resolves to) lives anywhere a seat can write: the desk runs it unsandboxed.
 */
export function sharedEnv() {
  const configured = P().python;
  const ro = (config.project.readOnlyPaths || []).filter(Boolean);
  const fromRo = ro.find((p) => fs.existsSync(path.join(p, 'pyvenv.cfg')) && fs.existsSync(path.join(p, 'bin', 'python')));
  const python = configured || (fromRo ? path.join(fromRo, 'bin', 'python') : '');
  if (!python || !fs.existsSync(python)) throw err('no shared Python environment is configured (packages.python, or a venv in project.readOnlyPaths)', 409);
  const venv = path.dirname(path.dirname(python));
  if (!configured && !ro.includes(venv)) throw err(`${venv} is not the configured shared venv`, 409);
  const untrusted = [config.workspaceRoot, ...(P().untrustedRoots || [])].filter(Boolean).map(realpath);
  for (const p of [python, venv]) {
    const r = realpath(p);
    const hit = untrusted.find((u) => inside(r, u) || inside(path.resolve(p), u));
    if (hit) throw err(`the shared interpreter ${p} is under ${hit}, where seats can write: refused`, 409);
  }
  const cfg = readSmall(path.join(venv, 'pyvenv.cfg'), 8192) || '';
  const version = cfg.match(/^version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/m)?.[1];
  if (!version) throw err(`${venv} has no pyvenv.cfg with a Python version: not a venv`, 409);
  const xy = version.split('.').slice(0, 2).join('.');
  const site = path.join(venv, 'lib', `python${xy}`, 'site-packages');
  if (!fs.existsSync(site)) throw err(`${site} does not exist`, 409);
  return { python, venv, version, xy, site };
}
/**
 * The shared venv's distributions, read STATICALLY from site-packages (*.dist-info/METADATA, *.egg-info/PKG-INFO):
 * canonical name → { name, version, editable }. Nothing is executed.
 */
export function staticDistributions(site) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(site); } catch { throw err(`cannot read ${site}`, 409); }
  for (const d of names.sort()) {
    const p = path.join(site, d);
    let meta = null, editable = false;
    if (d.endsWith('.dist-info') && realDir(p)) {
      meta = readSmall(path.join(p, 'METADATA'));
      editable = /"editable"\s*:\s*true/.test(readSmall(path.join(p, 'direct_url.json'), 65_536) || '');
    } else if (d.endsWith('.egg-info')) meta = realDir(p) ? readSmall(path.join(p, 'PKG-INFO')) : readSmall(p);
    if (!meta) continue;
    const name = meta.match(/^Name:\s*(\S+)/m)?.[1], version = meta.match(/^Version:\s*(\S+)/m)?.[1];
    if (name && version) out[canonicalName(name)] = { name: canonicalName(name), version, editable };
  }
  return out;
}
const lockLines = (dists) => Object.values(dists).map((d) => `${d.name}==${d.version}`).sort();
const lockHash = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
/** Owner env never reaches pip: a fixed, minimal environment (no PIP_*, no proxies, no user config, empty HOME). */
export function scrubbedEnv(work) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}
/** Run the resolver with a hard time limit, a byte cap on its scratch directory, and the request's cancellation. */
function runResolver(argv, { env, cwd, timeoutMs, watchDir, maxBytes, signal }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '', why = null;
    const kill = (reason) => { if (!why) { why = reason; try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    child.stdout.on('data', (c) => { out = (out + c).slice(-50_000); });
    child.stderr.on('data', (c) => { errOut = (errOut + c).slice(-20_000); });
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const watch = setInterval(() => { if (dirBytes(watchDir) > maxBytes) kill(`used more than ${mb(maxBytes)} while resolving`); }, 250);
    const onAbort = () => kill('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { why = why || e.message; });
    child.on('close', (code) => { clearTimeout(timer); clearInterval(watch); signal?.removeEventListener('abort', onAbort); resolve({ code: why ? -1 : code, out, err: errOut, why }); });
  });
}
function dirBytes(dir) {
  let n = 0;
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { n += fs.lstatSync(p).size; } catch { /* gone */ } } } };
  walk(dir);
  return n;
}

// ---------------- desk-owned storage ----------------
export const pkgRoot = () => { const d = path.join(config.dataDir, 'pkg'); fs.mkdirSync(d, { recursive: true, mode: 0o755 }); return d; };
export const stageDir = (id) => path.join(pkgRoot(), String(Number(id)));
export const caPath = () => path.join(pkgRoot(), 'ca.pem');
function removeStage(id) {
  const d = stageDir(id);
  if (!fs.existsSync(d)) return;
  for (const p of [d, ...fs.readdirSync(d).map((f) => path.join(d, f))]) { try { fs.chmodSync(p, 0o755); } catch { /* gone */ } }
  fs.rmSync(d, { recursive: true, force: true });
}
/**
 * A desk-owned copy of a CA bundle for pip inside the seat (seats cannot read *.pem files in the shared venv). Offline
 * installs never connect anywhere; pip still wants a readable bundle, and this one is the only certificate file a
 * seat with a package grant can read.
 */
export function ensureCa(env = null) {
  const dest = caPath();
  if (fs.existsSync(dest)) return dest;
  let e = env; try { e = e || sharedEnv(); } catch { e = null; }
  const candidates = [e && path.join(e.site, 'certifi', 'cacert.pem'), e && path.join(e.site, 'pip', '_vendor', 'certifi', 'cacert.pem'), '/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'].filter(Boolean);
  const src = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!src) throw err('no CA bundle found to give pip (certifi in the shared venv, or /etc/ssl/cert.pem)', 409);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o444);
  fs.renameSync(tmp, dest);
  return dest;
}
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const SAFE_WHEEL = /^[A-Za-z0-9_.+!-]+\.whl$/;
/** Re-hash every staged wheel against the approved manifest (before approval and before every install). */
export function verifyStage(r) {
  const m = json(r.manifest, []);
  const dir = stageDir(r.id);
  const problems = [];
  for (const w of m.filter((x) => x.role === 'add' || x.role === 'installer')) {
    const p = path.join(dir, w.filename);
    let st; try { st = fs.lstatSync(p); } catch { problems.push(`${w.filename} is missing`); continue; }
    if (!st.isFile()) { problems.push(`${w.filename} is not a regular file`); continue; }
    if (sha256File(p) !== w.sha256) problems.push(`${w.filename} does not match its sha256`);
  }
  try { if (fs.readFileSync(path.join(dir, 'manifest.txt'), 'utf8') !== manifestText(m)) problems.push('manifest.txt changed'); } catch { problems.push('manifest.txt is missing'); }
  return problems;
}
/** The requirements file the seat's pip installs from: additions only, each pinned with its sha256. */
export function manifestText(m) {
  return `${m.filter((x) => x.role === 'add').map((x) => `${x.name}==${x.version} --hash=sha256:${x.sha256}`).join('\n')}\n`;
}

// ---------------- the ticket's lock ----------------
/** Owner-approved requests of a ticket whose additions are (or may be) in its workspace venv. */
const approvedFor = (key) => store.pkgRequestsForTicket(key).filter((r) => r.decided_by === 'owner' && r.manifest && (r.status === 'approved' || r.installed_at));
/** Additions already approved for this ticket: name → { version, request }. */
export function ticketLock(key, exceptId = null) {
  const out = {};
  for (const r of approvedFor(key)) if (r.id !== exceptId) for (const w of json(r.manifest, []).filter((x) => x.role === 'add')) out[w.name] = { name: w.name, version: w.version, request: r.id };
  return out;
}

// ---------------- requests ----------------
let onApproved = null; // the scheduler resumes a ticket that was parked waiting for this approval
export function setOnApproved(fn) { onApproved = fn; }
const active = new Map(); // id -> AbortController of a resolution in this process
let queue = Promise.resolve();
const comment = (key, author, text) => { if (key && store.getTicket(key)) store.addComment(key, author, text); };
const specText = (specs) => specs.map((s) => `${s.name}==${s.version}`).join(', ');
const stagedBytes = (exceptId = null) => store.openPkgRequests().filter((r) => r.id !== exceptId && r.status !== 'resolving').reduce((n, r) => n + (Number(r.total_bytes) || 0), 0);

/** A seat asks for packages (desk pkg request). Returns a message; the resolution runs in the background. */
export function request(run, { specs, why, dev = false }) {
  if (P().enabled === false) throw err('package installs are switched off (packages.enabled)', 403);
  if (!INSTALL_KINDS.has(run.kind) || !run.ticket_key) throw err('packages are requested from a build run on your own ticket (implement, respond, resolve)', 403);
  const t = store.getTicket(run.ticket_key);
  if (!t || CLOSED_TICKET.includes(t.status)) throw err('this ticket is closed', 409);
  const pins = parseSpecs(specs);
  if (!String(why || '').trim()) throw err('say why: --why "<what needs it and why the shared environment cannot do it>"');
  sharedEnv(); // fail now, not in the background, when there is nothing to layer on
  const open = store.openPkgRequests();
  const dup = open.find((r) => r.seat === run.agent_id && r.ticket_key === run.ticket_key && PENDING.includes(r.status) && r.specs === JSON.stringify(pins));
  if (dup) return `Request #${dup.id} for ${specText(pins)} is already ${dup.status === 'resolving' ? 'being resolved' : 'with the owner'}.`;
  // Budgets for sets nobody approved yet (each can stage hundreds of MB).
  const pending = open.filter((r) => PENDING.includes(r.status));
  const lim = { seat: Number(P().maxPendingPerSeat) || 3, run: Number(P().maxPendingPerRun) || 2, total: Number(P().maxPendingTotal) || 10 };
  if (pending.filter((r) => r.run_id === run.id).length >= lim.run) throw err(`this run already has ${lim.run} package requests waiting: wait for the owner`, 429);
  if (pending.filter((r) => r.seat === run.agent_id).length >= lim.seat) throw err(`${nameOf(run.agent_id)} already has ${lim.seat} package requests waiting: wait for the owner`, 429);
  if (pending.length >= lim.total) throw err(`${lim.total} package requests are already waiting for the owner: try again later`, 429);
  const lock = ticketLock(run.ticket_key);
  for (const s of pins) if (lock[s.name]) throw err(lock[s.name].version === s.version ? `${s.name}==${s.version} is already approved for this ticket (#${lock[s.name].request})` : `${s.name} ${lock[s.name].version} is already approved for this ticket (#${lock[s.name].request}): a second version is refused`, 409);
  const r = store.insertPkgRequest({ seat: run.agent_id, ticket_key: run.ticket_key, run_id: run.id, why: String(why).slice(0, 500), specs: pins, dev });
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text: `asked to install ${specText(pins)}${dev ? ' (dev)' : ''}: ${r.why}` });
  comment(run.ticket_key, run.agent_id, `📦 Asked to install ${esc(specText(pins))}${dev ? ' (development/test only)' : ''}: ${esc(r.why)}\n\nThe desk resolves every dependency (wheels from PyPI only, nothing in the shared environment changes) and the owner approves the full list.`);
  enqueue(r.id);
  return `Request #${r.id} filed: the desk is resolving the full dependency set from PyPI (wheels only; nothing in the shared environment may change); then the owner approves it in the Inbox. Check with desk pkg status. Once approved, the wheels are readable from your next run on this ticket, where desk pkg install installs them offline into .venv. If you cannot continue without it, end this run with: desk needs-human "waiting for package request #${r.id}" (the approval resumes the ticket).`;
}
function enqueue(id) {
  if (active.has(id)) return;
  const ac = new AbortController();
  active.set(id, ac);
  queue = queue.then(() => (ac.signal.aborted ? null : resolveRequest(id, ac.signal))).catch(() => {}).finally(() => active.delete(id));
}
/** Wait for every queued resolution (tests, shutdown). */
export const settled = () => queue;

/** Resolve one request into a staged, hash-verified wheel set (or fail it with the reason). */
export async function resolveRequest(id, signal = null) {
  const r = store.getPkgRequest(id);
  if (!r || r.status !== 'resolving') return r;
  const stage = stageDir(id);
  const work = path.join(stage, '.work');
  const cancelled = () => { if (signal?.aborted) throw err('cancelled', 499); };
  try {
    removeStage(id);
    for (const d of ['home', 'tmp']) fs.mkdirSync(path.join(work, d), { recursive: true });
    const env = sharedEnv();
    const specs = json(r.specs, []);
    const shared = staticDistributions(env.site);
    const lock = ticketLock(r.ticket_key, r.id);
    for (const s of specs) {
      const have = shared[s.name];
      if (have && have.version === s.version) throw err(`${s.name} ${s.version} is already in the shared environment: nothing to install`);
      if (have) throw err(`would replace ${s.name} ${have.version} with ${s.version} in the shared environment: refused (no existing distribution changes version)`);
      if (lock[s.name] && lock[s.name].version !== s.version) throw err(`${s.name} ${lock[s.name].version} is already approved for this ticket (#${lock[s.name].request}): a second version is refused`);
    }
    const pipVersion = shared.pip?.version;
    if (!pipVersion || !realDir(path.join(env.site, 'pip'))) throw err('the shared environment has no pip to resolve with');
    // Constraints: the complete ticket lock — every shared distribution and every addition already approved for this
    // ticket stays at exactly its version.
    const constraints = path.join(work, 'constraints.txt');
    fs.writeFileSync(constraints, `${[...Object.values(shared).filter((d) => !d.editable), ...Object.values(lock)].map((d) => `${d.name}==${d.version}`).join('\n')}\n`);
    const report = path.join(work, 'report.json');
    const maxTotal = Math.min((Number(P().maxTotalMB) || 300) * 1e6, (Number(P().maxStagedMB) || 1500) * 1e6 - stagedBytes(id));
    if (maxTotal <= 0) throw err(`the staging area is full (${P().maxStagedMB || 1500} MB of unapproved and approved sets): ask the owner to decide pending requests`);
    // -I -S: no PYTHON* variables, no user site, and no site import at all, so no .pth file or sitecustomize of the
    // shared venv runs; pip is started from its own directory. --dry-run with --target: pip resolves the whole closure
    // and installs nothing (even a non-dry run could only reach the throwaway target, never the shared venv).
    // Every connection pip makes goes through a desk proxy for this resolution only: CONNECT to pypi.org:443 and
    // files.pythonhosted.org:443 and nothing else, with its own token, byte and time caps (closed on revoke).
    const timeoutMs = (Number(P().resolveTimeoutSeconds) || 180) * 1000;
    const proxy = await startProxy({ hosts: RESOLVER_HOSTS, maxBytes: Math.max(50e6, maxTotal), maxMs: timeoutMs + 5000, signal });
    const argv = [env.python, '-I', '-S', path.join(env.site, 'pip'), 'install', '--dry-run', '--target', path.join(work, 'target'), '--only-binary=:all:', '--no-cache-dir',
      '--disable-pip-version-check', '--no-input', '--timeout', '30', '--retries', '1', '--proxy', proxy.url, '--index-url', PYPI_INDEX, '--report', report, '-c', constraints,
      ...specs.map((s) => `${s.name}==${s.version}`), `pip==${pipVersion}`];
    let res;
    try { res = await runResolver(argv, { env: scrubbedEnv(work), cwd: work, timeoutMs, watchDir: work, maxBytes: Math.max(50e6, maxTotal), signal }); } finally { proxy.close(); }
    if (proxy.stats.refused.length && res.code !== 0) res.err = `${res.err}\nERROR: the desk proxy refused: ${proxy.stats.refused.slice(0, 3).join('; ')}`;
    cancelled();
    if (res.code !== 0) {
      const tail = (res.err || '').trim().split('\n').filter((l) => /ERROR|conflict|requested|No matching|Could not find/i.test(l)).slice(-6).join(' · ');
      throw err(res.why ? `resolution stopped: ${res.why}` : /ResolutionImpossible|conflict/i.test(res.err) ? `cannot be added without changing a distribution the shared environment or this ticket already has (or the pins conflict): ${tail || 'see pip output'}` : `pip could not resolve it: ${tail || (res.err || '').trim().split('\n').at(-1) || `exit ${res.code}`}`);
    }
    const manifest = manifestFromReport(json(readSmall(report, 20_000_000), null), { specs, shared, pipVersion, lock });
    // The report is only a proposal: every wheel is fetched again by the desk, bound to the report's sha256, and read.
    let total = 0;
    const inventory = {};
    for (const w of manifest.filter((x) => x.role === 'add' || x.role === 'installer')) {
      cancelled();
      const left = maxTotal - total;
      if (left <= 0) throw err(`the wheels are larger than ${mb(maxTotal)} together`);
      const file = path.join(stage, w.filename);
      const got = await net.safeFetch(w.url, { hosts: FILE_HOSTS, maxBytes: Math.min(left, (Number(P().maxFileMB) || 150) * 1e6), timeoutMs: (Number(P().downloadTimeoutSeconds) || 120) * 1000, maxRedirects: 2, file, signal });
      if (got.status !== 200) { fs.rmSync(file, { force: true }); throw err(`downloading ${w.filename} answered HTTP ${got.status}`, 502); }
      if (got.sha256 !== w.sha256) { fs.rmSync(file, { force: true }); throw err(`${w.filename} does not match the sha256 PyPI's index gave (${got.sha256.slice(0, 12)}… ≠ ${w.sha256.slice(0, 12)}…)`, 502); }
      w.size = got.bytes;
      total += got.bytes;
      if (w.role === 'add') {
        let inv;
        try { inv = wheelInventory(file, { maxUnpacked: (Number(P().maxUnpackedMB) || 1000) * 1e6, xy: env.xy }); } catch (e) { throw err(`${w.filename}: ${e.message}`); }
        const want = `${w.name.replace(/-/g, '_')}-${w.version}.dist-info`.toLowerCase();
        if (canonicalName(inv.distInfo.replace(/\.dist-info$/, '').replace(/-[^-]+$/, '')) !== w.name) throw err(`${w.filename} contains ${inv.distInfo}, not ${want}`);
        inventory[w.name] = { distInfo: inv.distInfo, files: inv.files, outside: inv.outside };
        w.files = inv.files.length;
        w.startup = inv.startup;
        w.unpacked = inv.unpacked;
      }
    }
    cancelled();
    fs.rmSync(work, { recursive: true, force: true });
    fs.writeFileSync(path.join(stage, 'manifest.txt'), manifestText(manifest));
    ensureCa(env);
    // Read-only for everyone, owner included (the desk loosens it only to delete the stage).
    for (const f of fs.readdirSync(stage)) fs.chmodSync(path.join(stage, f), 0o444);
    fs.chmodSync(stage, 0o555);
    const base = Object.fromEntries(Object.values(shared).map((d) => [d.name, d.version]));
    const adds = manifest.filter((x) => x.role === 'add');
    // A revoke (or the ticket closing) that landed meanwhile wins: the conditional update leaves its state alone.
    if (!store.transitionPkgRequest(id, ['resolving'], { status: 'owner', manifest, total_bytes: total, base_lock: base, inventory, error: null })) { removeStage(id); return store.getPkgRequest(id); }
    const t = store.getTicket(r.ticket_key);
    const text = `${nameOf(r.seat)} asks to install ${adds.length} package${adds.length === 1 ? '' : 's'} (${specText(specs)}${adds.length > specs.length ? ` + ${adds.length - specs.length} dependencies` : ''}, ${mb(total)}) for ${r.ticket_key}`;
    store.logEvent({ agent_id: 'system', ticket_key: r.ticket_key, kind: 'action', text: `${text} → the owner decides` });
    const hooks = adds.filter((x) => x.startup?.length);
    comment(r.ticket_key, 'system', `📦 Resolved package request #${id}: ${esc(adds.map((x) => `${x.name}==${x.version}`).join(', '))} (${mb(total)}; every wheel re-downloaded by the desk and bound to its sha256).${hooks.length ? ` ⚠️ ${esc(hooks.map((x) => `${x.name} adds startup code (${x.startup.join(', ')})`).join('; '))}.` : ''} The owner decides in the Inbox.`);
    notify('needs_human', t, `Let ${nameOf(r.seat)} install ${adds.length} package${adds.length === 1 ? '' : 's'} for ${r.ticket_key}?`);
    return store.getPkgRequest(id);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 600);
    const failed = store.transitionPkgRequest(id, ['resolving'], { status: 'failed', error: msg });
    removeStage(id);
    if (failed) {
      store.logEvent({ agent_id: 'system', ticket_key: r.ticket_key, kind: 'action', text: `package request #${id} refused: ${msg}` });
      comment(r.ticket_key, 'system', `📦 Package request #${id} could not be prepared: ${esc(msg)}`);
    }
    return store.getPkgRequest(id);
  }
}

/**
 * pip's installation report → the manifest (a proposal the downloads then verify). Every item must be a wheel on
 * files.pythonhosted.org with a sha256 and not a direct URL. Items the shared venv already has (same version) are
 * 'shared', items already approved for this ticket are 'ticket' (neither is downloaded or installed); a different
 * version of either is refused; pip itself is the 'installer' (run from the stage, not installed).
 */
export function manifestFromReport(rep, { specs, shared, pipVersion, lock = {} }) {
  if (!rep || !Array.isArray(rep.install)) throw err('pip produced no installation report');
  const out = [];
  for (const it of rep.install) {
    const name = canonicalName(it?.metadata?.name || '');
    const version = String(it?.metadata?.version || '');
    if (!name || !version) throw err('the report names a distribution without a name or version');
    if (it.is_direct) throw err(`${name} would come from a direct URL: refused (PyPI only)`);
    let u; try { u = new URL(it.download_info?.url || ''); } catch { throw err(`${name} has no download URL`); }
    if (u.protocol !== 'https:' || !FILE_HOSTS.includes(u.hostname) || u.port || u.username) throw err(`${name} would be downloaded from ${u.host || 'nowhere'}: only ${FILE_HOSTS.join(', ')} is allowed`);
    const filename = decodeURIComponent(path.posix.basename(u.pathname));
    if (!SAFE_WHEEL.test(filename)) throw err(`${name} ${version} is not a wheel (${filename}): wheels only, no source builds`);
    const ai = it.download_info?.archive_info || {};
    const sha256 = String(ai.hashes?.sha256 || String(ai.hash || '').replace(/^sha256=/, '')).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw err(`${name} ${version} has no sha256 in the report`);
    const have = shared[name];
    let role = 'add';
    if (name === 'pip') {
      if (version !== pipVersion) throw err(`would replace pip ${pipVersion} with ${version}: refused`);
      role = 'installer';
    } else if (have) {
      if (have.version !== version) throw err(`would replace ${name} ${have.version} with ${version} in the shared environment: refused (no existing distribution changes version)`);
      role = 'shared';
    } else if (lock[name]) {
      if (lock[name].version !== version) throw err(`would replace ${name} ${lock[name].version} (approved for this ticket in #${lock[name].request}) with ${version}: refused`);
      role = 'ticket';
    }
    if (out.some((x) => x.name === name)) throw err(`${name} appears twice in the report`);
    out.push({ name, version, filename, url: u.toString(), sha256, size: null, requested: specs.some((s) => s.name === name), role });
  }
  for (const s of specs) if (!out.some((x) => x.name === s.name && x.version === s.version && x.role === 'add')) throw err(`${s.name}==${s.version} is not in pip's resolution`);
  if (!out.some((x) => x.role === 'installer')) throw err('pip\'s own wheel is missing from the resolution');
  const files = out.filter((x) => x.role === 'add' || x.role === 'installer').length;
  if (files > (Number(P().maxFiles) || 60)) throw err(`${files} wheels: more than the ${Number(P().maxFiles) || 60} one request may stage`);
  return out;
}

// ---------------- owner decisions ----------------
/** Approve or deny a resolved request. v1: the owner only. */
export function decide(id, action, { by = 'owner', note = '' } = {}) {
  const r = store.getPkgRequest(Number(id));
  if (!r) throw err(`no package request #${id}`, 404);
  if (by !== 'owner') throw err('only the owner approves package installs', 403);
  if (r.status !== 'owner') throw err(`package request #${r.id} is ${r.status}, not waiting for you`, 409);
  const t = store.getTicket(r.ticket_key);
  if (action === 'deny') {
    if (!store.transitionPkgRequest(r.id, ['owner'], { status: 'denied', decided_by: by, decided_at: nowIso(), note: String(note || '').slice(0, 300) || null })) throw err(`package request #${r.id} is no longer waiting for you`, 409);
    removeStage(r.id);
    const text = `The owner declined package request #${r.id}${note ? `: ${note}` : ''}`;
    store.logEvent({ agent_id: 'owner', ticket_key: r.ticket_key, kind: 'action', text });
    comment(r.ticket_key, 'owner', `📦 ${esc(text)}.`);
    return 'Declined.';
  }
  if (action !== 'approve') throw err('approve | deny');
  if (!t || CLOSED_TICKET.includes(t.status)) throw err(`${r.ticket_key} is closed`, 409);
  // Approvals on one ticket must agree: no addition may name a version another approval already fixed.
  const lock = ticketLock(r.ticket_key, r.id);
  const clash = json(r.manifest, []).filter((x) => x.role === 'add' && lock[x.name] && lock[x.name].version !== x.version);
  if (clash.length) throw err(`conflicts with what is already approved for ${r.ticket_key}: ${clash.map((x) => `${x.name} ${x.version} vs ${lock[x.name].version} (#${lock[x.name].request})`).join(', ')}. Decline it and let the seat ask again`, 409);
  const problems = verifyStage(r);
  if (problems.length) {
    store.transitionPkgRequest(r.id, ['owner'], { status: 'failed', error: `staged wheels changed: ${problems.join('; ')}` });
    removeStage(r.id);
    throw err(`the staged wheels changed since they were resolved (${problems.join('; ')}): refused; ask again`, 409);
  }
  const hours = Math.max(1, Math.min(Number(P().grantHours) || 24, 168));
  if (!store.transitionPkgRequest(r.id, ['owner'], { status: 'approved', decided_by: by, decided_at: nowIso(), note: String(note || '').slice(0, 300) || null, expires_at: new Date(Date.now() + hours * 3600_000).toISOString() }))
    throw err(`package request #${r.id} is no longer waiting for you`, 409);
  const adds = json(r.manifest, []).filter((x) => x.role === 'add');
  const text = `The owner approved package request #${r.id} for ${nameOf(r.seat)}: ${adds.map((x) => `${x.name}==${x.version}`).join(', ')}`;
  store.logEvent({ agent_id: 'owner', ticket_key: r.ticket_key, kind: 'action', text });
  comment(r.ticket_key, 'owner', `📦 ${esc(text)}.\n\n${nameOf(r.seat)} installs it offline into this ticket's .venv with \`desk pkg install\` (in a run started from now on; usable for ${hours}h and only while ${r.ticket_key} is open). Add the dependency to the right requirements file.`);
  try { onApproved?.(store.getPkgRequest(r.id)); } catch { /* the approval stands */ }
  return `Approved (#${r.id}).`;
}
/** Revoke an approved (or pending) request now: in-flight work is cancelled, the stage deleted, installs refused. */
export function revoke(id, by = 'owner', reason = '') {
  const r = store.getPkgRequest(Number(id));
  if (!r || !OPEN.includes(r.status)) throw err(`no open package request #${id}`, 404);
  if (by !== 'owner') throw err('only the owner revokes package grants', 403);
  endRequest(r, 'revoked', by, reason || 'revoked by the owner');
  return `Revoked #${r.id}.`;
}
function endRequest(r, status, by, reason) {
  // Terminal first (a resolution finishing now cannot overwrite it), then cancel what is in flight, then the stage.
  if (!store.transitionPkgRequest(r.id, OPEN, { status, revoked_at: nowIso(), revoked_by: by, note: reason ? String(reason).slice(0, 300) : r.note })) return false;
  active.get(r.id)?.abort(err(status, 499));
  removeStage(r.id);
  const text = status === 'revoked' ? `The owner revoked package request #${r.id}${reason ? `: ${reason}` : ''}` : `Package request #${r.id} ended (${status}${reason ? `: ${reason}` : ''})`;
  store.logEvent({ agent_id: by === 'owner' ? 'owner' : 'system', ticket_key: r.ticket_key, kind: 'action', text });
  if (status === 'revoked') comment(r.ticket_key, 'owner', `📦 ${esc(text)}. Further installs from it are refused; what is already in this workspace's .venv stays there.`);
  return true;
}
/** Emergency stop (Access sheet "Revoke all"): every package grant and request ends. */
export function revokeAll(by = 'owner', reason = 'emergency: revoke all') {
  let n = 0;
  for (const r of store.openPkgRequests()) if (endRequest(r, 'revoked', by, reason)) n++;
  return n;
}
/** Expiry, unanswered requests past their TTL, closed tickets, and resolutions orphaned by a restart. */
export function sweep(at = nowIso()) {
  const ttl = (Number(P().pendingHours) || 48) * 3600_000;
  for (const r of store.openPkgRequests()) {
    const t = store.getTicket(r.ticket_key);
    if (!t || CLOSED_TICKET.includes(t.status)) { endRequest(r, r.status === 'approved' ? 'closed' : 'withdrawn', 'system', 'the ticket closed'); continue; }
    if (r.status === 'approved' && r.expires_at && r.expires_at <= at) { endRequest(r, 'expired', 'system', 'expired'); continue; }
    if (PENDING.includes(r.status) && Date.parse(at) - Date.parse(r.created_at) > ttl) { endRequest(r, 'expired', 'system', `nobody approved it within ${P().pendingHours || 48}h`); continue; }
    if (r.status === 'resolving' && !active.has(r.id)) enqueue(r.id);
  }
}

// ---------------- runs: what a seat may read, what it installs ----------------
const isLive = (r, at = nowIso()) => r.status === 'approved' && (!r.expires_at || r.expires_at > at) && !CLOSED_TICKET.includes(store.getTicket(r.ticket_key)?.status ?? 'done');
export const liveGrants = (seat, ticketKey) => store.openPkgRequests().filter((r) => r.seat === seat && r.ticket_key === ticketKey && isLive(r));
/**
 * Extra read paths for a run's sandbox (Claude allowRead and the Codex profile): the stages of this seat's live grants
 * on this ticket, plus the desk's CA bundle copy. Nothing for other kinds, seats or tickets. Recorded per run, because
 * a sandbox is fixed at launch.
 */
export function readPathsFor(seat, ticketKey, kind) {
  if (!ticketKey || !INSTALL_KINDS.has(kind)) return { paths: [], ids: [] };
  const grants = liveGrants(seat, ticketKey).filter((r) => fs.existsSync(stageDir(r.id)));
  if (!grants.length) return { paths: [], ids: [] };
  let ca = null; try { ca = ensureCa(); } catch { ca = null; }
  return { paths: [...grants.map((r) => stageDir(r.id)), ...(ca ? [ca] : [])], ids: grants.map((r) => r.id) };
}
export function recordLaunch(runId, ids) { if (runId && ids?.length) store.kvSet(`pkg-read:${runId}`, JSON.stringify(ids)); }
export const launchedIds = (runId) => json(store.kvGet(`pkg-read:${runId}`), []);

// Inside the seat, after the install: every added distribution imports, and its own requirements (markers evaluated
// for this interpreter, no extras) are satisfied by what is installed — a `pip check` limited to what was added, using
// pip's vendored `packaging` from the installer wheel (argv[1]).
const VERIFY_PY = [
  'import importlib, importlib.metadata as md, json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from pip._vendor.packaging.requirements import Requirement',
  'from pip._vendor.packaging.utils import canonicalize_name',
  'bad = []',
  'have = {canonicalize_name(d.metadata["Name"]): d.version for d in md.distributions() if d.metadata["Name"]}',
  'for name in sys.argv[2:]:',
  '    try:',
  '        d = md.distribution(name)',
  '    except Exception as e:',
  '        bad.append(f"{name}: not installed ({e})"); continue',
  '    for line in d.requires or []:',
  '        req = Requirement(line)',
  '        if req.marker and not req.marker.evaluate({"extra": ""}):',
  '            continue',
  '        got = have.get(canonicalize_name(req.name))',
  '        if got is None:',
  '            bad.append(f"{name} requires {req}, which is not installed")',
  '        elif not req.specifier.contains(got, prereleases=True):',
  '            bad.append(f"{name} requires {req}, but {req.name} {got} is installed")',
  '    tops = [t for t in (d.read_text("top_level.txt") or "").split() if t and not t.startswith("_")]',
  '    if not tops:',
  '        tops = sorted({str(f).split("/")[0].removesuffix(".py") for f in (d.files or []) if str(f).endswith(".py") and ".dist-info" not in str(f) and not str(f).startswith("..")})',
  '    for t in tops:',
  '        try:',
  '            importlib.import_module(t)',
  '        except Exception as e:',
  '            bad.append(f"{name}: import {t} failed ({type(e).__name__}: {e})")',
  'print(json.dumps({"ok": not bad, "problems": bad}))',
  'sys.exit(1 if bad else 0)',
].join('\n');
export const PTH_NAME = '_sigmadesk_shared.pth';
/** The .pth line that layers the shared venv under the workspace venv (read-only: nothing is ever written there; no
 * bytecode is written by this interpreter either, so the installed tree stays exactly what was verified). */
export const pthText = (sharedSite) => `import site, sys; sys.dont_write_bytecode = True; site.addsitedir(${JSON.stringify(sharedSite)})\n`;
/** Environment for every offline install step inside the seat's sandbox. */
export function installEnv(ca) {
  return { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PIP_CONFIG_FILE: '/dev/null', PIP_CERT: ca, PIP_NO_INDEX: '1', PIP_NO_CACHE_DIR: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' };
}
/**
 * The exact offline steps `desk pkg install` runs inside the seat's sandbox. Pure (tests check it):
 *  1. python -m venv --without-pip <ws>/.venv on the shared venv's interpreter (skipped when it exists);
 *  2. a .pth in its site-packages layering the shared venv's site-packages (explicit, read-only: not --system-site-packages);
 *  3. scratch space for pip inside the workspace, and .venv/ excluded from git;
 *  4. per approved request: pip (from the wheel in the stage) install --no-index --no-deps --require-hashes from the stage;
 *  5. import every added distribution and check its requirements.
 */
export function installSteps({ ws, env, stages, ca }) {
  const venv = path.join(ws, '.venv');
  const vpy = path.join(venv, 'bin', 'python');
  const site = path.join(venv, 'lib', `python${env.xy}`, 'site-packages');
  const e = { ...installEnv(ca), TMPDIR: path.join(venv, '.tmp') };
  const adds = stages.flatMap((s) => s.adds);
  return [
    { label: 'create the workspace venv on the shared interpreter (no pip, no system site-packages)', argv: [env.python, '-I', '-m', 'venv', '--without-pip', venv], unless: path.join(venv, 'pyvenv.cfg'), env: e },
    { label: 'layer the shared venv read-only (.pth)', write: { path: path.join(site, PTH_NAME), text: pthText(env.site) } },
    { label: 'scratch space for pip', write: { path: path.join(venv, '.tmp', '.keep'), text: '' } },
    { label: 'keep .venv out of git', exclude: { ws, line: '/.venv/' } },
    ...stages.map((s) => ({ label: `install request #${s.id} offline (${s.adds.length} wheels, hash-checked)`, env: e,
      argv: [vpy, '-B', '-s', path.join(s.dir, s.installer, 'pip'), 'install', '--no-index', '--no-deps', '--require-hashes', '--no-compile', '--no-cache-dir',
        '--disable-pip-version-check', '--no-input', '--find-links', s.dir, '-r', path.join(s.dir, 'manifest.txt')] })),
    { label: 'import what was added and check its requirements', argv: [vpy, '-B', '-s', '-c', VERIFY_PY, path.join(stages[0].dir, stages[0].installer), ...adds], env: e },
  ];
}
const planned = new Map(); // runId -> request ids in the plan it was given
/** `desk pkg install`: the steps for this run, after every check (grant live, readable in this run, stage intact). */
export function installPlan(run) {
  if (!INSTALL_KINDS.has(run.kind) || !run.ticket_key) throw err('desk pkg install runs in a build run on your own ticket', 403);
  const t = store.getTicket(run.ticket_key);
  if (!t || CLOSED_TICKET.includes(t.status)) throw err('this ticket is closed', 409);
  const mine = store.pkgRequestsForTicket(run.ticket_key).filter((r) => r.seat === run.agent_id);
  const live = mine.filter((r) => isLive(r));
  if (!live.length) {
    const last = mine.at(-1);
    throw err(!last ? 'no package request on this ticket: desk pkg request name==version --why "…"'
      : last.status === 'resolving' ? `request #${last.id} is still being resolved` : last.status === 'owner' ? `request #${last.id} is waiting for the owner`
        : last.status === 'approved' ? `request #${last.id} expired` : `request #${last.id} is ${last.status}${last.error ? `: ${last.error}` : ''}: nothing may be installed from it`, 409);
  }
  const readable = new Set(launchedIds(run.id));
  const unreadable = live.filter((r) => !readable.has(r.id));
  if (unreadable.length === live.length) throw err(`request ${unreadable.map((r) => `#${r.id}`).join(', ')} was approved after this run started, so its wheels are not readable in this run's sandbox. End this run with desk needs-human "package request #${unreadable[0].id} approved: restart to install" — the next run on this ticket can install it.`, 409);
  const ok = live.filter((r) => readable.has(r.id));
  for (const r of ok) { const p = verifyStage(r); if (p.length) throw err(`request #${r.id}'s staged wheels changed (${p.join('; ')}): refused`, 409); }
  const ws = store.getRun(run.id)?.cwd;
  if (!ws) throw err('this run has no workspace', 409);
  const env = sharedEnv();
  const ca = ensureCa(env);
  const stages = ok.map((r) => { const m = json(r.manifest, []); return { id: r.id, dir: stageDir(r.id), installer: m.find((x) => x.role === 'installer').filename, adds: m.filter((x) => x.role === 'add').map((x) => x.name) }; });
  planned.set(run.id, ok.map((r) => r.id));
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text: `installing package request ${ok.map((r) => `#${r.id}`).join(', ')} offline into .venv` });
  return { ws, venv: path.join(ws, '.venv'), steps: installSteps({ ws, env, stages, ca }), requests: ok.map((r) => r.id), skipped: unreadable.map((r) => r.id) };
}

// ---------------- reading a workspace venv back (never executing it) ----------------
/** Does <ws>/.venv exist at all (any form)? A venv the desk cannot verify still counts: QA then cannot pass. */
export const hasVenv = (ws) => { try { fs.lstatSync(path.join(ws, '.venv')); return true; } catch { return false; } };
/** Every entry under `dir` (relative paths), refusing links; bounded. */
function walk(dir, max = 200_000) {
  const files = [];
  const rec = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw err(`.venv contains a link (${r}): refused`, 409);
      if (e.isDirectory()) rec(p, r);
      else if (e.isFile()) { files.push(r); if (files.length > max) throw err(`.venv holds more than ${max} files`, 409); }
      else throw err(`.venv contains a special file (${r})`, 409);
    }
  };
  rec(dir, '');
  return files;
}
const PIP_WRITES = new Set(['INSTALLER', 'REQUESTED', 'RECORD', 'direct_url.json']);
const STARTUP = (f) => !f.includes('/') && (f.endsWith('.pth') || f === 'sitecustomize.py' || f === 'usercustomize.py');
/**
 * The workspace venv's fingerprint, from what is actually on disk, against what the owner approved:
 *  - interpreter identity: .venv/bin/python resolves to the shared venv's interpreter, same Python version, no system
 *    site-packages, the desk's .pth exactly;
 *  - the shared venv unchanged since each approval (its static lock);
 *  - every file of every planned/installed addition present with the sha256 its verified wheel's RECORD gave;
 *  - no other file in site-packages (pip's own INSTALLER/REQUESTED/RECORD aside), so no unexpected .pth,
 *    sitecustomize, usercustomize or bytecode.
 * Throws with the first reason it is not what was approved.
 */
export function fingerprint(ticketKey, ws, { including = [], requireAll = true } = {}) {
  const venv = path.join(ws, '.venv');
  if (!realDir(venv)) throw err('there is no .venv directory in this workspace (or it is a link)', 409);
  const env = sharedEnv();
  const cfg = readSmall(path.join(venv, 'pyvenv.cfg'), 8192);
  if (cfg == null) throw err('.venv has no pyvenv.cfg', 409);
  if (/^include-system-site-packages\s*=\s*true/mi.test(cfg)) throw err('.venv was created with system site-packages: recreate it with desk pkg install', 409);
  const version = cfg.match(/^version(?:_info)?\s*=\s*(\S+)/m)?.[1];
  if (version !== env.version) throw err(`.venv says Python ${version || 'unknown'}, the shared venv is ${env.version}`, 409);
  const vpy = path.join(venv, 'bin', 'python');
  let vreal; try { vreal = fs.realpathSync(vpy); } catch { throw err('.venv/bin/python is missing', 409); }
  if (vreal !== realpath(env.python)) throw err(`.venv/bin/python is ${vreal}, not the shared venv's interpreter`, 409);
  const site = path.join(venv, 'lib', `python${env.xy}`, 'site-packages');
  if (![path.join(venv, 'lib'), path.join(venv, 'lib', `python${env.xy}`), site].every(realDir)) throw err('.venv has no real site-packages directory', 409);
  const libs = fs.readdirSync(path.join(venv, 'lib'));
  if (libs.length !== 1) throw err(`.venv/lib holds ${libs.join(', ')}: only python${env.xy} is expected`, 409);
  if (readSmall(path.join(site, PTH_NAME), 4096) !== pthText(env.site)) throw err(`.venv does not layer the shared venv as the desk wrote it (${PTH_NAME})`, 409);
  // Which approvals the venv must hold: installed ones and the ones being recorded now.
  const all = approvedFor(ticketKey);
  const pendingInstall = all.filter((r) => !r.installed_at && !including.includes(r.id) && r.status === 'approved');
  if (requireAll && pendingInstall.length) throw err(`request ${pendingInstall.map((r) => `#${r.id}`).join(', ')} is approved but not installed in this .venv: run desk pkg install`, 409);
  const reqs = all.filter((r) => r.installed_at || including.includes(r.id));
  const sharedNow = staticDistributions(env.site);
  const nowLock = lockLines(sharedNow);
  for (const r of reqs) {
    const base = json(r.base_lock, {});
    if (lockHash(Object.entries(base).map(([n, v]) => `${n}==${v}`).sort()) !== lockHash(nowLock)) throw err(`the shared venv changed since request #${r.id} was approved: ask again`, 409);
  }
  const expected = new Map(); // relative path -> sha256
  const outside = []; // files a wheel installs outside site-packages (scripts, headers, data)
  const distInfos = new Set();
  const added = [];
  for (const r of reqs) {
    const inv = json(r.inventory, {});
    for (const w of json(r.manifest, []).filter((x) => x.role === 'add')) {
      const i = inv[w.name];
      if (!i) throw err(`request #${r.id} has no verified inventory for ${w.name}`, 409);
      for (const f of i.files) expected.set(f.path, f.sha256);
      for (const o of i.outside || []) if (typeof o === 'object') outside.push({ ...o, wheel: w.name });
      distInfos.add(i.distInfo);
      added.push({ name: w.name, version: w.version, sha256: w.sha256, dev: !!r.dev, request: r.id, files: i.files.length });
    }
  }
  const onDisk = walk(site);
  const seen = new Set();
  const lines = [];
  for (const f of onDisk) {
    if (f === PTH_NAME) continue;
    const want = expected.get(f);
    if (want) {
      const got = sha256File(path.join(site, f));
      if (got !== want) throw err(`${f} in .venv was changed after the install (sha256 does not match its wheel)`, 409);
      seen.add(f); lines.push(`${f}\t${got}`);
      continue;
    }
    const [top, leaf, ...more] = f.split('/');
    if (distInfos.has(top) && !more.length && PIP_WRITES.has(leaf)) continue; // pip's own install records
    if (STARTUP(f)) throw err(`.venv has a startup hook nobody approved: ${f}`, 409);
    throw err(`.venv holds a file no approved wheel installs: ${f}`, 409);
  }
  // Outside site-packages: each scheme's files under the venv root, hashed the same way (a `#!python` script's first line
  // is rewritten by pip to this venv's interpreter, so it is compared from the second line on).
  for (const o of outside) {
    const dest = path.join(venv, o.dest);
    if (!inside(path.resolve(dest), venv)) throw err(`${o.dest} would install outside the venv`, 409);
    let st; try { st = fs.lstatSync(dest); } catch { throw err(`.venv is missing ${o.dest} (installed by ${o.wheel}): run desk pkg install`, 409); }
    if (!st.isFile()) throw err(`${o.dest} in .venv is not a regular file`, 409);
    const body = fs.readFileSync(dest);
    let ok;
    if (o.shebang) { const nl = body.indexOf(10); ok = nl > 0 && /^#!.*python[\d.]*\s*$/.test(body.subarray(0, nl).toString()) && crypto.createHash('sha256').update(body.subarray(nl + 1)).digest('hex') === o.rest_sha256; }
    else ok = crypto.createHash('sha256').update(body).digest('hex') === o.sha256;
    if (!ok) throw err(`${o.dest} in .venv was changed after the install`, 409);
    lines.push(`${o.dest}\t${o.sha256}`);
  }
  const missing = [...expected.keys()].filter((f) => !seen.has(f));
  if (missing.length) throw err(`.venv is missing ${missing.length} file(s) of the approved packages (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}): run desk pkg install`, 409);
  const lock = [...nowLock, ...added.map((a) => `${a.name}==${a.version}`)].sort();
  return { python: env.version, interpreter: vreal, platform: `${process.platform}-${process.arch}`, shared_venv: env.venv, shared_lock_sha256: lockHash(nowLock),
    added, lock_size: lock.length, lock_sha256: lockHash(lock), installed_files: lines.length, installed_sha256: lockHash(lines.sort()), verified_at: nowIso() };
}
/** The seat reports its offline install; the desk reads the venv back, verifies it and records the fingerprint. */
export function recordInstall(run, { ok, step = '', output = '' } = {}) {
  const ids = planned.get(run.id) || [];
  if (!ids.length) throw err('no desk pkg install plan was given to this run', 409);
  planned.delete(run.id);
  if (!ok) {
    store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'error', text: `offline package install failed at "${String(step).slice(0, 120)}": ${String(output).slice(-300)}` });
    return 'Recorded the failure. Fix what the output shows (or ask the owner), then run desk pkg install again.';
  }
  // Requests approved after this run started cannot be in this venv yet; the venv is complete (and QA can pass) only
  // once every approved request is installed.
  const fp = fingerprint(run.ticket_key, store.getRun(run.id)?.cwd, { including: ids, requireAll: false });
  for (const id of ids) store.updatePkgRequest(id, { installed_at: nowIso(), install_run: run.id, fingerprint: fp });
  store.kvSet(`venv:${run.ticket_key}`, JSON.stringify(fp));
  const text = `installed ${fp.added.map((a) => `${a.name}==${a.version}`).join(', ')} offline into .venv (Python ${fp.python}, ${fp.platform}; ${fp.installed_files} files verified; lock ${fp.lock_sha256.slice(0, 12)})`;
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text });
  comment(run.ticket_key, 'system', `📦 ${nameOf(run.agent_id)} ${esc(text)}. Tests and QA run through \`desk test\`.`);
  return `Installed and verified: ${fpText(fp)}. Run tests with desk test pytest … (it uses .venv/bin/python), and add ${fp.added.filter((a) => expectedRequested(run.ticket_key, a.name)).map((a) => `${a.name}==${a.version}`).join(', ')} to the right requirements file.`;
}
const expectedRequested = (key, name) => store.pkgRequestsForTicket(key).some((r) => json(r.specs, []).some((s) => s.name === name));
export const fpText = (fp) => `Python ${fp.python} (${fp.platform}), +${fp.added.length} package${fp.added.length === 1 ? '' : 's'} on the shared venv, ${fp.installed_files} files verified, lock ${fp.lock_size} distributions sha256 ${fp.lock_sha256.slice(0, 12)}`;
export const recordedFingerprint = (key) => json(store.kvGet(`venv:${key}`), null);

/** For the QA gate: no .venv, or a .venv that is (fingerprint) or is not (error) what was approved. Never fails open. */
export function qaEnvironment(ticketKey, ws) {
  if (!hasVenv(ws)) return { venv: false };
  try { return { venv: true, fingerprint: fingerprint(ticketKey, ws), error: null }; } catch (e) { return { venv: true, fingerprint: null, error: e.message }; }
}

// ---------------- desk test: the canonical interpreter, the real exit status ----------------
// Test runners only, and only ways of running them that actually run tests and report them.
export const TEST_RUNNERS = ['pytest', 'unittest'];
const PYTEST_REFUSED = /^(--junit-?xml|--co$|--collect-only|--setup-plan|--setup-only|--fixtures|--markers|--version$|-V$|-h$|--help$|-p|-o$|--override-ini|-c$|--config-file|--rootdir|--confcutdir|--noconftest|--pyargs|--import-mode|--basetemp)/;
const junitPath = (ws, id) => path.join(ws, '.git', `sigmadesk-test-${id}.xml`);
/** Count what a junit XML says ran: { tests, failures, errors, skipped } summed over its <testsuite> elements. */
export function junitCounts(xml) {
  const out = { tests: 0, failures: 0, errors: 0, skipped: 0, suites: 0 };
  const re = /<testsuite\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    out.suites++;
    for (const k of ['tests', 'failures', 'errors', 'skipped']) out[k] += Number(m[1].match(new RegExp(`\\b${k}="(\\d+)"`))?.[1] || 0);
  }
  return out;
}
/** unittest's own summary: "Ran N tests" and "OK". */
export function unittestCounts(output) {
  const ran = String(output).match(/^Ran (\d+) tests? in /m);
  const failed = /^FAILED \(/m.test(output);
  return { tests: ran ? Number(ran[1]) : 0, failures: failed ? 1 : 0, errors: 0, skipped: Number(String(output).match(/skipped=(\d+)/)?.[1] || 0), ok: /^OK\b/m.test(output) };
}
const testPlans = new Map(); // runId -> { id, args, sha, fp }
/**
 * `desk test <module> [args…]`: what to run, inside the seat's sandbox, in its workspace: the workspace venv's python
 * when a .venv exists (only if it verifies), else the shared venv's. `sha` is the workspace HEAD (the scheduler reads it).
 */
export function testPlan(run, args, { ws, sha }) {
  if (!Array.isArray(args) || !args.length) throw err('desk test <module> [args…], e.g. desk test pytest tests/test_x.py -q');
  if (args.length > 64 || args.some((a) => typeof a !== 'string' || a.length > 1000 || a.includes('\0'))) throw err('too many or invalid arguments');
  if (!TEST_RUNNERS.includes(args[0])) throw err(`desk test runs a test runner: ${TEST_RUNNERS.join(' or ')} (got "${String(args[0]).slice(0, 60)}")`);
  const bad = args[0] === 'pytest' ? args.slice(1).find((a) => PYTEST_REFUSED.test(a)) : args.slice(1).find((a) => /^(-h|--help)$/.test(a));
  if (bad) throw err(`desk test refuses ${bad}: it must run the whole selection and report it (narrow with paths, ::node ids, -k or -m instead)`);
  let py, fp = null;
  if (hasVenv(ws)) {
    const env = qaEnvironment(run.ticket_key, ws);
    if (!env.fingerprint) throw err(`this workspace's .venv is not what the owner approved (${env.error}): it cannot be tested. Run desk pkg install again, or ask the owner`, 409);
    fp = env.fingerprint;
    py = path.join(ws, '.venv', 'bin', 'python');
  } else py = sharedEnv().python;
  if (args[0] === 'pytest' && !realDir(path.join(ws, '.git'))) throw err('desk test pytest needs the workspace clone (.git) for its report');
  const plan = { id: crypto.randomBytes(6).toString('hex'), args, sha, fp, at: nowIso() };
  testPlans.set(run.id, plan);
  // pytest writes a junit report the desk reads afterwards: what ran, what failed (exit 0 with nothing collected is not a pass).
  const extra = args[0] === 'pytest' ? [`--junitxml=${junitPath(ws, plan.id)}`] : [];
  return { id: plan.id, cwd: ws, argv: [py, '-B', '-s', '-m', ...args, ...extra], env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, interpreter: py };
}
/** The seat's `desk test` finished: re-verify the venv and commit, then record the exit status for the QA gate. */
export function testResult(run, { id, status, output = '' }, { ws, sha }) {
  const plan = testPlans.get(run.id);
  if (!plan || plan.id !== id) throw err('no desk test plan with that id in this run', 409);
  testPlans.delete(run.id);
  const code = Number.isInteger(status) ? status : -1;
  let fp = null, problem = null;
  if (plan.fp) { try { fp = fingerprint(run.ticket_key, ws); if (fp.installed_sha256 !== plan.fp.installed_sha256 || fp.lock_sha256 !== plan.fp.lock_sha256) problem = 'the workspace venv changed while the tests ran'; } catch (e) { problem = e.message; } }
  else if (hasVenv(ws)) problem = 'a .venv appeared while the tests ran';
  if (sha !== plan.sha) problem = problem || 'HEAD moved while the tests ran';
  // What actually ran: pytest's junit report, or unittest's own summary.
  let counts;
  if (plan.args[0] === 'pytest') {
    const f = junitPath(ws, plan.id);
    const xml = readSmall(f, 50_000_000);
    try { if (fs.lstatSync(f).isFile()) fs.rmSync(f); } catch { /* none */ }
    counts = xml == null ? null : junitCounts(xml);
    if (!counts || !counts.suites) problem = problem || 'pytest wrote no test report';
  } else {
    counts = unittestCounts(output);
    if (code === 0 && !counts.ok) problem = problem || 'unittest did not report OK';
  }
  if (counts && code === 0 && !problem) {
    if (counts.tests - counts.skipped < 1) problem = 'no test ran (nothing collected, or everything skipped)';
    else if (counts.failures || counts.errors) problem = `the report shows ${counts.failures} failure(s) and ${counts.errors} error(s)`;
  }
  const rec = { args: plan.args, status: code, sha, tests: counts, fp: fp ? { lock_sha256: fp.lock_sha256, installed_sha256: fp.installed_sha256, text: fpText(fp) } : null, venv: !!plan.fp, problem, at: nowIso() };
  const list = json(store.kvGet(`desk-test:${run.id}`), []);
  list.push(rec);
  store.kvSet(`desk-test:${run.id}`, JSON.stringify(list.slice(-20)));
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text: `desk test ${plan.args.join(' ').slice(0, 120)} → exit ${code}${problem ? ` (not counted: ${problem})` : ''}` });
  const ran = counts ? ` · ${counts.tests} tests (${counts.failures} failed, ${counts.errors} errors, ${counts.skipped} skipped)` : '';
  return problem ? `Exit ${code}, NOT counted: ${problem}.` : `Exit ${code}${code === 0 ? '' : ' (failed)'}${ran}${fp ? ` · ${fpText(fp)}` : ''} · at ${String(sha).slice(0, 10)}.`;
}
export const testRecords = (runId) => json(store.kvGet(`desk-test:${runId}`), []);

/** Dependencies a ticket adds (for the decision brief and reviewers): approved and installed ones. */
export function ticketDependencies(key) {
  const rows = store.pkgRequestsForTicket(key).filter((r) => r.installed_at || r.status === 'approved');
  const pins = (dev) => [...new Set(rows.filter((r) => !!r.dev === dev).flatMap((r) => json(r.specs, []).map((s) => `${s.name}==${s.version}`)))];
  const runtime = pins(false), dev = pins(true);
  const all = rows.flatMap((r) => json(r.manifest, []).filter((x) => x.role === 'add').map((x) => x.name));
  return { runtime, dev, total: new Set(all).size, transitive: Math.max(0, new Set(all).size - runtime.length - dev.length) };
}
export function dependencyText(d) {
  const n = d.runtime.length + d.dev.length;
  if (!n) return '';
  return `adds ${n} dependenc${n === 1 ? 'y' : 'ies'} (${d.runtime.length} runtime, ${d.dev.length} dev${d.transitive ? `, +${d.transitive} transitive` : ''}): ${[...d.runtime, ...d.dev.map((x) => `${x} (dev)`)].join(', ')}`;
}

// ---------------- views ----------------
const view = (r) => {
  const manifest = json(r.manifest, []);
  return { ...r, specs: json(r.specs, []), manifest, base_lock: undefined, inventory: undefined, fingerprint: json(r.fingerprint, null), seat_name: nameOf(r.seat),
    additions: manifest.filter((x) => x.role === 'add'), shared_count: manifest.filter((x) => x.role === 'shared' || x.role === 'ticket').length,
    startup: manifest.filter((x) => x.startup?.length).map((x) => ({ name: x.name, files: x.startup })) };
};
export function summary() {
  const open = store.openPkgRequests().map(view);
  return { requests: open, owner_requests: open.filter((r) => r.status === 'owner') };
}
export function details() { return { ...summary(), history: store.pkgRequestHistory(50).map(view) }; }
export function forTicket(key) { return { requests: store.pkgRequestsForTicket(key).map(view), fingerprint: recordedFingerprint(key) }; }
/** `desk pkg status`. */
export function statusText(run) {
  const rows = run.ticket_key ? store.pkgRequestsForTicket(run.ticket_key) : [];
  if (!rows.length) return 'No package requests on this ticket. Ask with: desk pkg request name==version [...] --why "…"';
  const fp = run.ticket_key ? recordedFingerprint(run.ticket_key) : null;
  const readable = new Set(launchedIds(run.id));
  return [...rows.map((r) => {
    const m = json(r.manifest, []).filter((x) => x.role === 'add');
    const state = r.status === 'approved' ? `approved until ${String(r.expires_at).slice(0, 16).replace('T', ' ')} UTC${readable.has(r.id) ? ' — readable in this run: desk pkg install' : ' — not readable in this run (approved after it started)'}${r.installed_at ? ', installed' : ''}`
      : r.status === 'owner' ? 'waiting for the owner' : r.status === 'resolving' ? 'being resolved by the desk' : `${r.status}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ''}`;
    return `#${r.id} ${specText(json(r.specs, []))}${r.dev ? ' (dev)' : ''}: ${state}${m.length ? ` · ${m.length} wheels ${mb(r.total_bytes)}` : ''}`;
  }), fp ? `Workspace venv: ${fpText(fp)}` : 'No verified workspace venv yet.'].join('\n');
}
