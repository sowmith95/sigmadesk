import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, validateConfig } from './config.js';
import { AGENTS, ENGINEERS, STATUSES } from './team.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as sched from './scheduler.js';
import * as watch from './watch.js';

const PUBLIC = path.join(config.root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const KEY = '([A-Z][A-Z0-9]*-\\d+)';

function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

export function snapshot() {
  const states = Object.fromEntries(store.listAgentStates().map((a) => [a.id, a]));
  const spend = store.spendByAgentSince(sched.startOfToday());
  const settings = store.getSettings();
  return {
    agents: AGENTS.map(({ charter, ...a }) => ({ ...a, ...states[a.id], spend_today: spend[a.id] || 0 })),
    tickets: store.listTickets(),
    events: store.recentEvents({ limit: 200 }),
    runs: store.recentRuns(40),
    settings,
    incidents: config.watch.enabled ? store.listIncidents({ limit: 150 }).map((i) => ({ ...i, window_count: watch.windowCount(i.signature) })) : [],
    meta: {
      watch: { enabled: config.watch.enabled, sources: watch.health(), window_minutes: config.watch.windowMinutes, min_count: config.watch.newSignatureMinCount },
      project: config.project.name, repo: config.project.githubRepo, spend_today: store.spendSince(sched.startOfToday()),
      capacity: sched.capacity(settings), busy_window: sched.inBusyWindow(), running: runner.runningCount(),
      engineers: ENGINEERS, statuses: STATUSES, last_event_id: store.recentEvents({ limit: 1 })[0]?.id || 0,
    },
  };
}

// ---------------- SSE ----------------
const clients = new Set();
store.bus.on('msg', (m) => {
  const id = m.type === 'event' ? `id: ${m.data.id}\n` : '';
  const line = `${id}data: ${JSON.stringify(m)}\n\n`;
  for (const res of clients) res.write(line);
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000).unref();

// ---------------- owner auth (optional shared token → HttpOnly cookie) ----------------
const COOKIE = 'sigmadesk_token';
function ownerAuthed(req) {
  const tok = config.server.ownerToken;
  if (!tok) return true;
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
  const given = cookie[COOKIE] || req.headers['x-sigmadesk-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(tok);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------- owner/UI listener (TCP) ----------------
async function ownerRoute(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = (re) => p.match(new RegExp(re.replace('KEY', KEY)));
  let mm;

  if (url.searchParams.get('token') && config.server.ownerToken) {
    if (url.searchParams.get('token') !== config.server.ownerToken) return send(res, 401, 'bad token', 'text/plain');
    return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `${COOKIE}=${config.server.ownerToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  const isApi = p.startsWith('/api/');
  if (isApi && !ownerAuthed(req)) return send(res, 401, { error: 'open /?token=<ownerToken> once on this device' });
  // CSRF: state-changing calls must be JSON from this origin (SameSite=Strict cookie + content-type check).
  if (isApi && req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });

  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && p === '/api/state') return send(res, 200, snapshot());
  if (req.method === 'GET' && (mm = m('^/api/tickets/KEY$'))) {
    const t = store.getTicket(mm[1]);
    if (!t) return send(res, 404, { error: 'not found' });
    return send(res, 200, { ticket: t, comments: store.listComments(t.key), events: store.recentEvents({ ticket_key: t.key, limit: 600 }) });
  }
  if (req.method === 'GET' && (mm = m('^/api/agents/([\\w-]+)/events$'))) return send(res, 200, store.recentEvents({ agent_id: mm[1], limit: 300 }));
  if (req.method === 'GET' && (mm = m('^/api/agents/([\\w-]+)$'))) {
    return send(res, 200, { stats: store.agentStats(mm[1]), events: store.recentEvents({ agent_id: mm[1], limit: 300 }),
      tickets: store.listTickets().filter((t) => t.assignee === mm[1] || t.reporter === mm[1]).slice(0, 30) });
  }

  if (req.method === 'POST' && p === '/api/tickets') return send(res, 201, sched.ownerCreate(await readBody(req)));
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/reply$'))) return send(res, 200, sched.ownerReply(mm[1], (await readBody(req)).body));
  if (req.method === 'PATCH' && (mm = m('^/api/tickets/KEY$'))) return send(res, 200, sched.ownerPatch(mm[1], await readBody(req)));
  if (req.method === 'POST' && p === '/api/settings') {
    const b = await readBody(req);
    store.setSetting(b.key, b.value);
    store.logEvent({ kind: 'system', agent_id: 'owner', text: `setting ${b.key} = ${b.value}` });
    return send(res, 200, store.getSettings());
  }
  if (req.method === 'POST' && p === '/api/control/start') {
    store.setSetting('paused', 'false');
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '▶ Desk open — seats will pick up work' });
    sched.tick();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/pause') {
    store.setSetting('paused', 'true');
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '⏸ Desk halted — running work finishes, nothing new starts' });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/stop-all') {
    store.setSetting('paused', 'true');
    runner.killAll('owner circuit breaker');
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '⛔ Circuit breaker — desk halted and every running seat stopped' });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/research') {
    const b = await readBody(req);
    sched.launchResearch(String(b.focus || '').slice(0, 500)).catch((err) => store.logEvent({ kind: 'error', agent_id: 'pm', text: err.message }));
    return send(res, 202, { ok: true });
  }
  if (req.method === 'POST' && (mm = m('^/api/incidents/(\\d+)$'))) {
    const inc = store.getIncident(Number(mm[1]));
    if (!inc) return send(res, 404, { error: 'not found' });
    const { action } = await readBody(req);
    if (action === 'mute') store.updateIncident(inc.id, { status: 'muted', note: 'muted by owner' });
    else if (action === 'unmute' || action === 'investigate') store.updateIncident(inc.id, { status: 'watching', note: action === 'investigate' ? 'owner asked for investigation' : null, attempts: 0 });
    else return send(res, 400, { error: 'action mute|unmute|investigate' });
    if (action === 'investigate') store.logEvent({ kind: 'system', agent_id: 'owner', text: `owner asked SRE to look at incident #${inc.id}` });
    return send(res, 200, store.getIncident(inc.id));
  }
  if (req.method === 'POST' && (mm = m('^/api/runs/(\\d+)/kill$'))) return send(res, 200, { ok: runner.killRun(Number(mm[1]), 'stopped by owner') });

  if (req.method === 'GET' && !isApi) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = path.normalize(path.join(PUBLIC, rel));
    const target = file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUBLIC, 'index.html');
    return send(res, 200, fs.readFileSync(target), MIME[path.extname(target)] || 'application/octet-stream',
      target.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" } : {});
  }
  return send(res, 404, { error: 'not found' });
}

// ---------------- agent listener (unix socket; the only door agents can reach) ----------------
async function agentRoute(req, res) {
  const mm = new URL(req.url, 'http://x').pathname.match(/^\/desk\/([\w-]+)$/);
  if (req.method !== 'POST' || !mm) return send(res, 404, { error: 'not found' });
  const run = store.runByToken((req.headers.authorization || '').replace(/^Bearer\s+/, ''));
  if (!run) return send(res, 401, { error: 'invalid or finished run token' });
  const out = await sched.deskAction(run, mm[1], await readBody(req));
  return send(res, 200, { ok: true, output: out });
}

const handler = (route) => (req, res) => {
  route(req, res).catch((err) => { if (!res.headersSent) send(res, err.status || 500, { error: err.message }); });
};

// ---------------- main ----------------
export function main() {
  const problems = validateConfig();
  if (problems.length) {
    console.error(`SigmaDesk config problems (${config.configFile}):\n - ${problems.join('\n - ')}\nCopy sigmadesk.config.example.json to sigmadesk.config.json and edit it.`);
    process.exit(1);
  }
  store.openDb();
  sched.recoverOrphans();
  for (const host of config.server.hosts) {
    const srv = http.createServer(handler(ownerRoute));
    srv.on('error', (err) => console.error(`listen ${host}:${config.server.port} failed: ${err.message}`));
    srv.listen(config.server.port, host, () => console.log(`SigmaDesk UI on http://${host}:${config.server.port}`));
  }
  try { fs.unlinkSync(config.socketPath); } catch { /* none */ }
  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true });
  const sock = http.createServer(handler(agentRoute));
  sock.listen(config.socketPath, () => fs.chmodSync(config.socketPath, 0o600));

  store.logEvent({ kind: 'system', text: `Desk online for ${config.project.name} (${store.getSettings().paused === 'true' ? 'halted' : 'open'})` });
  github.ensureLabels().catch(() => {});
  setInterval(() => sched.tick(), 15_000);
  if (config.watch.enabled) {
    const loop = async () => {
      try { await watch.pollOnce(); sched.watchDecisions(); } catch (err) { console.error('watch:', err.message); }
    };
    setInterval(loop, config.watch.intervalSeconds * 1000);
    setTimeout(loop, 3000);
  }
  const importIssue = (i) => {
    const t = store.createTicket({ title: i.title, description: i.body || '', status: 'triage', reporter: 'owner', source: 'github', issue_number: i.number });
    store.logEvent({ kind: 'github', ticket_key: t.key, agent_id: 'github', text: `imported issue #${i.number}` });
  };
  setInterval(() => github.poll(importIssue), config.github.pollMinutes * 60_000);
  setTimeout(() => github.poll(importIssue), 10_000);
  setInterval(() => github.flushComments(), 60_000);
  const shutdown = () => { runner.killAll('desk shutdown'); setTimeout(() => process.exit(0), 700); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
