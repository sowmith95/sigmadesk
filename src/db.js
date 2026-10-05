import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { AGENTS } from './team.js';
import { scrubValues } from './secrets.js';

// Every mutation is announced on this bus; server.js fans it out over SSE.
export const bus = new EventEmitter();
bus.setMaxListeners(200);

let db;
let transactionMessages = null;
function announce(message) {
  if (transactionMessages) transactionMessages.push(message);
  else bus.emit('msg', message);
}

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
  after_key TEXT,
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
  nonce TEXT,
  cost_estimated INTEGER DEFAULT 0,
  reserve_usd REAL DEFAULT 0,
  usage_json TEXT,
  provenance TEXT,
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
CREATE TABLE IF NOT EXISTS architecture_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT,
  reviewer TEXT NOT NULL,
  challenger TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_result',
  brief TEXT NOT NULL,
  result TEXT,
  error TEXT,
  run_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS owner_discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  response TEXT,
  error TEXT,
  run_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS councils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  input_hash TEXT NOT NULL,
  brief TEXT NOT NULL,
  question TEXT NOT NULL,
  chair TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'parallel',
  challenge INTEGER DEFAULT 0,
  result TEXT,
  error TEXT,
  decision TEXT,
  decision_note TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS council_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  council_id INTEGER NOT NULL REFERENCES councils(id),
  stage TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  model TEXT NOT NULL,
  family TEXT NOT NULL,
  lens TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reserve_usd REAL NOT NULL,
  run_id INTEGER,
  result TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(council_id,stage,ordinal)
);
CREATE INDEX IF NOT EXISTS councils_status ON councils(status);
CREATE TABLE IF NOT EXISTS pr_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  seat TEXT NOT NULL,
  role TEXT NOT NULL,
  sha TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'pending',
  state TEXT NOT NULL DEFAULT 'active',
  body TEXT,
  checked TEXT,
  risks TEXT,
  findings_json TEXT DEFAULT '[]',
  nonce TEXT,
  run_id INTEGER,
  published_comment_id TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS pr_reviews_ticket ON pr_reviews(ticket_key, id);
CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  review_id INTEGER NOT NULL,
  ticket_key TEXT NOT NULL,
  seat TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  problem TEXT NOT NULL,
  why TEXT,
  fix TEXT,
  blocking INTEGER NOT NULL DEFAULT 1,
  response TEXT,
  response_body TEXT,
  response_sha TEXT,
  resolution TEXT NOT NULL DEFAULT 'open',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS review_findings_ticket ON review_findings(ticket_key);
CREATE TABLE IF NOT EXISTS pr_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  marker TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  review_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  gh_comment_id TEXT,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS pr_outbox_status ON pr_outbox(status, id);
CREATE TABLE IF NOT EXISTS conflict_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  pr_number INTEGER,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  seat TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  files_json TEXT DEFAULT '[]',
  incoming_json TEXT DEFAULT '[]',
  note TEXT,
  run_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_sha TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(ticket_key, base_sha, head_sha)
);
CREATE INDEX IF NOT EXISTS conflict_jobs_status ON conflict_jobs(status, id);
CREATE TABLE IF NOT EXISTS research_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  verdict TEXT,
  report TEXT,
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS research_reviews_ticket ON research_reviews(ticket_key, generation);
CREATE TABLE IF NOT EXISTS connectors (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'proposed',
  purpose TEXT DEFAULT '',
  case_md TEXT DEFAULT '',
  binding TEXT,
  tools TEXT DEFAULT '[]',
  proposed_by TEXT,
  assessed_by TEXT,
  assessment TEXT,
  assessment_run INTEGER,
  approved_by TEXT,
  approved_at TEXT,
  review_after TEXT,
  decision_note TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every QA verdict as a fact: who built the change, on which model, what failed and why (report cards, assignment).
CREATE TABLE IF NOT EXISTS qa_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  run_id INTEGER,
  sha TEXT,
  verdict TEXT NOT NULL,          -- pass | fail
  reason TEXT,                    -- fail: bug | tests | spec | base | flaky | unknown (history)
  lesson_id INTEGER,              -- fail that repeats an active lesson
  builder TEXT,
  model TEXT,
  complexity TEXT,
  area TEXT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS qa_verdicts_ticket ON qa_verdicts(ticket_key, id);
-- Team lessons: a builder proposes one after a setback, the owner approves it, build prompts carry it.
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT,                      -- null: every area
  text TEXT NOT NULL,
  source_ticket TEXT,
  proposed_by TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | active | rejected | retired
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS lesson_exposures (
  run_id INTEGER NOT NULL,
  lesson_id INTEGER NOT NULL,
  ticket_key TEXT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, lesson_id)
);
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

// QA verdicts before the qa_verdicts table existed: rebuilt once from the QA seat's events, reason unknown.
// Also after a rollback to a version without the table: events newer than the last recorded verdict (with a minute of
// slack, since the live path logs its event a moment after the row) are rebuilt; older ones are never touched twice.
export function backfillQaVerdicts() {
  const last = db.prepare('SELECT MAX(ts) ts FROM qa_verdicts').get()?.ts;
  const after = last ? new Date(Date.parse(last) + 60_000).toISOString() : '';
  const rows = db.prepare(`SELECT e.ticket_key, e.text, e.run_id, e.ts, t.builder, t.complexity, t.area FROM events e LEFT JOIN tickets t ON t.key = e.ticket_key
    WHERE e.kind = 'action' AND e.agent_id = 'qa' AND (e.text LIKE 'QA passed %' OR e.text LIKE 'QA failed %') AND e.ticket_key IS NOT NULL AND e.ts > ? ORDER BY e.id`).all(after);
  const firstBuild = db.prepare("SELECT agent_id, model FROM runs WHERE ticket_key = ? AND kind IN ('implement','respond','resolve') AND started_at <= ? ORDER BY id DESC LIMIT 1");
  const ins = db.prepare('INSERT INTO qa_verdicts(ticket_key, run_id, verdict, reason, builder, model, complexity, area, ts) VALUES (?,?,?,?,?,?,?,?,?)');
  if (!rows.length) return;
  db.exec('BEGIN IMMEDIATE'); // all or nothing: a half-done rebuild would hide the rest of the history for good
  try {
  for (const r of rows) {
    const b = firstBuild.get(r.ticket_key, r.ts);
    const pass = /^QA passed/.test(r.text);
    ins.run(r.ticket_key, r.run_id ?? null, pass ? 'pass' : 'fail', pass ? null : 'unknown', r.builder || b?.agent_id || null, b?.model || null, r.complexity ?? null, r.area ?? null, r.ts);
  }
  db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// Additive migrations for databases created by older versions.
function migrate() {
  const want = {
    tickets: { stalls: 'INTEGER DEFAULT 0', head_sha: 'TEXT', origin_session: 'TEXT', after_key: 'TEXT',
      // two-reviewer PRs: stored risk (groom/parent), diff classifier result, who designed/sliced it, frozen reviewers
      risk: 'TEXT', diff_risk: 'TEXT', designer: 'TEXT', qa_sha: 'TEXT', review_round: 'INTEGER DEFAULT 0', review_stage: 'TEXT',
      reviewer_context: 'TEXT', reviewer_independent: 'TEXT',
      // merge train (#3): original builder, approval time (queue order), scheduled/held merges, light re-confirm reviews
      builder: 'TEXT', contributors: "TEXT DEFAULT '[]'", approved_at: 'TEXT', merge_after: 'TEXT', merge_hold: 'TEXT', reconfirm_from: 'TEXT', reconfirm_kind: 'TEXT', reconfirm_base: 'TEXT',
      // research programs: which program/run proposed it, the frozen review policy, the second-person review state
      research_program: 'TEXT', research_run: 'INTEGER', research_policy: 'TEXT', research_review: 'TEXT', research_generation: 'INTEGER DEFAULT 0',
      research_revisions: 'INTEGER DEFAULT 0', research_sources: 'TEXT',
      // a task only the owner can do (access no seat has): never dispatched to a seat
      owner_task: 'INTEGER DEFAULT 0',
      // assignment: pinned to one seat (explicit --assign / owner edit), and why the desk picked the seat it did
      assign_pinned: 'INTEGER DEFAULT 0', assign_reason: 'TEXT',
      // the owner set this priority: grooming, epic reviews and the program manager leave it alone
      priority_pinned: 'INTEGER DEFAULT 0' },
    agents: { current_kind: 'TEXT', meeting: 'TEXT' },
    owner_discussions: { attempts: 'INTEGER DEFAULT 0' },
    pr_outbox: { next_attempt_at: 'TEXT' },
    runs: { resumed_from: 'TEXT', cwd: 'TEXT', incident_id: 'INTEGER', nonce: 'TEXT', cost_estimated: 'INTEGER DEFAULT 0', provenance: 'TEXT', reserve_usd: 'REAL DEFAULT 0', usage_json: 'TEXT',
      thread_id: 'TEXT', context_hash: 'TEXT', context_meta: 'TEXT', job_hash: 'TEXT',
      // research programs: the program a run belongs to and its server-owned job metadata (allowances, connectors)
      program: 'TEXT', job: 'TEXT' },
  };
  for (const [table, cols] of Object.entries(want)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  backfillQaVerdicts();
}

export const now = () => new Date().toISOString();
// ---------------- QA verdicts and lessons ----------------
export const QA_REASONS = ['bug', 'tests', 'spec', 'base', 'flaky'];
export function recordQaVerdict(v) {
  return db.prepare('INSERT INTO qa_verdicts(ticket_key, run_id, sha, verdict, reason, lesson_id, builder, model, complexity, area) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(v.ticket_key, v.run_id ?? null, v.sha ?? null, v.verdict, v.reason ?? null, v.lesson_id ?? null, v.builder ?? null, v.model ?? null, v.complexity ?? null, v.area ?? null);
}
/** The run that produced what QA judged: the builder's latest implement/respond run on the ticket. */
/** Tickets linked to an incident that is still open (never snoozable in the Inbox). */
export const openIncidentTickets = () => db.prepare("SELECT DISTINCT ticket_key FROM incidents WHERE ticket_key IS NOT NULL AND status IN ('watching','investigating','paged','ticketed')").all().map((r) => r.ticket_key);
export const lastBuildRun = (ticketKey, agentId) => db.prepare("SELECT * FROM runs WHERE ticket_key = ? AND agent_id = ? AND kind IN ('implement','respond','resolve') ORDER BY id DESC LIMIT 1").get(ticketKey, agentId) || null;
export const qaVerdicts = (ticketKey) => db.prepare('SELECT * FROM qa_verdicts WHERE ticket_key = ? ORDER BY id').all(ticketKey);
export const getLesson = (id) => db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) || null;
export function listLessons() {
  // A repeat counts only on a task whose build actually carried the lesson.
  return db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM qa_verdicts v WHERE v.lesson_id = l.id
      AND EXISTS (SELECT 1 FROM lesson_exposures x WHERE x.lesson_id = l.id AND x.ticket_key = v.ticket_key)) repeats,
    (SELECT COUNT(DISTINCT ticket_key) FROM lesson_exposures x WHERE x.lesson_id = l.id) tasks FROM lessons l ORDER BY l.id DESC`).all();
}
export function insertLesson(l) {
  const r = db.prepare('INSERT INTO lessons(area, text, source_ticket, proposed_by) VALUES (?,?,?,?)').run(l.area ?? null, l.text, l.source_ticket ?? null, l.proposed_by ?? null);
  return getLesson(Number(r.lastInsertRowid));
}
export function updateLesson(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['area', 'text', 'status', 'decided_by', 'decided_at', 'note'].includes(k));
  if (cols.length) db.prepare(`UPDATE lessons SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => patch[c]), now(), id);
  return getLesson(id);
}
export const exposedLessons = (ticketKey) => new Set(db.prepare('SELECT DISTINCT lesson_id FROM lesson_exposures WHERE ticket_key = ?').all(ticketKey).map((r) => r.lesson_id));
export function recordExposures(runId, ticketKey, ids) {
  const ins = db.prepare('INSERT OR IGNORE INTO lesson_exposures(run_id, lesson_id, ticket_key) VALUES (?,?,?)');
  for (const id of ids) ins.run(runId, id, ticketKey ?? null);
}

/** Raw facts for team stats (src/team-stats.js): build runs since a date, every ticket's outcome, first merge per ticket. */
export function assignmentFacts(since) {
  return {
    // Every run of each task touched in the window (a task's early runs count toward its cost and cycle time), plus
    // the window's own runs for busy time.
    runs: db.prepare(`SELECT agent_id, ticket_key, kind, status, model, cost_usd, cost_estimated, started_at, ended_at FROM runs WHERE agent_id IS NOT NULL
      AND (started_at >= ? OR ticket_key IN (SELECT DISTINCT ticket_key FROM runs WHERE started_at >= ? AND ticket_key IS NOT NULL))`).all(since, since),
    tickets: db.prepare(`SELECT key, status, builder, assignee, parent_key, area, complexity, risk, owner_task FROM tickets`).all(),
    // The first QA verdict per ticket, as recorded by the QA seat ("QA passed KEY" / "QA failed KEY").
    // The first QA verdict per ticket (structured: reason, who built it and on which model).
    qa: db.prepare(`SELECT v.* FROM qa_verdicts v JOIN (SELECT ticket_key, MIN(id) id FROM qa_verdicts GROUP BY ticket_key) f ON v.id = f.id`).all(),
    // A merge: on GitHub (PR sync), from the PR console, or by the merge train. A done ticket with a PR and no merge
    // event (older history) counts as shipped when it last changed.
    merged: db.prepare(`SELECT ticket_key, MIN(ts) ts FROM events WHERE ticket_key IS NOT NULL AND kind = 'github'
      AND (text LIKE 'PR merged%' OR text LIKE '🔀 Merged #%' OR text LIKE 'auto-merged #%') GROUP BY ticket_key
      UNION ALL SELECT key, updated_at FROM tickets t WHERE status = 'done' AND pr_url IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.ticket_key = t.key AND e.kind = 'github' AND (e.text LIKE 'PR merged%' OR e.text LIKE '🔀 Merged #%' OR e.text LIKE 'auto-merged #%'))`).all(),
  };
}
const q = (sql) => db.prepare(sql);
export function transaction(fn) {
  if (transactionMessages) return fn(); // nested: part of the enclosing transaction (commits or rolls back with it)
  db.exec('BEGIN IMMEDIATE');
  transactionMessages = [];
  let result, messages;
  try { result = fn(); db.exec('COMMIT'); messages = transactionMessages; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
  finally { transactionMessages = null; }
  for (const message of messages) announce(message);
  return result;
}

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
    open_draft_prs: String(config.github.openDraftPrs), // open PRs at all (name kept for existing databases)
    draft_prs: String(config.github.draftPrs ?? false), // open them as drafts (default: normal open PRs)
    team: '{}', // per-seat {engine, model, effort, enabled} chosen in the UI
    team_confirmed: String(config.bootstrap?.teamConfirmed === true), // the owner confirms who runs on what before the first open (the setup wizard records it)
    auto_fallback: String(config.engines.autoFallback),
    // Which engine the Engineering Manager grooms on: 'codex' (default) or 'seat' (the manager seat's own engine).
    groom_engine: 'codex',
    // How todo work finds a seat: 'balanced' (any idle seat that fits, scored by track record) or 'fixed' (one seat by rule).
    assign_mode: 'balanced',
    // '' = not configured: research programs derive from config.research + the legacy pm_* rows. Saved JSON wins.
    research_programs: '',
  };
}

export function getSettings() {
  return Object.fromEntries(q('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
}
export function setSetting(key, value) {
  if (!(key in settingDefaults())) throw Object.assign(new Error(`unknown setting ${key}`), { status: 400 });
  if (key === 'research_programs') throw Object.assign(new Error('research programs are edited through Settings → Research (validated as a whole)'), { status: 400 });
  const ranges = { max_concurrent: [1, 20], daily_budget_usd: [0, 100000], pm_interval_min: [1, 525600], max_open_proposals: [1, 100] };
  if (ranges[key]) {
    const n = Number(value), [min, max] = ranges[key];
    if (!String(value).trim() || !Number.isFinite(n) || n < min || n > max || (key !== 'daily_budget_usd' && !Number.isInteger(n)))
      throw Object.assign(new Error(`${key} must be ${key === 'daily_budget_usd' ? 'a number' : 'an integer'} from ${min} to ${max}`), { status: 400 });
  }
  if (key === 'assign_mode' && !['balanced', 'fixed'].includes(String(value))) throw Object.assign(new Error('assign_mode must be balanced or fixed'), { status: 400 });
  if (key === 'groom_engine' && !['codex', 'seat'].includes(String(value))) throw Object.assign(new Error('groom_engine must be codex or seat'), { status: 400 });
  if (['paused', 'pm_enabled', 'github_sync', 'open_draft_prs', 'draft_prs', 'team_confirmed', 'auto_fallback'].includes(key) && !['true', 'false'].includes(String(value)))
    throw Object.assign(new Error(`${key} must be true or false`), { status: 400 });
  writeSetting(key, value);
}
// For modules that validated a structured setting themselves (research programs). Not reachable from /api/settings.
export function writeSetting(key, value) {
  q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  announce({ type: 'settings', data: getSettings() });
}

// ---------- tickets ----------
export function getTicket(key) {
  return q('SELECT * FROM tickets WHERE key=?').get(key) || null;
}
export function childrenOf(key) {
  return q('SELECT * FROM tickets WHERE parent_key=? ORDER BY id').all(key);
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
  announce({ type: 'ticket', data: ticket });
  logEvent({ ticket_key: key, agent_id: t.reporter, kind: 'created', text: `created “${ticket.title}” → ${ticket.status}` });
  return ticket;
}

const TICKET_FIELDS = new Set(['owner_task', 'assign_pinned', 'assign_reason', 'priority_pinned', 'title', 'description', 'type', 'status', 'area', 'complexity', 'priority', 'assignee',
  'branch', 'pr_url', 'issue_number', 'progress', 'progress_msg', 'qa_loops', 'stalls', 'head_sha', 'origin_session', 'after_key', 'active_run', 'resume_status', 'parent_key',
  'risk', 'diff_risk', 'designer', 'qa_sha', 'review_round', 'review_stage', 'reviewer_context', 'reviewer_independent',
  'builder', 'contributors', 'approved_at', 'merge_after', 'merge_hold', 'reconfirm_from', 'reconfirm_kind', 'reconfirm_base',
  'research_program', 'research_run', 'research_policy', 'research_review', 'research_generation', 'research_revisions', 'research_sources']);

export function updateTicket(key, patch) {
  const cols = Object.keys(patch).filter((k) => TICKET_FIELDS.has(k));
  if (!cols.length) return getTicket(key);
  const sql = `UPDATE tickets SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE key=?`;
  q(sql).run(...cols.map((c) => (patch[c] === undefined ? null : patch[c])), now(), key);
  if (patch.status === 'done') {
    for (const inc of q("SELECT id FROM incidents WHERE ticket_key=? AND status='ticketed'").all(key)) updateIncident(inc.id, { status: 'resolved', resolved_at: now() });
  }
  const ticket = getTicket(key);
  announce({ type: 'ticket', data: ticket });
  return ticket;
}

// ---------- comments ----------
export function addComment(ticket_key, author, body) {
  const info = q('INSERT INTO comments(ticket_key,author,body) VALUES (?,?,?)').run(ticket_key, author, redact(body).slice(0, 20000));
  const c = q('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
  announce({ type: 'comment', data: c });
  return c;
}
export function listComments(ticket_key) {
  return q('SELECT * FROM comments WHERE ticket_key=? ORDER BY id').all(ticket_key);
}
export function unsyncedComments() {
  return q(`SELECT c.*, t.issue_number FROM comments c JOIN tickets t ON t.key=c.ticket_key
    WHERE c.gh_synced=0 AND t.issue_number IS NOT NULL AND c.author NOT IN ('github','council') ORDER BY c.id LIMIT 20`).all();
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
  t = t.replace(/\b[0-9a-f]{36}\b/g, '[redacted]'); // desk run tokens
  // NAME=value / NAME: value where NAME looks like a credential (APCA_API_SECRET_KEY, POLYGON_API_KEY, *_TOKEN, …)
  t = t.replace(/\b([A-Za-z][A-Za-z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|DSN|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)(['"]?)([^\s'"]{4,})/gi, '$1$2[redacted]');
  t = t.replace(/\b((?:APCA|ALPACA|POLYGON|MASSIVE|IBKR)_[A-Z0-9_]*\s*[=:]\s*)(['"]?)([^\s'"]{4,})/g, '$1$2[redacted]');
  t = t.replace(/\b(?:PK|AK|CK)[A-Z0-9]{16,}\b/g, '[redacted]'); // Alpaca key ids
  return t;
}
/** For anything posted to GitHub: pattern redaction plus the configured secret values from the target repo's .env. */
export const sanitizeForGithub = (text) => redact(scrubValues(text));

export function logEvent(e) {
  const info = q('INSERT INTO events(run_id,agent_id,ticket_key,kind,text) VALUES (?,?,?,?,?)').run(
    e.run_id ?? null, e.agent_id ?? null, e.ticket_key ?? null, e.kind, redact(e.text).slice(0, 4000));
  const ev = q('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid);
  announce({ type: 'event', data: ev });
  return ev;
}
// Redact string values before serialization: regex replacement on JSON can consume closing quotes.
export const redactValue = (v) => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactValue)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)])) : v;
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
  announce({ type: 'agent', data: getAgentState(id) });
}

// ---------- runs ----------
const publicRun = (r) => { if (!r) return r; const { token, nonce, ...rest } = r; return rest; };
export function createRun(r) {
  const info = q('INSERT INTO runs(agent_id,ticket_key,kind,token,model,cwd,resumed_from,incident_id,nonce,provenance,program,job) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    r.agent_id, r.ticket_key ?? null, r.kind, r.token, r.model, r.cwd ?? null, r.resumed_from ?? null, r.incident_id ?? null, r.nonce ?? null, r.provenance ?? null,
    r.program ?? null, r.job ? JSON.stringify(r.job) : null);
  const run = getRun(info.lastInsertRowid);
  announce({ type: 'run', data: publicRun(run) });
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
  announce({ type: 'run', data: publicRun(getRun(id)) });
}
export function unfinishedRuns() {
  return q('SELECT * FROM runs WHERE ended_at IS NULL').all();
}
export function runningRuns() {
  return q("SELECT * FROM runs WHERE status='running'").all();
}
export function recentRuns(limit = 50) {
  return q('SELECT id,agent_id,ticket_key,kind,status,model,cost_usd,cost_estimated,reserve_usd,usage_json,num_turns,started_at,ended_at FROM runs ORDER BY id DESC LIMIT ?').all(limit);
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
// The latest unfinished attempt of the same Perplexity job (job, task, seat contract and pack — see context.jobIdentity):
// a retry resumes polling its thread instead of asking again.
export function lastThreadRun({ job_hash }) {
  if (!job_hash) return null;
  return q("SELECT * FROM runs WHERE job_hash=? AND thread_id IS NOT NULL AND ended_at IS NOT NULL AND status!='success' ORDER BY id DESC LIMIT 1").get(job_hash) || null;
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
  const closedUnmerged = q("SELECT COUNT(*) n FROM tickets WHERE assignee=? AND status='wontdo' AND pr_url IS NOT NULL").get(agentId).n;
  const versions = q('SELECT provenance, COUNT(*) n, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) ok, SUM(cost_usd) cost FROM runs WHERE agent_id=? AND provenance IS NOT NULL GROUP BY provenance ORDER BY MAX(id) DESC LIMIT 5').all(agentId);
  const week = q("SELECT COALESCE(SUM(cost_usd),0) c FROM runs WHERE agent_id=? AND started_at >= ?").get(agentId, new Date(Date.now() - 7 * 864e5).toISOString()).c;
  const byKind = q('SELECT kind, COUNT(*) n FROM runs WHERE agent_id=? GROUP BY kind').all(agentId);
  const proposed = q("SELECT COUNT(*) n FROM tickets WHERE reporter=?").get(agentId).n;
  return { shipped, merged, first_pass_rate: shipped ? firstPass / shipped : null, runs: runs.n, run_success_rate: runs.n ? runs.ok / runs.n : null,
    cost_total: runs.cost, cost_7d: week, cost_per_shipped: shipped ? runs.cost / shipped : null, by_kind: byKind, reported: proposed,
    // desk P&L: outcomes, not output
    merge_rate: merged + closedUnmerged ? merged / (merged + closedUnmerged) : null, closed_unmerged: closedUnmerged,
    cost_per_merged: merged ? runs.cost / merged : null, versions };
}

export function runCountFor(ticketKey, kind) {
  return q('SELECT COUNT(*) AS n FROM runs WHERE ticket_key=? AND kind=?').get(ticketKey, kind).n;
}
export function lastRunOfKind(kind) {
  return q('SELECT * FROM runs WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind) || null;
}
// Research cadence: the program's own runs; the default program also counts untagged legacy PM research runs.
export function lastResearchRun(programId, { untagged = false } = {}) {
  return (untagged
    ? q("SELECT * FROM runs WHERE kind='research' AND (program=? OR program IS NULL) ORDER BY id DESC LIMIT 1").get(programId)
    : q("SELECT * FROM runs WHERE kind='research' AND program=? ORDER BY id DESC LIMIT 1").get(programId)) || null;
}
export function runsOfProgram(programId, limit = 50) {
  return q('SELECT * FROM runs WHERE program=? ORDER BY id DESC LIMIT ?').all(programId, limit).map(publicRun);
}
export function runsUsingConnector(name) {
  return q("SELECT * FROM runs WHERE job IS NOT NULL AND instr(job, ?) > 0 ORDER BY id DESC").all(`"${name}"`).map(publicRun);
}
export function ticketsFromRuns(runIds) {
  if (!runIds.length) return [];
  return q(`SELECT * FROM tickets WHERE research_run IN (${runIds.map(() => '?').join(',')})`).all(...runIds);
}

// ---------- research reviews (second-person gate on research proposals) ----------
const RR_FIELDS = new Set(['run_id', 'status', 'verdict', 'report', 'error', 'ended_at']);
export function createResearchReview(r) {
  const info = q('INSERT INTO research_reviews(ticket_key,generation,input_hash,reviewer,status) VALUES (?,?,?,?,?)').run(r.ticket_key, r.generation, r.input_hash, r.reviewer, r.status || 'pending');
  const row = getResearchReview(info.lastInsertRowid);
  announce({ type: 'research-review', data: row });
  return row;
}
export function getResearchReview(id) { return q('SELECT * FROM research_reviews WHERE id=?').get(id) || null; }
export function updateResearchReview(id, patch) {
  const cols = Object.keys(patch).filter((k) => RR_FIELDS.has(k));
  if (cols.length) q(`UPDATE research_reviews SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const row = getResearchReview(id);
  announce({ type: 'research-review', data: row });
  return row;
}
export function listResearchReviews(ticketKey) { return q('SELECT * FROM research_reviews WHERE ticket_key=? ORDER BY id').all(ticketKey); }
export function openResearchReviews() { return q("SELECT * FROM research_reviews WHERE status IN ('pending','running') ORDER BY id").all(); }

// ---------- connectors (governed MCP servers for research seats) ----------
const CONNECTOR_FIELDS = new Set(['status', 'purpose', 'case_md', 'binding', 'tools', 'proposed_by', 'assessed_by', 'assessment', 'assessment_run', 'approved_by', 'approved_at', 'review_after', 'decision_note']);
export function getConnector(name) { return q('SELECT * FROM connectors WHERE name=?').get(name) || null; }
export function listConnectors() { return q('SELECT * FROM connectors ORDER BY name').all(); }
export function createConnector(c) {
  q('INSERT INTO connectors(name,status,purpose,case_md,binding,tools,proposed_by) VALUES (?,?,?,?,?,?,?)').run(c.name, c.status || 'proposed', c.purpose || '', c.case_md || '', c.binding ? JSON.stringify(c.binding) : null, JSON.stringify(c.tools || []), c.proposed_by || 'owner');
  const row = getConnector(c.name);
  announce({ type: 'connector', data: row });
  return row;
}
export function updateConnector(name, patch) {
  const cols = Object.keys(patch).filter((k) => CONNECTOR_FIELDS.has(k));
  if (cols.length) q(`UPDATE connectors SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE name=?`).run(...cols.map((c) => (patch[c] !== null && typeof patch[c] === 'object' ? JSON.stringify(patch[c]) : patch[c] ?? null)), now(), name);
  const row = getConnector(name);
  announce({ type: 'connector', data: row });
  return row;
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
  if (inc.count <= 5 || inc.count % 10 === 0) announce({ type: 'incident', data: inc });
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
  announce({ type: 'incident', data: inc });
  return inc;
}
export function investigationsSince(isoTs) {
  return q("SELECT COUNT(*) n FROM runs WHERE kind='investigate' AND started_at >= ?").get(isoTs).n;
}

// Advisory reports are attached to the ticket; they never count as a QA verdict.
export function createArchitectureReview(r) {
  const info = q('INSERT INTO architecture_reviews(ticket_key,reviewer,challenger,brief,status) VALUES(?,?,?,?,?)').run(r.ticket_key, r.reviewer, r.challenger || null, r.brief, r.status || 'awaiting_result');
  const review = getArchitectureReview(info.lastInsertRowid);
  announce({ type: 'architecture-review', data: review });
  return review;
}
export const getArchitectureReview = (id) => q('SELECT * FROM architecture_reviews WHERE id=?').get(id) || null;
export const listArchitectureReviews = (key) => key ? q('SELECT * FROM architecture_reviews WHERE ticket_key=? ORDER BY id DESC LIMIT 30').all(key) : q('SELECT * FROM architecture_reviews ORDER BY id DESC LIMIT 30').all();
export function updateArchitectureReview(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status', 'result', 'error', 'run_id', 'ended_at'].includes(k));
  if (cols.length) q(`UPDATE architecture_reviews SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const review = getArchitectureReview(id);
  announce({ type: 'architecture-review', data: review });
  return review;
}

export const councilMembers = (id) => q('SELECT * FROM council_members WHERE council_id=? ORDER BY id').all(id);
export function getCouncil(id) {
  const c = q('SELECT * FROM councils WHERE id=?').get(id);
  return c ? { ...c, members: councilMembers(id) } : null;
}
export const listCouncils = (key) => (key
  ? q('SELECT id FROM councils WHERE ticket_key=? ORDER BY id DESC LIMIT 30').all(key)
  : q('SELECT id FROM councils ORDER BY id DESC LIMIT 30').all()).map((c) => getCouncil(c.id));
export const pendingCouncils = () => q("SELECT id FROM councils WHERE status IN ('queued','running') ORDER BY id").all().map((c) => getCouncil(c.id));
export function createCouncil(c, members) {
  return transaction(() => {
    const info = q('INSERT INTO councils(ticket_key,input_hash,brief,question,chair,strategy,challenge) VALUES(?,?,?,?,?,?,?)')
      .run(c.ticket_key, c.input_hash, c.brief, c.question, c.chair, c.strategy, c.challenge ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    for (const m of members) q('INSERT INTO council_members(council_id,stage,ordinal,model,family,lens,reserve_usd) VALUES(?,?,?,?,?,?,?)')
      .run(id, m.stage, m.ordinal, m.model, m.family, m.lens, m.reserve_usd);
    const result = getCouncil(id); announce({ type: 'council', data: result }); return result;
  });
}
export function updateCouncil(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status','result','error','decision','decision_note','ended_at'].includes(k));
  if (cols.length) q(`UPDATE councils SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const c = getCouncil(id); announce({ type: 'council', data: c }); return c;
}
export function updateCouncilMember(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status','run_id','result','error','started_at','ended_at'].includes(k));
  if (cols.length) q(`UPDATE council_members SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const m = q('SELECT * FROM council_members WHERE id=?').get(id);
  announce({ type: 'council', data: getCouncil(m.council_id) }); return m;
}

// ---------- two-reviewer PR reviews (authoritative; GitHub comments are a mirror) ----------
const REVIEW_FIELDS = new Set(['round', 'verdict', 'state', 'body', 'checked', 'risks', 'findings_json', 'nonce', 'run_id', 'published_comment_id']);
export const getPrReview = (id) => q('SELECT * FROM pr_reviews WHERE id=?').get(id) || null;
export const listPrReviews = (key) => q('SELECT * FROM pr_reviews WHERE ticket_key=? ORDER BY id').all(key);
export function createPrReview(r) {
  const info = q('INSERT INTO pr_reviews(ticket_key,seat,role,sha,round) VALUES (?,?,?,?,?)').run(r.ticket_key, r.seat, r.role, r.sha, r.round || 0);
  const row = getPrReview(info.lastInsertRowid);
  announce({ type: 'pr-review', data: row });
  return row;
}
export function updatePrReview(id, patch) {
  const cols = Object.keys(patch).filter((k) => REVIEW_FIELDS.has(k));
  if (cols.length) q(`UPDATE pr_reviews SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), now(), id);
  const row = getPrReview(id);
  announce({ type: 'pr-review', data: row });
  return row;
}
/** Latest active review row per role for one commit. */
export function latestReview(key, role, sha) {
  return q("SELECT * FROM pr_reviews WHERE ticket_key=? AND role=? AND sha=? AND state='active' ORDER BY id DESC LIMIT 1").get(key, role, sha) || null;
}
/** Invalidate every review row that is not for `keepSha` (a new commit voids earlier approvals). */
export function supersedeReviews(key, keepSha = null) {
  q("UPDATE pr_reviews SET state='superseded', updated_at=? WHERE ticket_key=? AND state='active' AND (? IS NULL OR sha<>?)").run(now(), key, keepSha, keepSha);
}
/** Every seat that wrote code for a ticket (builder, answers to reviews, conflict resolutions) plus the assignee. */
export function contributorsOf(t) {
  if (!t) return new Set();
  let list = [];
  try { list = JSON.parse(t.contributors || '[]'); } catch { list = []; }
  return new Set([...list, t.builder, t.assignee].filter(Boolean));
}
export function addContributor(key, seat) {
  const t = getTicket(key);
  if (!t || !seat) return t;
  const set = contributorsOf({ contributors: t.contributors });
  if (set.has(seat)) return t;
  return updateTicket(key, { contributors: JSON.stringify([...set, seat]) });
}
/**
 * Did a context AND an independent reviewer — distinct, and neither of them a contributor — approve exactly this
 * commit? `unpublished` counts current approvals whose PR comment has no GitHub comment id yet.
 */
export function approvalsAt(key, sha) {
  const context = sha ? latestReview(key, 'context', sha) : null;
  const independent = sha ? latestReview(key, 'independent', sha) : null;
  const contrib = contributorsOf(getTicket(key));
  const ok = context?.verdict === 'approve' && independent?.verdict === 'approve' && context.seat !== independent.seat
    && !contrib.has(context.seat) && !contrib.has(independent.seat);
  const unpublished = [context, independent].filter((r) => r?.verdict === 'approve' && !r.published_comment_id).length;
  return { ok, context, independent, unpublished };
}
export const inReviewFlow = (key) => !!q('SELECT 1 FROM pr_reviews WHERE ticket_key=? LIMIT 1').get(key);
export function addFinding(f) {
  q('INSERT INTO review_findings(id,review_id,ticket_key,seat,file,line,problem,why,fix,blocking) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(f.id, f.review_id, f.ticket_key, f.seat, f.file || null, Number.isInteger(f.line) ? f.line : null, f.problem, f.why || null, f.fix || null, f.blocking ? 1 : 0);
  return getFinding(f.id);
}
export const getFinding = (id) => q('SELECT * FROM review_findings WHERE id=?').get(id) || null;
export const listFindings = (key) => q('SELECT * FROM review_findings WHERE ticket_key=? ORDER BY created_at, id').all(key);
export const findingsOf = (reviewId) => q('SELECT * FROM review_findings WHERE review_id=? ORDER BY rowid').all(reviewId);
export function updateFinding(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['response', 'response_body', 'response_sha', 'resolution'].includes(k));
  if (cols.length) q(`UPDATE review_findings SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), now(), id);
  return getFinding(id);
}

// Durable outbox for PR comments: a row is 'sent' only after GitHub returned a comment id.
export function enqueueOutbox(ticketKey, marker, body, reviewId = null) {
  q('INSERT OR IGNORE INTO pr_outbox(ticket_key,marker,body,review_id) VALUES (?,?,?,?)').run(ticketKey, marker, sanitizeForGithub(body).slice(0, 60000), reviewId);
  return q('SELECT * FROM pr_outbox WHERE marker=?').get(marker);
}
// Due rows only (failures back off), fewest attempts first so one broken comment never starves the rest.
export const pendingOutbox = (limit = 20, at = now()) => q(`SELECT o.*, t.pr_url FROM pr_outbox o JOIN tickets t ON t.key=o.ticket_key
  WHERE o.status IN ('pending','failed') AND t.pr_url IS NOT NULL AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?)
  ORDER BY o.attempts, o.id LIMIT ?`).all(at, limit);
/** Dead (escalated) comments of a ticket go back in the queue, e.g. after the owner replied. */
export function requeueOutbox(key) {
  q("UPDATE pr_outbox SET status='pending', attempts=0, next_attempt_at=NULL WHERE ticket_key=? AND status='dead'").run(key);
}
export const listOutbox = (key) => q('SELECT * FROM pr_outbox WHERE ticket_key=? ORDER BY id').all(key);
export function updateOutbox(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status', 'attempts', 'gh_comment_id', 'last_error', 'sent_at', 'next_attempt_at'].includes(k));
  if (cols.length) q(`UPDATE pr_outbox SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  return q('SELECT * FROM pr_outbox WHERE id=?').get(id);
}

// ---------- conflict jobs (merge train): durable, one per (ticket, base, head) ----------
export const getConflictJob = (id) => q('SELECT * FROM conflict_jobs WHERE id=?').get(id) || null;
export const conflictJobsFor = (key) => q('SELECT * FROM conflict_jobs WHERE ticket_key=? ORDER BY id').all(key);
export const openConflictJobs = () => q("SELECT * FROM conflict_jobs WHERE status IN ('pending','running') ORDER BY id").all();
export function createConflictJob(j) {
  const info = q('INSERT OR IGNORE INTO conflict_jobs(ticket_key,pr_number,base_sha,head_sha,seat,files_json,incoming_json) VALUES (?,?,?,?,?,?,?)')
    .run(j.ticket_key, j.pr_number ?? null, j.base_sha, j.head_sha, j.seat, JSON.stringify(j.files || []), JSON.stringify(j.incoming || []));
  const row = q('SELECT * FROM conflict_jobs WHERE ticket_key=? AND base_sha=? AND head_sha=?').get(j.ticket_key, j.base_sha, j.head_sha);
  if (info.changes) announce({ type: 'conflict-job', data: row });
  return { job: row, created: info.changes > 0 };
}
export function updateConflictJob(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status', 'seat', 'note', 'run_id', 'attempts', 'result_sha'].includes(k));
  if (cols.length) q(`UPDATE conflict_jobs SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), now(), id);
  const row = getConflictJob(id); announce({ type: 'conflict-job', data: row }); return row;
}

// ---------- ONE per-ticket reservation for every branch-mutating or merging operation ----------
// Owner branch refresh, merge-train rebase / conflict resolution, owner merge and desk merge all take the SAME
// reservation, synchronously, as their very first step (compare-and-set in one transaction), and hold it until they
// have fully finished or rolled back. The merge dispatch gate only accepts a caller holding it.
export function reservationOf(key) { try { return JSON.parse(kvGet(`reserve:${key}`) || 'null'); } catch { return null; } }
export function reserve(key, kind, note = '') {
  return transaction(() => {
    const cur = reservationOf(key);
    if (cur) return { ok: false, holder: cur };
    const token = `${kind}:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    kvSet(`reserve:${key}`, JSON.stringify({ token, kind, note, at: now() }));
    return { ok: true, token };
  });
}
/** Hand a held reservation to another stage of the same operation (e.g. desk merge → conflict resolution). */
export function transferReservation(key, token, kind, note = '') {
  return transaction(() => {
    const cur = reservationOf(key);
    if (cur?.token !== token) return false;
    kvSet(`reserve:${key}`, JSON.stringify({ ...cur, kind, note }));
    return true;
  });
}
export function releaseReservation(key, token, kind = null) {
  return transaction(() => {
    const cur = reservationOf(key);
    if (!cur || cur.token !== token || (kind && cur.kind !== kind)) return false;
    kvSet(`reserve:${key}`, 'null');
    return true;
  });
}
export function listReservations() {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  return q("SELECT key, value FROM kv WHERE key LIKE 'reserve:%' AND value <> 'null'").all()
    .map((r) => { try { return { ticket_key: r.key.slice(8), ...JSON.parse(r.value) }; } catch { return null; } }).filter(Boolean);
}
/** A closed ticket (done/wontdo) can hold nothing. */
export function clearReservation(key) { kvSet(`reserve:${key}`, 'null'); }
export const branchUpdateOf = reservationOf; // back-compat name used by older call sites/tests

// ---------- small durable key/value store (watch cursors etc.) ----------
export function createDiscussion(ticketKey, question) {
  const info = q('INSERT INTO owner_discussions(ticket_key,question) VALUES(?,?)').run(ticketKey, question);
  const d = getDiscussion(info.lastInsertRowid); announce({ type: 'discussion', data: d }); return d;
}
export const getDiscussion = (id) => q('SELECT * FROM owner_discussions WHERE id=?').get(id) || null;
export const pendingDiscussions = () => q("SELECT * FROM owner_discussions WHERE status IN ('queued','running') ORDER BY id").all();
// Finished design recommendations still waiting for the owner (Inbox cards).
export const pendingProposals = () => q("SELECT id, ticket_key FROM owner_discussions WHERE status='complete' ORDER BY id DESC LIMIT 50").all();
export const ticketDiscussions = (key) => q('SELECT * FROM owner_discussions WHERE ticket_key=? ORDER BY id DESC LIMIT 20').all(key);
export function updateDiscussion(id, patch) {
  const cols = Object.keys(patch).filter((k) => ['status', 'response', 'error', 'run_id', 'ended_at', 'attempts'].includes(k));
  if (cols.length) q(`UPDATE owner_discussions SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => patch[c] ?? null), id);
  const d = getDiscussion(id); announce({ type: 'discussion', data: d }); return d;
}
export function kvGet(key) {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  return q('SELECT value FROM kv WHERE key=?').get(key)?.value ?? null;
}
export function kvSet(key, value) {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  q('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
