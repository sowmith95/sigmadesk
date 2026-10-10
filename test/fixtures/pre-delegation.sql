-- A SigmaDesk database as the desk created it before delegation (#9): main at eebced8, built with that
-- version's own openDb and store API from synthetic rows (no real data). Regenerate only from that commit.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE tickets (
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
, risk TEXT, diff_risk TEXT, designer TEXT, qa_sha TEXT, review_round INTEGER DEFAULT 0, review_stage TEXT, reviewer_context TEXT, reviewer_independent TEXT, builder TEXT, contributors TEXT DEFAULT '[]', approved_at TEXT, merge_after TEXT, merge_hold TEXT, reconfirm_from TEXT, reconfirm_kind TEXT, reconfirm_base TEXT, research_program TEXT, research_run INTEGER, research_policy TEXT, research_review TEXT, research_generation INTEGER DEFAULT 0, research_revisions INTEGER DEFAULT 0, research_sources TEXT, owner_task INTEGER DEFAULT 0, assign_pinned INTEGER DEFAULT 0, assign_reason TEXT, priority_pinned INTEGER DEFAULT 0, done_at TEXT, prod_verify TEXT, prod_verify_by TEXT, owner_merge_only INTEGER DEFAULT 0);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'idle',
  current_ticket TEXT,
  current_run INTEGER,
  current_kind TEXT,
  meeting TEXT,
  last_action TEXT,
  last_action_at TEXT
);
CREATE TABLE runs (
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
, thread_id TEXT, context_hash TEXT, context_meta TEXT, job_hash TEXT, program TEXT, job TEXT, steps INTEGER DEFAULT 0, pid_start TEXT, profile_hash TEXT);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_id INTEGER,
  agent_id TEXT,
  ticket_key TEXT,
  kind TEXT NOT NULL,
  text TEXT
);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  gh_synced INTEGER DEFAULT 0,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE incidents (
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
CREATE TABLE architecture_reviews (
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
CREATE TABLE owner_discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  response TEXT,
  error TEXT,
  run_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
, attempts INTEGER DEFAULT 0);
CREATE TABLE ticket_participants (
  ticket_key TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'owner',
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_key, seat_id)
);
CREATE TABLE mention_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  seat_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  run_id INTEGER,
  reply_comment_id INTEGER,
  routed TEXT,
  attempts INTEGER DEFAULT 0,
  spent_usd REAL DEFAULT 0,       -- the tag's allowance is cumulative across attempts
  spent_ms INTEGER DEFAULT 0,
  steps_used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  ended_at TEXT, prod_access INTEGER DEFAULT 1,
  UNIQUE (comment_id, seat_id)
);
CREATE TABLE councils (
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
CREATE TABLE council_members (
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
CREATE TABLE pr_reviews (
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
CREATE TABLE review_findings (
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
CREATE TABLE pr_outbox (
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
CREATE TABLE conflict_jobs (
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
CREATE TABLE research_reviews (
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
CREATE TABLE connectors (
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
CREATE TABLE qa_verdicts (
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
CREATE TABLE lessons (
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
CREATE TABLE lesson_exposures (
  run_id INTEGER NOT NULL,
  lesson_id INTEGER NOT NULL,
  ticket_key TEXT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, lesson_id)
);
CREATE TABLE ops_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_id INTEGER,
  agent_id TEXT,
  ticket_key TEXT,
  incident_id INTEGER,
  probe TEXT NOT NULL,
  params TEXT,
  duration_ms INTEGER,
  bytes INTEGER,
  outcome TEXT NOT NULL,          -- ok | cached | error | timeout | cancelled | refused
  detail TEXT
, health TEXT, resources TEXT);
CREATE TABLE ops_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat TEXT NOT NULL,
  probes TEXT NOT NULL,           -- JSON list of probe ids, or ["*"]
  expires_at TEXT,                -- null only for standing grants (owner) — ticket/run scoped grants carry a hard cap
  ticket_key TEXT,                -- ticket-scoped: ends when the ticket closes
  run_id INTEGER,                 -- run-scoped: ends when the run ends
  standing INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT NOT NULL,       -- owner | manager | sre
  request_id INTEGER,
  reason TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT,                -- owner | manager | sre | expired | ticket closed | run ended
  revoke_reason TEXT
, watch_checkpoint INTEGER, scope TEXT);
CREATE TABLE ops_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat TEXT NOT NULL,
  probes TEXT NOT NULL,
  why TEXT,
  minutes INTEGER,                -- null with ticket_scoped
  ticket_scoped INTEGER NOT NULL DEFAULT 0,
  ticket_key TEXT,
  run_id INTEGER,
  filed_by TEXT,                  -- the seat, or 'desk' (a verify task waiting for access)
  status TEXT NOT NULL DEFAULT 'pending', -- pending (EM/SRE) | reviewing | owner | approved | denied | withdrawn
  approver TEXT,                  -- seat asked to decide (null = the owner)
  review_run INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  owner_reason TEXT,              -- why it needs the owner (beyond policy, no approver, escalated)
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  grant_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE pkg_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat TEXT NOT NULL,
  ticket_key TEXT NOT NULL,
  run_id INTEGER,
  why TEXT,
  specs TEXT NOT NULL,            -- JSON list of the requested "name==version" pins (canonical names)
  dev INTEGER NOT NULL DEFAULT 0, -- a test/dev-only dependency (else runtime)
  status TEXT NOT NULL DEFAULT 'resolving', -- resolving | owner | approved | denied | failed | revoked | expired | closed | withdrawn
  manifest TEXT,                  -- JSON: [{name, version, filename, url, sha256, size, requested, role}]
  total_bytes INTEGER,
  base_lock TEXT,                 -- JSON: the shared venv's distributions at resolution ({name: version})
  error TEXT,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  installed_at TEXT,
  install_run INTEGER,
  fingerprint TEXT,               -- JSON: the workspace venv the desk verified after the seat's offline install
  inventory TEXT,                 -- JSON: per added wheel, the files it installs (from its RECORD, each re-hashed)
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE deploy_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deploy_key TEXT NOT NULL,       -- one deployment: the lock id, or run:<id>:<attempt> for reconciled runs
  merge_sha TEXT NOT NULL,
  ticket_key TEXT,
  pr INTEGER,
  workflow TEXT NOT NULL,         -- workflow file
  run_id INTEGER NOT NULL DEFAULT 0,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  target TEXT,                    -- deploy.targets[workflow] (service/environment), null = unknown target
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  source TEXT NOT NULL,           -- desk | owner | external
  event TEXT,                     -- the run's trigger (push, workflow_dispatch, …) when known
  cleared_by TEXT,                -- the owner cleared this hold (status stays failed/unknown)
  recorded_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), hold_status TEXT,
  UNIQUE(merge_sha, workflow, run_id, run_attempt)
);
CREATE TABLE deploy_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deploy_key TEXT UNIQUE NOT NULL,
  merge_sha TEXT NOT NULL,
  ticket_key TEXT,
  pr INTEGER,
  target TEXT,
  workflows TEXT,                 -- JSON [{workflow, run_id, run_attempt}]
  source TEXT,
  deployed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching', -- watching | verified | regression | inconclusive | superseded
  verdict_note TEXT,
  baseline TEXT,                  -- JSON, captured at merge (bounded timestamps)
  criteria TEXT,                  -- the ticket's "How to verify in production" text, if any
  criteria_source TEXT,           -- ticket | derived
  trading_path INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER,
  hold INTEGER NOT NULL DEFAULT 0, -- 1 while a suspected regression holds deploying merges (owner clears)
  cleared_by TEXT,
  cleared_at TEXT,
  incident_key TEXT,
  revert_key TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, hold_kind TEXT, retired_targets TEXT, retired_resources TEXT);
CREATE TABLE watch_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  name TEXT NOT NULL,             -- smoke | settle | session_open
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | needs_sre | sre_running | done | superseded
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  verdict TEXT,                   -- verified | regression | inconclusive
  limited INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  evidence TEXT,                  -- JSON: identity, items [{criterion, probe, observed_at, threshold, observed, result, note}], coverage
  sre_reason TEXT,
  sre_attempts INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER,
  spent_usd REAL DEFAULT 0,
  spent_ms INTEGER DEFAULT 0,
  steps_used INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(watch_id, name)
);
INSERT INTO "tickets"("id","key","title","description","type","status","area","complexity","priority","assignee","reporter","source","parent_key","branch","pr_url","issue_number","progress","progress_msg","qa_loops","stalls","head_sha","origin_session","after_key","active_run","resume_status","created_at","updated_at","risk","diff_risk","designer","qa_sha","review_round","review_stage","reviewer_context","reviewer_independent","builder","contributors","approved_at","merge_after","merge_hold","reconfirm_from","reconfirm_kind","reconfirm_base","research_program","research_run","research_policy","research_review","research_generation","research_revisions","research_sources","owner_task","assign_pinned","assign_reason","priority_pinned","done_at","prod_verify","prod_verify_by","owner_merge_only") VALUES (1,'SD-1','Normalize equity fills','Map broker fills to the journal row.','feature','needs_human','backend','S','P2','junior','manager','human',NULL,NULL,NULL,NULL,0,NULL,0,0,NULL,NULL,NULL,NULL,'todo','2026-10-10T01:12:38.735Z','2026-10-10T01:12:38.736Z','low',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,NULL,0,0,NULL,0,NULL,NULL,NULL,0);
INSERT INTO "tickets"("id","key","title","description","type","status","area","complexity","priority","assignee","reporter","source","parent_key","branch","pr_url","issue_number","progress","progress_msg","qa_loops","stalls","head_sha","origin_session","after_key","active_run","resume_status","created_at","updated_at","risk","diff_risk","designer","qa_sha","review_round","review_stage","reviewer_context","reviewer_independent","builder","contributors","approved_at","merge_after","merge_hold","reconfirm_from","reconfirm_kind","reconfirm_base","research_program","research_run","research_policy","research_review","research_generation","research_revisions","research_sources","owner_task","assign_pinned","assign_reason","priority_pinned","done_at","prod_verify","prod_verify_by","owner_merge_only") VALUES (2,'SD-2','Count yesterday''s fills on the production box','Read-only count.','feature','todo','db','S','P2',NULL,'manager','human',NULL,NULL,NULL,NULL,0,NULL,0,0,NULL,NULL,NULL,NULL,NULL,'2026-10-10T01:12:38.738Z','2026-10-10T01:12:38.739Z',NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,NULL,1,0,NULL,0,NULL,NULL,NULL,0);
INSERT INTO "tickets"("id","key","title","description","type","status","area","complexity","priority","assignee","reporter","source","parent_key","branch","pr_url","issue_number","progress","progress_msg","qa_loops","stalls","head_sha","origin_session","after_key","active_run","resume_status","created_at","updated_at","risk","diff_risk","designer","qa_sha","review_round","review_stage","reviewer_context","reviewer_independent","builder","contributors","approved_at","merge_after","merge_hold","reconfirm_from","reconfirm_kind","reconfirm_base","research_program","research_run","research_policy","research_review","research_generation","research_revisions","research_sources","owner_task","assign_pinned","assign_reason","priority_pinned","done_at","prod_verify","prod_verify_by","owner_merge_only") VALUES (3,'SD-3','Retry helper','Fix the retry helper.','feature','needs_human','backend','S','P2','senior-be','owner','human',NULL,NULL,NULL,NULL,0,'QA failed repeatedly',4,0,NULL,NULL,NULL,NULL,'todo','2026-10-10T01:12:38.739Z','2026-10-10T01:12:38.740Z','low',NULL,NULL,NULL,0,NULL,NULL,NULL,'senior-be','[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,NULL,0,0,NULL,0,NULL,NULL,NULL,0);
INSERT INTO "tickets"("id","key","title","description","type","status","area","complexity","priority","assignee","reporter","source","parent_key","branch","pr_url","issue_number","progress","progress_msg","qa_loops","stalls","head_sha","origin_session","after_key","active_run","resume_status","created_at","updated_at","risk","diff_risk","designer","qa_sha","review_round","review_stage","reviewer_context","reviewer_independent","builder","contributors","approved_at","merge_after","merge_hold","reconfirm_from","reconfirm_kind","reconfirm_base","research_program","research_run","research_policy","research_review","research_generation","research_revisions","research_sources","owner_task","assign_pinned","assign_reason","priority_pinned","done_at","prod_verify","prod_verify_by","owner_merge_only") VALUES (4,'SD-4','Old shipped work','Done.','feature','done','backend','S','P2',NULL,'owner','human',NULL,NULL,NULL,NULL,0,NULL,0,0,NULL,NULL,NULL,NULL,NULL,'2026-10-10T01:12:38.740Z','2026-10-10T01:12:38.740Z',NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,NULL,0,0,NULL,0,NULL,NULL,NULL,0);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('product-design','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('trading-advisor','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('quant-research','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('pm','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('manager','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('principal-be','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('senior-be','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('principal-fe','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('senior-fe','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('dba','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('junior','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('qa','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('sre','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agents"("id","status","current_ticket","current_run","current_kind","meeting","last_action","last_action_at") VALUES ('support','idle',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "events"("id","ts","run_id","agent_id","ticket_key","kind","text") VALUES (1,'2026-10-10T01:12:38.736Z',NULL,'manager','SD-1','created','created “Normalize equity fills” → in_progress');
INSERT INTO "events"("id","ts","run_id","agent_id","ticket_key","kind","text") VALUES (2,'2026-10-10T01:12:38.739Z',NULL,'manager','SD-2','created','created “Count yesterday''s fills on the production box” → todo');
INSERT INTO "events"("id","ts","run_id","agent_id","ticket_key","kind","text") VALUES (3,'2026-10-10T01:12:38.739Z',NULL,'owner','SD-3','created','created “Retry helper” → needs_human');
INSERT INTO "events"("id","ts","run_id","agent_id","ticket_key","kind","text") VALUES (4,'2026-10-10T01:12:38.740Z',NULL,'owner','SD-4','created','created “Old shipped work” → done');
INSERT INTO "comments"("id","ticket_key","author","body","gh_synced","ts") VALUES (1,'SD-1','junior','❓ **Question for the owner:** Should odd lots be skipped like the options journal does?',0,'2026-10-10T01:12:38.736Z');
INSERT INTO "comments"("id","ticket_key","author","body","gh_synced","ts") VALUES (2,'SD-2','manager','🙋 **This is your task**: needs production access',0,'2026-10-10T01:12:38.739Z');
INSERT INTO "settings"("key","value") VALUES ('paused','true');
INSERT INTO "settings"("key","value") VALUES ('max_concurrent','3');
INSERT INTO "settings"("key","value") VALUES ('daily_budget_usd','150');
INSERT INTO "settings"("key","value") VALUES ('pm_enabled','false');
INSERT INTO "settings"("key","value") VALUES ('pm_interval_min','720');
INSERT INTO "settings"("key","value") VALUES ('max_open_proposals','5');
INSERT INTO "settings"("key","value") VALUES ('github_sync','false');
INSERT INTO "settings"("key","value") VALUES ('open_draft_prs','false');
INSERT INTO "settings"("key","value") VALUES ('draft_prs','false');
INSERT INTO "settings"("key","value") VALUES ('team','{}');
INSERT INTO "settings"("key","value") VALUES ('team_confirmed','false');
INSERT INTO "settings"("key","value") VALUES ('auto_fallback','true');
INSERT INTO "settings"("key","value") VALUES ('groom_engine','codex');
INSERT INTO "settings"("key","value") VALUES ('assign_mode','balanced');
INSERT INTO "settings"("key","value") VALUES ('research_programs','');
INSERT INTO "settings"("key","value") VALUES ('ops_enabled','false');
INSERT INTO "settings"("key","value") VALUES ('access_policy','');
INSERT INTO sqlite_sequence(name, seq) VALUES ('tickets', 4);
INSERT INTO sqlite_sequence(name, seq) VALUES ('events', 4);
INSERT INTO sqlite_sequence(name, seq) VALUES ('comments', 2);
CREATE INDEX tickets_status ON tickets(status);
CREATE INDEX runs_status ON runs(status);
CREATE INDEX events_ticket ON events(ticket_key, id);
CREATE INDEX events_agent ON events(agent_id, id);
CREATE INDEX comments_ticket ON comments(ticket_key, id);
CREATE INDEX incidents_status ON incidents(status);
CREATE INDEX mention_deliveries_ticket ON mention_deliveries(ticket_key, id);
CREATE INDEX mention_deliveries_status ON mention_deliveries(status);
CREATE INDEX councils_status ON councils(status);
CREATE INDEX pr_reviews_ticket ON pr_reviews(ticket_key, id);
CREATE INDEX review_findings_ticket ON review_findings(ticket_key);
CREATE INDEX pr_outbox_status ON pr_outbox(status, id);
CREATE INDEX conflict_jobs_status ON conflict_jobs(status, id);
CREATE INDEX research_reviews_ticket ON research_reviews(ticket_key, generation);
CREATE INDEX qa_verdicts_ticket ON qa_verdicts(ticket_key, id);
CREATE INDEX ops_audit_ts ON ops_audit(ts);
CREATE INDEX ops_audit_run ON ops_audit(run_id);
CREATE INDEX ops_grants_seat ON ops_grants(seat, revoked_at);
CREATE INDEX pkg_requests_ticket ON pkg_requests(ticket_key, status);
CREATE INDEX deploy_history_key ON deploy_history(deploy_key);
CREATE INDEX deploy_history_ticket ON deploy_history(ticket_key);
CREATE INDEX deploy_watches_status ON deploy_watches(status);
CREATE INDEX watch_checkpoints_status ON watch_checkpoints(status, due_at);
COMMIT;
