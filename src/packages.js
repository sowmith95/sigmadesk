// Package installs for seats (#8): a typed capability, separate from production probe grants.
//
// Seats have no network and the shared project venv is read-only to them. When a seat needs a Python package:
//  1. it asks with exact pins: `desk pkg request name==version [...] --why "…"` (canonical names; no extras, markers,
//     URLs, ranges or options);
//  2. the DESK (this process, never a seat) resolves the full set with the shared venv's own pip, wheels only, PyPI
//     only, constrained to the shared venv's current distributions (nothing that exists may change version), in a
//     scrubbed environment, and downloads every wheel itself through the desk's HTTPS client (files.pythonhosted.org
//     only, redirects re-checked, size and time limits), verifying each sha256 against the resolver's report. It never
//     runs workspace Python. The set is staged under data/pkg/<id>/ (desk-owned, read-only);
//  3. the OWNER approves the manifest in the Inbox (every addition, transitive ones too, versions, sizes, hashes). Probe
//     `*`, owner-mention auto-grants and post-deploy grants never cover packages: they live in their own table;
//  4. the seat's next run on that ticket can read that stage (and only that stage), and `desk pkg install` installs it
//     OFFLINE inside its sandbox into <workspace>/.venv, layered read-only on the shared venv through a .pth file,
//     with --no-index --no-deps --require-hashes and pip itself run from a wheel in the stage;
//  5. the desk reads the resulting venv back (never executing it) and records its fingerprint on the ticket; QA must
//     test with that venv and its verdict names the fingerprint.
// Revoking, expiry or the ticket closing ends the grant: the stage is deleted and further installs are refused (what
// was already installed stays in that one workspace, which dies with the ticket).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import { agentById } from './team.js';
import { notify } from './notify.js';
import * as net from './netfetch.js';

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

// ---------------- the shared environment ----------------
function pyvenvCfg(venv) {
  try { return fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8'); } catch { return ''; }
}
/** The shared venv: interpreter, its directory, Python version and site-packages. Throws when none is configured. */
export function sharedEnv() {
  const configured = P().python;
  const fromRo = (config.project.readOnlyPaths || []).find((p) => p && fs.existsSync(path.join(p, 'pyvenv.cfg')) && fs.existsSync(path.join(p, 'bin', 'python')));
  const python = configured || (fromRo ? path.join(fromRo, 'bin', 'python') : '');
  if (!python || !fs.existsSync(python)) throw err('no shared Python environment is configured (packages.python, or a venv in project.readOnlyPaths)', 409);
  const venv = path.dirname(path.dirname(python));
  const version = pyvenvCfg(venv).match(/^version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/m)?.[1];
  if (!version) throw err(`${venv} has no pyvenv.cfg with a Python version: not a venv`, 409);
  const xy = version.split('.').slice(0, 2).join('.');
  const site = path.join(venv, 'lib', `python${xy}`, 'site-packages');
  if (!fs.existsSync(site)) throw err(`${site} does not exist`, 409);
  return { python, venv, version, xy, site };
}
/** Owner env never reaches pip: a fixed, minimal environment (no PIP_*, no proxies, no user config, empty HOME). */
export function scrubbedEnv(work) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}
/** Run a trusted (shared-venv) command with a time limit; optional byte cap on a directory it writes. */
function run(argv, { env, cwd, timeoutMs = 120_000, watchDir = null, maxBytes = Infinity }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let out = '', errOut = '', why = null;
    const kill = (reason) => { if (!why) { why = reason; try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    child.stdout.on('data', (c) => { out = (out + c).slice(-200_000); });
    child.stderr.on('data', (c) => { errOut = (errOut + c).slice(-20_000); });
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const watch = watchDir ? setInterval(() => { if (dirBytes(watchDir) > maxBytes) kill(`used more than ${mb(maxBytes)} while resolving`); }, 250) : null;
    child.on('error', (e) => { why = why || e.message; });
    child.on('close', (code) => { clearTimeout(timer); if (watch) clearInterval(watch); resolve({ code: why ? -1 : code, out, err: errOut, why }); });
  });
}
function dirBytes(dir) {
  let n = 0;
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { n += fs.lstatSync(p).size; } catch { /* gone */ } } } };
  walk(dir);
  return n;
}
/** The shared venv's distributions: canonical name → { name, version, editable }. */
export async function sharedDistributions(env = sharedEnv(), work = null) {
  const w = work || fs.mkdtempSync(path.join(pkgRoot(), '.list-'));
  try {
    for (const d of ['home', 'tmp']) fs.mkdirSync(path.join(w, d), { recursive: true });
    const r = await run([env.python, '-I', '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check', '--isolated'], { env: scrubbedEnv(w), cwd: w, timeoutMs: 60_000 });
    if (r.code !== 0) throw err(`could not list the shared environment (${r.why || (r.err || '').trim().split('\n').at(-1) || `exit ${r.code}`})`, 502);
    const rows = json(r.out, null);
    if (!Array.isArray(rows)) throw err('could not read the shared environment\'s package list', 502);
    return Object.fromEntries(rows.filter((x) => x && x.name && x.version).map((x) => [canonicalName(x.name), { name: canonicalName(x.name), version: String(x.version), editable: !!x.editable_project_location }]));
  } finally { if (!work) fs.rmSync(w, { recursive: true, force: true }); }
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
  for (const w of m.filter((x) => x.role !== 'shared')) {
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

// ---------------- requests ----------------
let onApproved = null; // the scheduler resumes a ticket that was parked waiting for this approval
export function setOnApproved(fn) { onApproved = fn; }
const active = new Set(); // ids being resolved in this process
let queue = Promise.resolve();
const comment = (key, author, text) => { if (key && store.getTicket(key)) store.addComment(key, author, text); };
const specText = (specs) => specs.map((s) => `${s.name}==${s.version}`).join(', ');

/** A seat asks for packages (desk pkg request). Returns a message; the resolution runs in the background. */
export function request(run, { specs, why, dev = false }) {
  if (P().enabled === false) throw err('package installs are switched off (packages.enabled)', 403);
  if (!INSTALL_KINDS.has(run.kind) || !run.ticket_key) throw err('packages are requested from a build run on your own ticket (implement, respond, resolve)', 403);
  const t = store.getTicket(run.ticket_key);
  if (!t || CLOSED_TICKET.includes(t.status)) throw err('this ticket is closed', 409);
  const pins = parseSpecs(specs);
  if (!String(why || '').trim()) throw err('say why: --why "<what needs it and why the shared environment cannot do it>"');
  sharedEnv(); // fail now, not in the background, when there is nothing to layer on
  const dup = store.openPkgRequests().find((r) => r.seat === run.agent_id && r.ticket_key === run.ticket_key && r.status !== 'approved' && r.specs === JSON.stringify(pins));
  if (dup) return `Request #${dup.id} for ${specText(pins)} is already ${dup.status === 'resolving' ? 'being resolved' : "with the owner"}.`;
  const r = store.insertPkgRequest({ seat: run.agent_id, ticket_key: run.ticket_key, run_id: run.id, why: String(why).slice(0, 500), specs: pins, dev });
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text: `asked to install ${specText(pins)}${dev ? ' (dev)' : ''}: ${r.why}` });
  comment(run.ticket_key, run.agent_id, `📦 Asked to install ${esc(specText(pins))}${dev ? ' (development/test only)' : ''}: ${esc(r.why)}\n\nThe desk resolves every dependency (wheels from PyPI only, nothing in the shared environment changes) and the owner approves the full list.`);
  enqueue(r.id);
  return `Request #${r.id} filed: the desk is resolving the full dependency set from PyPI (wheels only; nothing in the shared environment may change); then the owner approves it in the Inbox. Check with desk pkg status. Once approved, the wheels are readable from your next run on this ticket, where desk pkg install installs them offline into .venv. If you cannot continue without it, end this run with: desk needs-human "waiting for package request #${r.id}" (the approval resumes the ticket).`;
}
function enqueue(id) {
  if (active.has(id)) return;
  active.add(id);
  queue = queue.then(() => resolveRequest(id)).catch(() => {}).finally(() => active.delete(id));
}
/** Wait for every queued resolution (tests, shutdown). */
export const settled = () => queue;

/** Resolve one request into a staged, hash-verified wheel set (or fail it with the reason). */
export async function resolveRequest(id) {
  const r = store.getPkgRequest(id);
  if (!r || r.status !== 'resolving') return r;
  const stage = stageDir(id);
  const work = path.join(stage, '.work');
  try {
    removeStage(id);
    for (const d of ['home', 'tmp']) fs.mkdirSync(path.join(work, d), { recursive: true });
    const env = sharedEnv();
    const specs = json(r.specs, []);
    const shared = await sharedDistributions(env, work);
    for (const s of specs) {
      const have = shared[s.name];
      if (have && have.version === s.version) throw err(`${s.name} ${s.version} is already in the shared environment: nothing to install`);
      if (have) throw err(`would replace ${s.name} ${have.version} with ${s.version} in the shared environment: refused (no existing distribution changes version)`);
    }
    const pipVersion = shared.pip?.version;
    if (!pipVersion) throw err('the shared environment has no pip to resolve with');
    // Constraints: every distribution the shared venv has stays at exactly its version.
    const constraints = path.join(work, 'constraints.txt');
    fs.writeFileSync(constraints, `${Object.values(shared).filter((d) => !d.editable).map((d) => `${d.name}==${d.version}`).join('\n')}\n`);
    const report = path.join(work, 'report.json');
    const maxTotal = (Number(P().maxTotalMB) || 300) * 1e6;
    // --dry-run with --target: pip resolves the whole closure (ignoring what is installed) and installs nothing — and
    // even if a dry run ever did install, it would go to the throwaway target, never the shared venv.
    const argv = [env.python, '-I', '-m', 'pip', 'install', '--dry-run', '--isolated', '--target', path.join(work, 'target'), '--only-binary=:all:', '--no-cache-dir',
      '--disable-pip-version-check', '--no-input', '--index-url', PYPI_INDEX, '--report', report, '-c', constraints, ...specs.map((s) => `${s.name}==${s.version}`), `pip==${pipVersion}`];
    const res = await run(argv, { env: scrubbedEnv(work), cwd: work, timeoutMs: (Number(P().resolveTimeoutSeconds) || 180) * 1000, watchDir: work, maxBytes: maxTotal });
    if (res.code !== 0) {
      const tail = (res.err || '').trim().split('\n').filter((l) => /ERROR|conflict|requested|No matching|Could not find/i.test(l)).slice(-6).join(' · ');
      throw err(res.why ? `resolution stopped: ${res.why}` : /ResolutionImpossible|conflict/i.test(res.err) ? `cannot be added without changing a distribution the shared environment already has (or the pins conflict): ${tail || 'see pip output'}` : `pip could not resolve it: ${tail || (res.err || '').trim().split('\n').at(-1) || `exit ${res.code}`}`);
    }
    const manifest = manifestFromReport(json(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '', null), { specs, shared, pipVersion });
    // Download every wheel ourselves: fixed host, every redirect re-checked, per-file and total byte caps, hash verified.
    let total = 0;
    for (const w of manifest.filter((x) => x.role !== 'shared')) {
      const left = maxTotal - total;
      if (left <= 0) throw err(`the wheels are larger than ${mb(maxTotal)} together`);
      const file = path.join(stage, w.filename);
      const got = await net.safeFetch(w.url, { hosts: FILE_HOSTS, maxBytes: Math.min(left, (Number(P().maxFileMB) || 150) * 1e6), timeoutMs: (Number(P().downloadTimeoutSeconds) || 120) * 1000, maxRedirects: 2, file });
      if (got.status !== 200) { fs.rmSync(file, { force: true }); throw err(`downloading ${w.filename} answered HTTP ${got.status}`, 502); }
      if (got.sha256 !== w.sha256) { fs.rmSync(file, { force: true }); throw err(`${w.filename} does not match the sha256 PyPI's index gave (${got.sha256.slice(0, 12)}… ≠ ${w.sha256.slice(0, 12)}…)`, 502); }
      w.size = got.bytes;
      total += got.bytes;
    }
    fs.rmSync(work, { recursive: true, force: true });
    fs.writeFileSync(path.join(stage, 'manifest.txt'), manifestText(manifest));
    ensureCa(env);
    // Read-only for everyone, owner included (the desk loosens it only to delete the stage).
    for (const f of fs.readdirSync(stage)) fs.chmodSync(path.join(stage, f), 0o444);
    fs.chmodSync(stage, 0o555);
    const base = Object.fromEntries(Object.values(shared).map((d) => [d.name, d.version]));
    const adds = manifest.filter((x) => x.role === 'add');
    const upd = store.updatePkgRequest(id, { status: 'owner', manifest, total_bytes: total, base_lock: base, error: null });
    const t = store.getTicket(r.ticket_key);
    const text = `${nameOf(r.seat)} asks to install ${adds.length} package${adds.length === 1 ? '' : 's'} (${specText(specs)}${adds.length > specs.length ? ` + ${adds.length - specs.length} dependencies` : ''}, ${mb(total)}) for ${r.ticket_key}`;
    store.logEvent({ agent_id: 'system', ticket_key: r.ticket_key, kind: 'action', text: `${text} → the owner decides` });
    comment(r.ticket_key, 'system', `📦 Resolved package request #${id}: ${esc(adds.map((x) => `${x.name}==${x.version}`).join(', '))} (${mb(total)}, wheels from PyPI, hashes verified). The owner decides in the Inbox.`);
    notify('needs_human', t, `Let ${nameOf(r.seat)} install ${adds.length} package${adds.length === 1 ? '' : 's'} for ${r.ticket_key}?`);
    return upd;
  } catch (e) {
    removeStage(id);
    const msg = String(e.message || e).slice(0, 600);
    store.updatePkgRequest(id, { status: 'failed', error: msg });
    store.logEvent({ agent_id: 'system', ticket_key: r.ticket_key, kind: 'action', text: `package request #${id} refused: ${msg}` });
    comment(r.ticket_key, 'system', `📦 Package request #${id} could not be prepared: ${esc(msg)}`);
    return store.getPkgRequest(id);
  }
}

/**
 * pip's installation report → the manifest. Every item must be a wheel on files.pythonhosted.org with a sha256 and not
 * a direct URL. Items the shared venv already has (same version) are 'shared' (never downloaded or installed); a
 * different version of one of them is refused; pip itself is the 'installer' (run from the stage, not installed).
 */
export function manifestFromReport(rep, { specs, shared, pipVersion }) {
  if (!rep || !Array.isArray(rep.install)) throw err('pip produced no installation report');
  const out = [];
  for (const it of rep.install) {
    const name = canonicalName(it?.metadata?.name || '');
    const version = String(it?.metadata?.version || '');
    if (!name || !version) throw err('the report names a distribution without a name or version');
    if (it.is_direct) throw err(`${name} would come from a direct URL: refused (PyPI only)`);
    let u; try { u = new URL(it.download_info?.url || ''); } catch { throw err(`${name} has no download URL`); }
    if (u.protocol !== 'https:' || !FILE_HOSTS.includes(u.hostname)) throw err(`${name} would be downloaded from ${u.host || 'nowhere'}: only ${FILE_HOSTS.join(', ')} is allowed`);
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
    }
    if (out.some((x) => x.name === name)) throw err(`${name} appears twice in the report`);
    out.push({ name, version, filename, url: u.toString(), sha256, size: null, requested: specs.some((s) => s.name === name), role });
  }
  for (const s of specs) if (!out.some((x) => x.name === s.name && x.version === s.version && x.role === 'add')) throw err(`${s.name}==${s.version} is not in pip's resolution`);
  if (!out.some((x) => x.role === 'installer')) throw err('pip\'s own wheel is missing from the resolution');
  const files = out.filter((x) => x.role !== 'shared').length;
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
    removeStage(r.id);
    store.updatePkgRequest(r.id, { status: 'denied', decided_by: by, decided_at: nowIso(), note: String(note || '').slice(0, 300) || null });
    const text = `The owner declined package request #${r.id}${note ? `: ${note}` : ''}`;
    store.logEvent({ agent_id: 'owner', ticket_key: r.ticket_key, kind: 'action', text });
    comment(r.ticket_key, 'owner', `📦 ${esc(text)}.`);
    return 'Declined.';
  }
  if (action !== 'approve') throw err('approve | deny');
  if (!t || CLOSED_TICKET.includes(t.status)) throw err(`${r.ticket_key} is closed`, 409);
  const problems = verifyStage(r);
  if (problems.length) {
    removeStage(r.id);
    store.updatePkgRequest(r.id, { status: 'failed', error: `staged wheels changed: ${problems.join('; ')}` });
    throw err(`the staged wheels changed since they were resolved (${problems.join('; ')}): refused; ask again`, 409);
  }
  const hours = Math.max(1, Math.min(Number(P().grantHours) || 24, 168));
  store.updatePkgRequest(r.id, { status: 'approved', decided_by: by, decided_at: nowIso(), note: String(note || '').slice(0, 300) || null, expires_at: new Date(Date.now() + hours * 3600_000).toISOString() });
  const adds = json(r.manifest, []).filter((x) => x.role === 'add');
  const text = `The owner approved package request #${r.id} for ${nameOf(r.seat)}: ${adds.map((x) => `${x.name}==${x.version}`).join(', ')}`;
  store.logEvent({ agent_id: 'owner', ticket_key: r.ticket_key, kind: 'action', text });
  comment(r.ticket_key, 'owner', `📦 ${esc(text)}.\n\n${nameOf(r.seat)} installs it offline into this ticket's .venv with \`desk pkg install\` (in a run started from now on; usable for ${hours}h and only while ${r.ticket_key} is open). Add the dependency to the right requirements file.`);
  try { onApproved?.(store.getPkgRequest(r.id)); } catch { /* the approval stands */ }
  return `Approved (#${r.id}).`;
}
/** Revoke an approved (or pending) request now: the stage is deleted and installs are refused from now on. */
export function revoke(id, by = 'owner', reason = '') {
  const r = store.getPkgRequest(Number(id));
  if (!r || !OPEN.includes(r.status)) throw err(`no open package request #${id}`, 404);
  if (by !== 'owner') throw err('only the owner revokes package grants', 403);
  endRequest(r, 'revoked', by, reason || 'revoked by the owner');
  return `Revoked #${r.id}.`;
}
function endRequest(r, status, by, reason) {
  removeStage(r.id);
  store.updatePkgRequest(r.id, { status, revoked_at: nowIso(), revoked_by: by, note: reason ? String(reason).slice(0, 300) : r.note });
  const text = status === 'revoked' ? `The owner revoked package request #${r.id}${reason ? `: ${reason}` : ''}` : `Package request #${r.id} ended (${status})`;
  store.logEvent({ agent_id: by === 'owner' ? 'owner' : 'system', ticket_key: r.ticket_key, kind: 'action', text });
  if (status === 'revoked') comment(r.ticket_key, 'owner', `📦 ${esc(text)}. Further installs from it are refused; what is already in this workspace's .venv stays there.`);
}
/** Emergency stop (Access sheet "Revoke all"): every package grant and request ends. */
export function revokeAll(by = 'owner', reason = 'emergency: revoke all') {
  let n = 0;
  for (const r of store.openPkgRequests()) { endRequest(r, 'revoked', by, reason); n++; }
  return n;
}
/** Expiry, closed tickets, and resolutions orphaned by a restart. */
export function sweep(at = nowIso()) {
  for (const r of store.openPkgRequests()) {
    const t = store.getTicket(r.ticket_key);
    if (!t || CLOSED_TICKET.includes(t.status)) { endRequest(r, r.status === 'approved' ? 'closed' : 'withdrawn', 'system', 'the ticket closed'); continue; }
    if (r.status === 'approved' && r.expires_at && r.expires_at <= at) { endRequest(r, 'expired', 'system', 'expired'); continue; }
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

const VERIFY_PY = [
  'import importlib, importlib.metadata as md, json, sys',
  'bad = []',
  'for name in sys.argv[1:]:',
  '    try:',
  '        d = md.distribution(name)',
  '    except Exception as e:',
  '        bad.append(f"{name}: not installed ({e})"); continue',
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
/** The .pth line that layers the shared venv under the workspace venv (read-only: nothing is ever written there). */
export const pthText = (sharedSite) => `import site; site.addsitedir(${JSON.stringify(sharedSite)})\n`;
/** Environment for every offline install step inside the seat's sandbox. */
export function installEnv(ca) {
  return { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PIP_CONFIG_FILE: '/dev/null', PIP_CERT: ca, PIP_NO_INDEX: '1', PIP_NO_CACHE_DIR: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' };
}
/**
 * The exact offline steps `desk pkg install` runs inside the seat's sandbox. Pure (tests check it):
 *  1. python -m venv --without-pip <ws>/.venv on the shared venv's interpreter (skipped when it exists);
 *  2. a .pth in its site-packages layering the shared venv's site-packages (explicit, read-only: not --system-site-packages);
 *  3. .venv/ excluded from git;
 *  4. per approved request: pip (from the wheel in the stage) install --no-index --no-deps --require-hashes from the stage;
 *  5. import every added distribution.
 */
export function installSteps({ ws, env, stages, ca }) {
  const venv = path.join(ws, '.venv');
  const vpy = path.join(venv, 'bin', 'python');
  const site = path.join(venv, 'lib', `python${env.xy}`, 'site-packages');
  // pip's scratch space lives inside the workspace (the only place every engine's sandbox lets the seat write).
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
    { label: 'import what was added', argv: [vpy, '-B', '-s', '-c', VERIFY_PY, ...adds], env: e },
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
function readSmall(p, max = 262_144) {
  let st; try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.size > max) return null;
  return fs.readFileSync(p, 'utf8');
}
const realDir = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
/** What <ws>/.venv holds: Python version, the .pth, its distributions. null when there is no venv. */
export function readVenv(ws) {
  const venv = path.join(ws, '.venv');
  if (!realDir(venv)) return null;
  const cfg = readSmall(path.join(venv, 'pyvenv.cfg'), 8192);
  if (cfg == null) return null;
  const version = cfg.match(/^version(?:_info)?\s*=\s*(\S+)/m)?.[1] || null;
  const xy = version ? version.split('.').slice(0, 2).join('.') : null;
  const site = xy ? path.join(venv, 'lib', `python${xy}`, 'site-packages') : null;
  const dists = [];
  // Every component is a real directory (a seat-planted link must not make the desk read somewhere else).
  const siteOk = !!site && [path.join(venv, 'lib'), path.join(venv, 'lib', `python${xy}`), site].every(realDir);
  if (siteOk) {
    for (const d of fs.readdirSync(site).filter((x) => x.endsWith('.dist-info')).sort().slice(0, 500)) {
      if (!realDir(path.join(site, d))) continue;
      const meta = readSmall(path.join(site, d, 'METADATA')) || '';
      const name = meta.match(/^Name:\s*(\S+)/m)?.[1], ver = meta.match(/^Version:\s*(\S+)/m)?.[1];
      if (name && ver) dists.push({ name: canonicalName(name), version: ver });
    }
  }
  return { venv, version, xy, site, dists, pth: siteOk ? readSmall(path.join(site, PTH_NAME), 4096) : null, system: /^include-system-site-packages\s*=\s*true/mi.test(cfg) };
}
const lockHash = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
/**
 * The workspace venv's fingerprint, checked against what the owner approved for this ticket: Python and platform, the
 * full lock (shared venv + additions) and every added wheel's sha256. Throws when the venv is not what was approved.
 */
export function fingerprint(ticketKey, ws) {
  const v = readVenv(ws);
  if (!v) throw err('there is no .venv in this workspace', 409);
  if (v.system) throw err('.venv was created with system site-packages: recreate it with desk pkg install', 409);
  const env = sharedEnv();
  if (v.pth !== pthText(env.site)) throw err(`.venv does not layer the shared venv as the desk wrote it (${PTH_NAME})`, 409);
  const approved = store.pkgRequestsForTicket(ticketKey).filter((r) => ['approved', 'expired', 'closed', 'revoked'].includes(r.status) && r.decided_by === 'owner' && r.manifest);
  const expected = new Map();
  for (const r of approved) for (const w of json(r.manifest, []).filter((x) => x.role === 'add')) expected.set(w.name, { ...w, dev: !!r.dev, request: r.id });
  const unexpected = v.dists.filter((d) => !(expected.get(d.name)?.version === d.version));
  if (unexpected.length) throw err(`.venv holds distributions nobody approved: ${unexpected.map((d) => `${d.name}==${d.version}`).join(', ')}`, 409);
  const base = json(approved.at(-1)?.base_lock, {});
  const added = v.dists.map((d) => expected.get(d.name)).map((w) => ({ name: w.name, version: w.version, sha256: w.sha256, dev: w.dev, request: w.request }));
  const lock = [...Object.entries(base).map(([n, ver]) => `${n}==${ver}`), ...added.map((a) => `${a.name}==${a.version}`)].sort();
  return { python: v.version, platform: `${process.platform}-${process.arch}`, shared_venv: env.venv, shared_lock_sha256: lockHash(Object.entries(base).map(([n, ver]) => `${n}==${ver}`).sort()),
    added, lock_size: lock.length, lock_sha256: lockHash(lock), verified_at: nowIso() };
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
  const fp = fingerprint(run.ticket_key, store.getRun(run.id)?.cwd);
  for (const id of ids) store.updatePkgRequest(id, { installed_at: nowIso(), install_run: run.id, fingerprint: fp });
  store.kvSet(`venv:${run.ticket_key}`, JSON.stringify(fp));
  const text = `installed ${fp.added.map((a) => `${a.name}==${a.version}`).join(', ')} offline into .venv (Python ${fp.python}, ${fp.platform}; lock ${fp.lock_sha256.slice(0, 12)})`;
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'action', text });
  comment(run.ticket_key, 'system', `📦 ${nameOf(run.agent_id)} ${esc(text)}. Tests and QA must run with \`.venv/bin/python\`.`);
  return `Installed and verified: ${fpText(fp)}. Run tests with .venv/bin/python (e.g. .venv/bin/python -m pytest …), and add ${fp.added.filter((a) => expectedRequested(run.ticket_key, a.name)).map((a) => `${a.name}==${a.version}`).join(', ')} to the right requirements file.`;
}
const expectedRequested = (key, name) => store.pkgRequestsForTicket(key).some((r) => json(r.specs, []).some((s) => s.name === name));
export const fpText = (fp) => `Python ${fp.python} (${fp.platform}), +${fp.added.length} package${fp.added.length === 1 ? '' : 's'} on the shared venv, lock ${fp.lock_size} distributions sha256 ${fp.lock_sha256.slice(0, 12)}`;
export const recordedFingerprint = (key) => json(store.kvGet(`venv:${key}`), null);

/** For the QA gate: does this workspace have its own venv, and what is it? */
export function qaEnvironment(ticketKey, ws) {
  if (!readVenv(ws)) return { venv: false };
  try {
    const fp = fingerprint(ticketKey, ws);
    const was = recordedFingerprint(ticketKey);
    return { venv: true, fingerprint: fp, note: `Environment: ${ws}/.venv — ${fpText(fp)}${was && was.lock_sha256 !== fp.lock_sha256 ? ' (changed since the recorded install)' : ''}` };
  } catch (e) {
    return { venv: true, fingerprint: null, note: `Environment: ${ws}/.venv — NOT verified (${e.message})` };
  }
}

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
  return { ...r, specs: json(r.specs, []), manifest, base_lock: undefined, fingerprint: json(r.fingerprint, null), seat_name: nameOf(r.seat),
    additions: manifest.filter((x) => x.role === 'add'), shared_count: manifest.filter((x) => x.role === 'shared').length };
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
