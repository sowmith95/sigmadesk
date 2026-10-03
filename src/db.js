import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { AGENTS } from './team.js';

// Every mutation is announced on this bus; server.js fans it out over SSE.
export const bus = new EventEmitter();
bus.setMaxListeners(200);

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'feature',
  status TEXT NOT NULL DEFAULT 'triage',
  area TEXT,
  complexity TEXT,
  priority TEXT DEFAULT 'P2',
  assignee TEXT,
  reporter TEXT,
  source TEXT DEFAULT 'human',
  parent_key TEXT,
  branch TEXT,
  pr_url TEXT,
  issue_number INTEGER,
  progress INTEGER DEFAULT 0,
  progress_msg TEXT,
  qa_loops INTEGER DEFAULT 0,
  stalls INTEGER DEFAULT 0,
  head_sha TEXT,
  origin_session TEXT,
  active_run INTEGER,
  resume_status TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'idle',
  current_ticket TEXT,
  current_run INTEGER,
  current_kind TEXT,
  meeting TEXT,
  last_action TEXT,
  last_action_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ticket_key TEXT,
  kind TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  pid INTEGER,
  token TEXT,
  session_id TEXT,
  resumed_from TEXT,
  cwd TEXT,
  incident_id INTEGER,
  model TEXT,
  cost_usd REAL DEFAULT 0,
  num_turns INTEGER,
  result_text TEXT,
  started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_id INTEGER,
  agent_id TEXT,
  ticket_key TEXT,
  kind TEXT NOT NULL,
  text TEXT
);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_key, id);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  gh_synced INTEGER DEFAULT 0,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS comments_ticket ON comments(ticket_key, id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE NOT NULL,
  normalized TEXT,
  project TEXT,
  label TEXT,
  source_index INTEGER,
  count INTEGER DEFAULT 0,
  samples TEXT DEFAULT '[]',
  status TEXT DEFAULT 'watching',
  ticket_key TEXT,
  note TEXT,
  attempts INTEGER DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status);
`;

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  migrate();
  const insAgent = db.prepare('INSERT OR IGNORE INTO agents(id) VALUES (?)');
  for (const a of AGENTS) insAgent.run(a.id);
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(settingDefaults())) insSetting.run(k, v);
  return db;
}

// Additive migrations for databases created by older versions.
function migrate() {
  const want = {
    tickets: { stalls: 'INTEGER DEFAULT 0', head_sha: 'TEXT', origin_session: 'TEXT' },
    agents: { current_kind: 'TEXT', meeting: 'TEXT' },
    runs: { resumed_from: 'TEXT', cwd: 'TEXT', incident_id: 'INTEGER' },
  };
  for (const [table, cols] of Object.entries(want)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

export const now = () => new Date().toISOString();
const q = (sql) => db.prepare(sql);

// ---------- settings ----------
// Live knobs the owner can turn from the UI. Seeded from the config file; the DB value wins afterwards.
export function settingDefaults() {
  return {
    paused: 'true', // the desk starts halted: the owner presses Start
    max_concurrent: String(config.limits.maxConcurrent),
    daily_budget_usd: String(config.limits.dailyBudgetUsd),
    pm_enabled: String(config.pm.enabled),
    pm_interval_min: String(config.pm.intervalMinutes),
    max_open_proposals: String(config.pm.maxOpenProposals),
    github_sync: String(config.github.sync),
    open_draft_prs: String(config.github.openDraftPrs),
  };
}

export function getSettings() {
  return Object.fromEntries(q('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
}
export function setSetting(key, value) {
  if (!(key in settingDefaults())) throw Object.assign(new Error(`unknown setting ${key}`), { status: 400 });
  q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  bus.emit('msg', { type: 'settings', data: getSettings() });
}

// ---------- tickets ----------
export function getTicket(key) {
  return q('SELECT * FROM tickets WHERE key=?').get(key) || null;
}
export function listTickets() {
  return q('SELECT * FROM tickets ORDER BY id DESC').all();
}
export function ticketsByStatus(status) {
  return q('SELECT * FROM tickets WHERE status=? ORDER BY CASE priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 WHEN \'P2\' THEN 2 ELSE 3 END, id').all(status);
}

export function createTicket(t) {
  const info = q(`INSERT INTO tickets(title,description,type,status,area,complexity,priority,assignee,reporter,source,parent_key,issue_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(t.title).slice(0, 200), t.description || '', t.type || 'feature', t.status || 'triage',
    t.area || null, t.complexity || null, t.priority || 'P2', t.assignee || null,
    t.reporter || 'human', t.source || 'human', t.parent_key || null, t.issue_number || null,
  );
  const key = `${config.project.ticketPrefix}-${info.lastInsertRowid}`;
  q('UPDATE tickets SET key=? WHERE id=?').run(key, info.lastInsertRowid);
  const ticket = getTicket(key);
  bus.emit('msg', { type: 'ticket', data: ticket });
  logEvent({ ticket_key: key, agent_id: t.reporter, kind: 'created', text: `created “${ticket.title}” → ${ticket.status}` });
  return ticket;
}

const TICKET_FIELDS = new Set(['title', 'description', 'type', 'status', 'area', 'complexity', 'priority', 'assignee',
  'branch', 'pr_url', 'issue_number', 'progress', 'progress_msg', 'qa_loops', 'stalls', 'head_sha', 'origin_session', 'active_run', 'resume_status', 'parent_key']);

export function updateTicket(key, patch) {
  const cols = Object.keys(patch).filter((k) => TICKET_FIELDS.has(k));
  if (!cols.length) return getTicket(key);
  const sql = `UPDATE tickets SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE key=?`;
  q(sql).run(...cols.map((c) => (patch[c] === undefined ? null : patch[c])), now(), key);
  if (patch.status === 'done') {
    for (const inc of q("SELECT id FROM incidents WHERE ticket_key=? AND status='ticketed'").all(key)) updateIncident(inc.id, { status: 'resolved', resolved_at: now() });
  }
  const ticket = getTicket(key);
  bus.emit('msg', { type: 'ticket', data: ticket });
  return ticket;
}

// ---------- comments ----------
export function addComment(ticket_key, author, body) {
  const info = q('INSERT INTO comments(ticket_key,author,body) VALUES (?,?,?)').run(ticket_key, author, redact(body).slice(0, 20000));
  const c = q('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
  bus.emit('msg', { type: 'comment', data: c });
  return c;
}
export function listComments(ticket_key) {
  return q('SELECT * FROM comments WHERE ticket_key=? ORDER BY id').all(ticket_key);
}
export function unsyncedComments() {
  return q(`SELECT c.*, t.issue_number FROM comments c JOIN tickets t ON t.key=c.ticket_key
    WHERE c.gh_synced=0 AND t.issue_number IS NOT NULL AND c.author != 'github' ORDER BY c.id LIMIT 20`).all();
}
export function markCommentSynced(id) {
  q('UPDATE comments SET gh_synced=1 WHERE id=?').run(id);
}

// ---------- events ----------
const SECRET_PATTERNS = [
  /\b(sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,})/g,
  /((?:api[_-]?key|secret|password|passwd|token|dsn)\s*[=:]\s*)(\S{6,})/gi,
  /(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi,
];
export function redact(text) {
  let t = String(text ?? '');
  t = t.replace(SECRET_PATTERNS[0], '[redacted]');
  t = t.replace(SECRET_PATTERNS[1], '$1[redacted]');
  t = t.replace(SECRET_PATTERNS[2], '$1[redacted]$3');
  return t;
}

export function logEvent(e) {
  const info = q('INSERT INTO events(run_id,agent_id,ticket_key,kind,text) VALUES (?,?,?,?,?)').run(
    e.run_id ?? null, e.agent_id ?? null, e.ticket_key ?? null, e.kind, redact(e.text).slice(0, 4000));
  const ev = q('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid);
  bus.emit('msg', { type: 'event', data: ev });
  return ev;
}
export function recentEvents({ ticket_key, agent_id, limit = 200 } = {}) {
  if (ticket_key) return q('SELECT * FROM events WHERE ticket_key=? ORDER BY id DESC LIMIT ?').all(ticket_key, limit).reverse();
  if (agent_id) return q('SELECT * FROM events WHERE agent_id=? ORDER BY id DESC LIMIT ?').all(agent_id, limit).reverse();
  return q('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

// ---------- agents ----------
export function getAgentState(id) {
  return q('SELECT * FROM agents WHERE id=?').get(id);
}
export function listAgentStates() {
  return q('SELECT * FROM agents').all();
}
export function updateAgent(id, patch) {
  const cols = Object.keys(patch);
  q(`UPDATE agents SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  bus.emit('msg', { type: 'agent', data: getAgentState(id) });
}

// ---------- runs ----------
export function createRun(r) {
  const info = q('INSERT INTO runs(agent_id,ticket_key,kind,token,model,cwd,resumed_from,incident_id) VALUES (?,?,?,?,?,?,?,?)').run(
    r.agent_id, r.ticket_key ?? null, r.kind, r.token, r.model, r.cwd ?? null, r.resumed_from ?? null, r.incident_id ?? null);
  const run = getRun(info.lastInsertRowid);
  bus.emit('msg', { type: 'run', data: run });
  return run;
}
export function getRun(id) {
  return q('SELECT * FROM runs WHERE id=?').get(id) || null;
}
export function runByToken(token) {
  return token ? q("SELECT * FROM runs WHERE token=? AND status='running'").get(token) || null : null;
}
export function updateRun(id, patch) {
  const cols = Object.keys(patch);
  q(`UPDATE runs SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  bus.emit('msg', { type: 'run', data: getRun(id) });
}
export function runningRuns() {
  return q("SELECT * FROM runs WHERE status='running'").all();
}
export function recentRuns(limit = 50) {
  return q('SELECT id,agent_id,ticket_key,kind,status,model,cost_usd,num_turns,started_at,ended_at FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}
export function spendSince(isoTs) {
  return q('SELECT COALESCE(SUM(cost_usd),0) AS s FROM runs WHERE started_at >= ?').get(isoTs).s;
}
export function spendByAgentSince(isoTs) {
  return Object.fromEntries(q('SELECT agent_id, SUM(cost_usd) AS s FROM runs WHERE started_at >= ? GROUP BY agent_id').all(isoTs).map((r) => [r.agent_id, r.s]));
}
export function lastRunFor(ticketKey, agentId, kind) {
  return q('SELECT * FROM runs WHERE ticket_key=? AND agent_id=? AND kind=? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(ticketKey, agentId, kind) || null;
}
export function runBySession(sessionId) {
  return q('SELECT * FROM runs WHERE session_id=? ORDER BY id DESC LIMIT 1').get(sessionId) || null;
}

// A seat's scorecard: what it shipped, how often QA passed it first time, and what it cost.
export function agentStats(agentId) {
  const shipped = q("SELECT COUNT(*) n FROM tickets WHERE assignee=? AND status IN ('review','ready_for_human','done')").get(agentId).n;
  const merged = q("SELECT COUNT(*) n FROM tickets WHERE assignee=? AND status='done'").get(agentId).n;
  const firstPass = q("SELECT COUNT(*) n FROM tickets WHERE assignee=? AND status IN ('review','ready_for_human','done') AND qa_loops=0").get(agentId).n;
  const runs = q('SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END),0) ok FROM runs WHERE agent_id=?').get(agentId);
  const week = q("SELECT COALESCE(SUM(cost_usd),0) c FROM runs WHERE agent_id=? AND started_at >= ?").get(agentId, new Date(Date.now() - 7 * 864e5).toISOString()).c;
  const byKind = q('SELECT kind, COUNT(*) n FROM runs WHERE agent_id=? GROUP BY kind').all(agentId);
  const proposed = q("SELECT COUNT(*) n FROM tickets WHERE reporter=?").get(agentId).n;
  return { shipped, merged, first_pass_rate: shipped ? firstPass / shipped : null, runs: runs.n, run_success_rate: runs.n ? runs.ok / runs.n : null,
    cost_total: runs.cost, cost_7d: week, cost_per_shipped: shipped ? runs.cost / shipped : null, by_kind: byKind, reported: proposed };
}

export function runCountFor(ticketKey, kind) {
  return q('SELECT COUNT(*) AS n FROM runs WHERE ticket_key=? AND kind=?').get(ticketKey, kind).n;
}
export function lastRunOfKind(kind) {
  return q('SELECT * FROM runs WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind) || null;
}

// ---------- incidents (watch desk) ----------
const INCIDENT_FIELDS = new Set(['status', 'ticket_key', 'note', 'attempts', 'resolved_at', 'project']);
export function recordIncident({ signature, normalized, source_index, label, project, line, ts }) {
  const cur = q('SELECT * FROM incidents WHERE signature=?').get(signature);
  if (!cur) {
    q('INSERT INTO incidents(signature,normalized,project,label,source_index,count,samples,first_seen,last_seen) VALUES (?,?,?,?,?,1,?,?,?)')
      .run(signature, normalized, project, label, source_index, JSON.stringify([{ ts, line }]), ts, ts);
  } else {
    const samples = JSON.parse(cur.samples || '[]');
    samples.push({ ts, line });
    q('UPDATE incidents SET count=count+1, last_seen=?, samples=? WHERE id=?').run(ts, JSON.stringify(samples.slice(-5)), cur.id);
  }
  const inc = q('SELECT * FROM incidents WHERE signature=?').get(signature);
  // Throttle the live stream: announce early occurrences and every 10th after.
  if (inc.count <= 5 || inc.count % 10 === 0) bus.emit('msg', { type: 'incident', data: inc });
  return inc;
}
export function getIncident(id) {
  return q('SELECT * FROM incidents WHERE id=?').get(id) || null;
}
export function listIncidents({ status, limit = 200 } = {}) {
  return status
    ? q('SELECT * FROM incidents WHERE status=? ORDER BY last_seen DESC LIMIT ?').all(status, limit)
    : q('SELECT * FROM incidents ORDER BY last_seen DESC LIMIT ?').all(limit);
}
export function updateIncident(id, patch) {
  const cols = Object.keys(patch).filter((k) => INCIDENT_FIELDS.has(k));
  if (!cols.length) return getIncident(id);
  q(`UPDATE incidents SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const inc = getIncident(id);
  bus.emit('msg', { type: 'incident', data: inc });
  return inc;
}
export function investigationsSince(isoTs) {
  return q("SELECT COUNT(*) n FROM runs WHERE kind='investigate' AND started_at >= ?").get(isoTs).n;
}
