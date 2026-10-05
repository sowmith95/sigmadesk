// SigmaDesk Projects home: the list of project desks and the setup wizard. A small server of its own; it never opens a
// desk's database. It reads the registry, asks each desk for its /api/summary, scans repositories read-only, and
// creates and starts project desks when the owner says so. Reachable the same way as the classic desk (its hosts and
// token), so it works from a phone over the same network.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { appRoot } from '../app-paths.js';
import { listProjects, getProject, updateProject, checkTeam } from '../projects.js';
import { scanRepo } from './scan.js';
import { recommendTeam, manifestFrom, QUESTIONS } from './recommend.js';
import { provisionProject } from './provision.js';
import { installService, uninstallService } from '../service.js';
import { PACKS, ADVISORS, CORE } from '../team-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.SIGMADESK_HUB_PORT) || 8780;
const HOSTS = (process.env.SIGMADESK_HUB_HOSTS || '').split(',').filter(Boolean).length ? process.env.SIGMADESK_HUB_HOSTS.split(',').filter(Boolean) : config.server.hosts;
const TOKEN = process.env.SIGMADESK_HUB_TOKEN ?? config.server.ownerToken ?? '';
const COOKIE = 'sigmadesk_hub_token';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function send(res, code, body, type = 'application/json', headers = {}) {
  // no-referrer: desk links carry the desk's owner token; it must never leak through a Referer header.
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 2e6) throw Object.assign(new Error('body too large'), { status: 413 }); }
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
function authed(req) {
  if (!TOKEN) return true;
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
  const a = Buffer.from(String(cookie[COOKIE] || req.headers['x-sigmadesk-token'] || '')); const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// null = the desk's config could not be read (never treated as "no token": that would send an unauthenticated request).
const tokenOf = (p) => { try { return JSON.parse(fs.readFileSync(path.join(p.home, 'config.json'), 'utf8')).server?.ownerToken || ''; } catch { return null; } };
async function summaryOf(port, token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/summary`, { headers: token ? { 'x-sigmadesk-token': token } : {}, signal: AbortSignal.timeout(1500) });
    return r.ok ? { online: true, ...(await r.json()) } : { online: true, error: `HTTP ${r.status}` };
  } catch { return { online: false }; }
}
// The desk link for the browser that asked: same host it reached the hub on, the project's port, its token once, and
// optionally a desk page to land on (`next`, e.g. #/inbox/SD-12; the desk only accepts a strict page/ticket pattern).
const deskUrl = (req, port, token, next = '') => `http://${(req.headers.host || '127.0.0.1').replace(/:\d+$/, '')}:${port}/${token ? `?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}` : next}`;
const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);

// ---------------- instructions: the owner asks a desk for work from the Projects home ----------------
/** The desk a request goes to: registered projects plus the classic desk. */
function deskFor(id) {
  if (id === 'classic') return { id: config.projectId, name: config.project.name, port: config.server.port, token: config.server.ownerToken || '' };
  const p = getProject(String(id || ''));
  return p ? { id: p.id, name: p.name, port: p.port, token: tokenOf(p) } : null;
}
const titleOf = (text) => {
  const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length <= 120 ? first : `${first.slice(0, 119).replace(/\s+\S*$/, '')}…`;
};
async function sendInstruction(req, b) {
  // The hub can create work on every desk: from another device it must be signed in (no open write gateway).
  if (!TOKEN && !loopback(req)) return [403, { error: 'Set a Projects home token before sending instructions from another device' }];
  const text = String(b.text || '').trim();
  if (text.length < 3 || text.length > 8000) return [400, { error: 'Write the instruction (3 to 8000 characters)' }];
  if (b.kind !== undefined && !['auto', 'feature'].includes(b.kind)) return [400, { error: 'kind must be auto or feature' }];
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(b.request_id || ''))) return [400, { error: 'request_id required' }];
  const desk = deskFor(b.project);
  if (!desk) return [404, { error: 'No such project' }];
  if (desk.token === null) return [500, { error: `Could not read ${desk.name}'s settings to sign in to it` }];
  // Ready means this desk answered as itself: a stopped desk is offline; another service on the port is refused.
  const sum = await summaryOf(desk.port, desk.token);
  if (!sum.online) return [409, { error: `${desk.name} is not running. Start it, then send again.`, offline: true }];
  if (sum.error || (sum.id && sum.id !== desk.id && b.project !== 'classic')) return [409, { error: `${desk.name} did not answer as expected (${sum.error || 'another desk is on its port'})` }];
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${desk.port}/api/tickets`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(desk.token ? { 'x-sigmadesk-token': desk.token } : {}) },
      body: JSON.stringify({ title: titleOf(text), description: text, kind: b.kind === 'feature' ? 'feature' : 'auto', priority: /^P[0-3]$/.test(b.priority) ? b.priority : undefined, request_id: b.request_id, source: 'hub' }) });
  } catch {
    // The desk may have created it before the answer was lost: the same request id never makes a second ticket.
    return [502, { error: `${desk.name} did not answer in time. Send again: it will not create a second ticket.`, unknown: true }];
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return [r.status === 401 ? 502 : r.status, { error: r.status === 401 ? `${desk.name} refused the Projects home's sign-in` : out.error || `HTTP ${r.status}` }];
  return [r.status, { key: out.key, project: b.project, name: desk.name, duplicate: !!out.duplicate, url: deskUrl(req, desk.port, desk.token, `#/inbox/${out.key}`) }];
}

async function state(req) {
  const projects = await Promise.all(listProjects().map(async (p) => { const token = tokenOf(p); return { ...p, home: undefined, summary: await summaryOf(p.port, token), url: deskUrl(req, p.port, token) }; }));
  // The original desk (in-checkout layout) appears too, so every desk is one tap away.
  const classic = { id: 'classic', name: config.project.name, repoPath: config.project.repoPath, port: config.server.port, classic: true,
    summary: await summaryOf(config.server.port, config.server.ownerToken), url: deskUrl(req, config.server.port, config.server.ownerToken) };
  return { projects: [classic, ...projects], appRoot: appRoot(), platform: process.platform };
}

// Local git repositories the owner might add: one level under the usual code folders (names only, nothing read).
function suggestions() {
  const taken = new Set([config.project.repoPath, ...listProjects().map((p) => p.repoPath)].filter(Boolean).map((p) => path.resolve(p)));
  const out = [];
  for (const dir of ['projects', 'code', 'src', 'dev', 'Developer', 'repos', 'work', 'git'].map((d) => path.join(os.homedir(), d))) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(full, '.git')) && fs.statSync(path.join(full, '.git')).isDirectory() && !taken.has(full)) out.push({ path: full, name: e.name });
      if (out.length >= 60) break;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (url.searchParams.get('token') && TOKEN) {
    if (url.searchParams.get('token') !== TOKEN) return send(res, 401, 'bad token', 'text/plain');
    return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  const isApi = p.startsWith('/api/');
  if (isApi && !authed(req)) return send(res, 401, { error: 'open /?token=<owner token> once on this device' });
  if (isApi && req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
  let mm;
  if (req.method === 'GET' && p === '/api/hub/state') return send(res, 200, await state(req));
  if (req.method === 'GET' && p === '/api/hub/catalog') return send(res, 200, { questions: QUESTIONS, packs: PACKS, advisors: Object.fromEntries(Object.entries(ADVISORS).map(([id, a]) => [id, { name: a.name, role: a.role, bio: a.bio, pack: a.pack }])), core: CORE });
  if (req.method === 'GET' && p === '/api/hub/repos') return send(res, 200, { repos: suggestions() });
  if (req.method === 'POST' && p === '/api/hub/scan') { const b = await readBody(req); return send(res, 200, scanRepo(String(b.repoPath || '').replace(/^~(?=\/)/, os.homedir()))); }
  if (req.method === 'POST' && p === '/api/hub/recommend') { const b = await readBody(req); return send(res, 200, recommendTeam(b.scan || {}, b.answers || {})); }
  if (req.method === 'POST' && p === '/api/hub/instructions') { const [code, body] = await sendInstruction(req, await readBody(req)); return send(res, code, body); }
  if (req.method === 'POST' && p === '/api/hub/projects') {
    const b = await readBody(req);
    const team = b.team || manifestFrom(recommendTeam(b.scan || {}, b.answers || {}));
    const problems = checkTeam(team);
    if (problems.length) return send(res, 400, { error: `The team is not ready: ${problems.join('; ')}` });
    const proj = provisionProject({ repoPath: String(b.repoPath || '').replace(/^~(?=\/)/, os.homedir()), name: b.name, answers: b.answers || {}, scan: b.scan || {}, team, hosts: config.server.hosts });
    let started = false; let startError = null;
    // SIGMADESK_HUB_NO_SERVICES: tests and previews never install a real background service.
    if (b.start !== false && process.env.SIGMADESK_HUB_NO_SERVICES) startError = 'background services are off in this preview';
    else if (b.start !== false) { try { installService(getProject(proj.id)); updateProject(proj.id, { state: 'installed', installed_at: new Date().toISOString() }); started = true; } catch (err) { startError = err.message; } }
    return send(res, 201, { id: proj.id, name: proj.name, port: proj.port, started, startError, url: deskUrl(req, proj.port, proj.token) });
  }
  if (req.method === 'POST' && (mm = p.match(/^\/api\/hub\/projects\/([a-z0-9-]+)\/(start|stop)$/))) {
    const proj = getProject(mm[1]);
    if (!proj) return send(res, 404, { error: 'no such project' });
    if (process.env.SIGMADESK_HUB_NO_SERVICES) return send(res, 409, { error: 'background services are off in this preview' });
    if (mm[2] === 'start') { installService(proj); updateProject(proj.id, { state: 'installed' }); } else { uninstallService(proj); updateProject(proj.id, { state: 'stopped' }); }
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && !isApi) {
    const rel = p === '/' ? 'hub.html' : decodeURIComponent(p.slice(1));
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (rel.startsWith('app/') || path.extname(rel)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'hub.html')), MIME['.html'], { 'Content-Security-Policy': CSP });
    }
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {});
  }
  return send(res, 404, { error: 'not found' });
}

export function main() {
  for (const host of HOSTS) {
    const srv = http.createServer((req, res) => route(req, res).catch((err) => { if (!res.headersSent) send(res, err.status || 500, { error: err.message }); }));
    srv.on('error', (err) => { console.error(`hub listen ${host}:${PORT} failed: ${err.message}`); process.exit(1); });
    srv.listen(PORT, host, () => console.log(`SigmaDesk Projects on http://${host}:${PORT}`));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
