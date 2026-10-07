// Team overview: the desk grouped by responsibility. Pure (no DOM), so the Team page, its Wall mode and the tests share it.
// Nothing here is invented: every count is a partition of attention.js board() output (so it agrees with Inbox and Work),
// seat states are the presence rule (presence.js), hand-offs are read from events the desk logged, and every KPI says
// where it came from, when it was observed and over what window, or that it is unknown and why.
//   departmentsFor   — which seats belong to which department (settings.team_departments overrides the defaults)
//   departmentOf     — which department a ticket / decision belongs to (worker, then assignee, then area)
//   departmentCounts — working / queued / blocked / waiting decisions per department, from the board
//   seatStates       — each seat's honest state: working, quiet, stalled, next, idle, off
//   flowsFrom        — hand-offs between seats in the last N minutes; departmentFlows rolls them up per department pair
//   departmentKpis   — one concern and two domain KPIs per department, plus release facts (merged / deployed / verified)
//   exceptions       — what the wall leads with: approvals by age, deploy holds, stalled runs, incidents
import { presenceFor, WRITING_MS, STALE_MS } from './presence.js';

export const FLOW_WINDOW_MS = 20 * 60_000;
export { WRITING_MS, STALE_MS };

/** Default grouping. `areas` claims unassigned tickets by area; `advisors: true` collects advisor seats not listed elsewhere. */
export const DEFAULT_DEPARTMENTS = [
  { id: 'planning', label: 'Planning & triage', seats: ['manager', 'support'], areas: [], concern: 'Is every request groomed, staffed and unblocked?' },
  { id: 'backend', label: 'Backend & trading', seats: ['principal-be', 'senior-be', 'junior'], areas: ['backend', 'fullstack'], concern: 'Are orders, positions and fills handled correctly?' },
  { id: 'data', label: 'Data & database', seats: ['dba'], areas: ['db'], concern: 'Is market data fresh and the database healthy?' },
  { id: 'ui', label: 'UI & product', seats: ['principal-fe', 'senior-fe', 'product-design', 'accessibility'], areas: ['frontend'], concern: 'Does every screen show true, current data on a phone?' },
  { id: 'qa', label: 'QA & release', seats: ['qa'], areas: [], concern: 'Is what ships validated at its current commit?' },
  { id: 'reliability', label: 'Reliability', seats: ['sre'], areas: ['infra'], concern: 'Is production healthy right now?' },
  { id: 'research', label: 'Research', seats: ['pm'], areas: [], advisors: true, concern: 'Is evidence reaching a decision?' },
];
const isAdvisor = (a) => !!a?.advisor || (Array.isArray(a?.kinds) && a.kinds.includes('product_review'));

/**
 * Parse a grouping override (settings.team_departments: JSON array of { id, label, seats, areas?, advisors?, concern? }).
 * Anything malformed falls back to the defaults: a bad setting must never hide the team.
 * @param {any} raw
 */
export function departmentConfig(raw) {
  if (!raw) return DEFAULT_DEPARTMENTS;
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return DEFAULT_DEPARTMENTS; } }
  if (!Array.isArray(v) || !v.length) return DEFAULT_DEPARTMENTS;
  const out = [];
  for (const x of v) {
    if (!x || typeof x.id !== 'string' || !x.id.trim()) return DEFAULT_DEPARTMENTS;
    const base = DEFAULT_DEPARTMENTS.find((d) => d.id === x.id.trim());
    out.push({ id: x.id.trim(), label: String(x.label || base?.label || x.id).slice(0, 40), seats: Array.isArray(x.seats) ? x.seats.map(String) : [],
      areas: Array.isArray(x.areas) ? x.areas.map(String) : base?.areas || [], advisors: x.advisors === true, concern: String(x.concern || base?.concern || '') });
  }
  return out;
}

/**
 * Departments with their seats, in config order. Every agent belongs to exactly one: listed seats first, then advisors
 * on the advisors department, then anything left on "Other seats". Departments keep their place even with no seat
 * (their tickets still count); "Other seats" only appears when needed.
 * @param {any[]} [agents] @param {any} [raw]
 * @returns {{ id: string, label: string, seats: string[], areas: string[], concern: string }[]}
 */
export function departmentsFor(agents = [], raw = null) {
  const cfg = departmentConfig(raw);
  const ids = new Set(agents.map((a) => a.id));
  const placed = new Set();
  const deps = cfg.map((c) => ({ id: c.id, label: c.label, seats: [], areas: c.areas || [], concern: c.concern || '' }));
  cfg.forEach((c, i) => { for (const s of c.seats) if (ids.has(s) && !placed.has(s)) { deps[i].seats.push(s); placed.add(s); } });
  const adv = cfg.findIndex((c) => c.advisors);
  if (adv >= 0) for (const a of agents) if (!placed.has(a.id) && isAdvisor(a)) { deps[adv].seats.push(a.id); placed.add(a.id); }
  const rest = agents.filter((a) => !placed.has(a.id)).map((a) => a.id);
  if (rest.length) deps.push({ id: 'other', label: 'Other seats', seats: rest, areas: [], concern: '' });
  return deps;
}

/** seat id → department id */
export const seatIndex = (deps) => Object.fromEntries(deps.flatMap((d) => d.seats.map((s) => [s, d.id])));

/**
 * The department an item belongs to: the seat running it, else its assignee's department, else the department claiming
 * its area, else the first department (planning). Desk-level items: a page → reliability, a deploy hold → QA & release,
 * an access request → the asking seat's department. Always returns a department id, so partitions are complete.
 */
export function departmentOf(item, deps, seats = seatIndex(deps)) {
  const has = (id) => deps.some((d) => d.id === id);
  const t = item?.ticket || null;
  if ((item?.kind === 'page' || item?.kind === 'regression') && has('reliability')) return 'reliability';
  if (item?.kind === 'deploy' && has('qa')) return 'qa';
  if (item?.kind === 'access' && seats[item.access?.seat]) return seats[item.access.seat];
  if (item?.worker && seats[item.worker]) return seats[item.worker];
  if (t?.assignee && seats[t.assignee]) return seats[t.assignee];
  if (t?.area) { const d = deps.find((x) => x.areas.includes(t.area)); if (d) return d.id; }
  return deps[0]?.id || 'other';
}

/**
 * Per department: working / queued / blocked (board buckets) and the waiting decisions (the Inbox's own needs_you rows,
 * in Inbox order, so the first is the department's highest-priority decision). Partitions: summing over departments
 * gives exactly the board's counts.
 */
export function departmentCounts(board, deps) {
  const seats = seatIndex(deps);
  const out = Object.fromEntries(deps.map((d) => [d.id, { working: 0, queued: 0, blocked: 0, waiting: [] }]));
  for (const bucket of ['working', 'queued', 'blocked']) for (const it of board?.[bucket] || []) out[departmentOf(it, deps, seats)][bucket]++;
  for (const it of board?.needs_you || []) out[departmentOf(it, deps, seats)].waiting.push(it);
  return out;
}

const ts = (iso) => Date.parse(iso || '') || 0;
const SIGNAL = new Set(['say', 'action', 'tool', 'plan']);

/**
 * Honest per-seat state. A seat with an active run on a ticket gets exactly the presence strip's verdict for that run;
 * a run without a ticket (an incident investigation) uses the same thresholds on its own events.
 * @param {{ agents?: any[], runs?: any[], events?: any[], waiting?: any[], now?: number }} [o]
 * @returns {Record<string, { state: 'working'|'quiet'|'stalled'|'next'|'idle'|'off', ticket: string|null, kind: string|null, label: string, ageMs: number|null }>}
 */
export function seatStates({ agents = [], runs = [], events = [], waiting = [], now = Date.now() } = {}) {
  const out = {};
  for (const a of agents) {
    const run = runs.find((r) => r.agent_id === a.id && r.status === 'running' && (!a.current_run || r.id === a.current_run))
      || (a.status === 'working' ? { id: a.current_run || null, ticket_key: a.current_ticket || null, kind: a.current_kind || null, started_at: null } : null);
    if (run) {
      const key = a.current_ticket || run.ticket_key || null;
      const w = key ? presenceFor({ key, agents, runs, events, now }).writers.find((x) => x.seat === a.id) : null;
      if (w) { out[a.id] = { state: w.state === 'writing' ? 'working' : w.state, ticket: key, kind: a.current_kind || run.kind || null, label: w.label || '', ageMs: w.ageMs }; continue; }
      const evs = run.id ? events.filter((e) => e.run_id === run.id) : [];
      let lastAny = 0, lastSig = 0;
      for (const e of evs) { const t = ts(e.ts); lastAny = Math.max(lastAny, t); if (SIGNAL.has(e.kind)) lastSig = Math.max(lastSig, t); }
      const activity = Math.max(lastAny, ts(run.started_at));
      const state = lastSig && now - lastSig < WRITING_MS ? 'working' : activity && now - activity > STALE_MS ? 'stalled' : 'quiet';
      out[a.id] = { state, ticket: key, kind: a.current_kind || run.kind || null, label: '', ageMs: lastSig ? now - lastSig : activity ? now - activity : null };
      continue;
    }
    if (a.enabled === false) { out[a.id] = { state: 'off', ticket: null, kind: null, label: '', ageMs: null }; continue; }
    const held = waiting.find((x) => x.seat === a.id && x.key);
    out[a.id] = held ? { state: 'next', ticket: held.key, kind: null, label: '', ageMs: null } : { state: 'idle', ticket: null, kind: null, label: '', ageMs: null };
  }
  return out;
}

// ---------------- hand-offs ----------------
export const FLOW_KINDS = {
  qa: { label: 'QA hand-off' }, review: { label: 'Review' }, slice: { label: 'Slices' }, mention: { label: 'Tag' },
  verify: { label: 'Verify' }, access: { label: 'Access grant' }, owner: { label: 'To you' },
};
const NOT_A_SEAT = new Set(['system', 'github', 'desk', 'architecture-board']);
const KEY = /\b[A-Z][A-Z0-9]{0,5}-\d+\b/;

/** The seat that last worked on `key` before event `before` (not `exclude`), else the assignee; null if nobody is on record. */
function previousSeat(key, before, exclude, events, tickets, seats) {
  if (!key) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.id >= before || e.ticket_key !== key || !e.agent_id || e.agent_id === exclude || !seats.has(e.agent_id)) continue;
    return e.agent_id;
  }
  const a = tickets.find((t) => t.key === key)?.assignee;
  return a && a !== exclude && seats.has(a) ? a : null;
}

/**
 * Hand-offs in the last `windowMs`, newest first, read only from events the desk wrote:
 *   pickup "QA picked up K"                    builder → QA            (qa)
 *   pickup "… is reviewing K …"                previous seat → reviewer (review)
 *   pickup "… is answering the code review …"  reviewer → builder      (review)
 *   pickup "verifying in production …"         builder → SRE           (verify)
 *   action "sliced K … for <Role>" / "created task K for <Role>" / "groomed K … staffed <Role>"   (slice)
 *   run    "… started mention …"               you → seat              (mention)
 *   action "answered the owner's tag" / "handed to the owner"          seat → you (mention / owner)
 *   action "<Who> gave <Name> production read access …"                (access)
 * @param {{ events?: any[], agents?: any[], tickets?: any[], now?: number, windowMs?: number }} [o]
 * @returns {{ id: string, kind: string, from: string, to: string, ticket: string|null, ts: string, ageMs: number, strength: number }[]}
 */
export function flowsFrom({ events = [], agents = [], tickets = [], now = Date.now(), windowMs = FLOW_WINDOW_MS } = {}) {
  const seats = new Set(agents.map((a) => a.id));
  const byRole = new Map(agents.map((a) => [String(a.role || '').toLowerCase(), a.id]));
  const byName = new Map(agents.flatMap((a) => [[String(a.name || '').toLowerCase(), a.id], [String(a.name || '').split(/\s+/)[0].toLowerCase(), a.id]]));
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const out = [];
  const roleIn = (s) => { const m = String(s || '').trim().toLowerCase(); return m === 'the owner' ? 'owner' : byRole.get(m) || null; };
  for (const e of sorted) {
    const age = now - ts(e.ts);
    if (!ts(e.ts) || age < 0 || age > windowMs) continue;
    const t = String(e.text || '');
    const who = e.agent_id;
    let kind = null, from = null, to = null, ticket = e.ticket_key || t.match(KEY)?.[0] || null;
    if (e.kind === 'pickup' && seats.has(who)) {
      if (/^QA picked up/i.test(t) || (who === 'qa' && /picked up/.test(t))) kind = 'qa';
      else if (/verifying in production/i.test(t)) kind = 'verify';
      else if (/is reviewing|is answering the code review|resolving a merge conflict/i.test(t)) kind = 'review';
      if (kind) { to = who; from = previousSeat(e.ticket_key, e.id, who, sorted, tickets, seats); }
    } else if (e.kind === 'run' && seats.has(who) && /\bstarted mention\b/.test(t)) {
      kind = 'mention'; from = 'owner'; to = who;
    } else if (e.kind === 'action') {
      let m;
      if ((m = t.match(/^(?:sliced|created task) ([A-Z][A-Z0-9]{0,5}-\d+)\b.*? for (.+?)(?: after [A-Z][A-Z0-9]{0,5}-\d+)?$/))) { kind = 'slice'; from = who; to = roleIn(m[2]); ticket = m[1]; }
      else if ((m = t.match(/^groomed ([A-Z][A-Z0-9]{0,5}-\d+) → .*?, staffed (.+)$/))) { kind = 'slice'; from = who; to = roleIn(m[2]); ticket = m[1]; }
      else if (/^answered the owner's tag/.test(t)) { kind = 'mention'; from = who; to = 'owner'; }
      else if (/^handed to the owner/.test(t)) { kind = 'owner'; from = who; to = 'owner'; }
      else if ((m = t.match(/^(?:The owner|(.+?)) gave (.+?) production read access/))) {
        kind = 'access'; from = m[1] ? byName.get(m[1].toLowerCase()) || null : 'owner'; to = byName.get(m[2].toLowerCase()) || null;
        if (who === 'owner') from = 'owner';
      }
    }
    if (!kind || !from || !to || from === to) continue;
    if ((from !== 'owner' && !seats.has(from)) || (to !== 'owner' && !seats.has(to)) || NOT_A_SEAT.has(from) || NOT_A_SEAT.has(to)) continue;
    out.push({ id: `e${e.id}`, kind, from, to, ticket, ts: e.ts, ageMs: age, strength: Math.max(0, 1 - age / windowMs) });
  }
  return out.reverse();
}

/**
 * Hand-offs rolled up per department pair (seat-level flows inside one department are left out: they are not a
 * hand-off between departments). 'owner' stays 'owner'. Newest first: { from, to, count, kinds, lastTs, strength }.
 */
/** @param {any[]} flows @param {any[]} deps @returns {{ from: string, to: string, count: number, kinds: Record<string, number>, lastTs: string, strength: number }[]} */
export function departmentFlows(flows, deps) {
  const seats = seatIndex(deps);
  const m = new Map();
  for (const f of flows) {
    const a = f.from === 'owner' ? 'owner' : seats[f.from], b = f.to === 'owner' ? 'owner' : seats[f.to];
    if (!a || !b || a === b) continue;
    const k = `${a}>${b}`;
    const cur = m.get(k) || { from: a, to: b, count: 0, kinds: {}, lastTs: f.ts, strength: 0 };
    cur.count++; cur.kinds[f.kind] = (cur.kinds[f.kind] || 0) + 1;
    if (ts(f.ts) > ts(cur.lastTs)) cur.lastTs = f.ts;
    cur.strength = Math.max(cur.strength, f.strength);
    m.set(k, cur);
  }
  return [...m.values()].sort((x, y) => ts(y.lastTs) - ts(x.lastTs));
}

// ---------------- KPIs ----------------
const OPEN = (t) => !['done', 'wontdo'].includes(t.status);
const mins = (ms) => Math.max(0, Math.round(ms / 60_000));
/** "23 min", "5 h", "2 d" */
export function age(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const m = mins(ms);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}
const kpi = (label, value, { source, at = null, window = null, unknown = null, tone = 'neutral' } = {}) => ({ label, value: unknown ? null : value, unknown, source, at, window, tone });
const UNKNOWN = (label, why, source) => kpi(label, null, { source, unknown: why });

/**
 * One concern and two KPIs per department, plus release facts for QA & release. Each KPI:
 * { label, value (string, or null when unknown), unknown (why, or null), source, at (ISO observation time), window, tone }.
 * Only data the desk already holds is used; domain telemetry it does not observe is "unknown", with the reason.
 */
/** @param {any} state @param {any[]} deps @param {{ now?: number, board?: any }} [o] */
export function departmentKpis(state, deps, { now = Date.now(), board = null } = {}) {
  const tickets = state.tickets || [], meta = state.meta || {}, incidents = state.incidents || [], events = state.events || [];
  const seats = seatIndex(deps);
  const nowIso = new Date(now).toISOString();
  const inDep = (id) => (t) => departmentOf({ ticket: t }, deps, seats) === id;
  const bugs = (id) => tickets.filter((t) => OPEN(t) && t.type === 'bug' && inDep(id)(t));
  const oldest = (list, field = 'created_at') => list.reduce((o, t) => (!o || ts(t[field]) < ts(o[field]) ? t : o), null);
  const out = {};
  for (const d of deps) {
    const k = [];
    if (d.id === 'planning') {
      const req = tickets.filter((t) => ['triage', 'proposed'].includes(t.status));
      const o = oldest(req);
      k.push(o ? kpi('Oldest unresolved request', age(now - ts(o.created_at)), { source: `tickets in triage or proposed (${o.key} is oldest)`, at: nowIso, window: `${req.length} open requests`, tone: now - ts(o.created_at) > 3 * 86400_000 ? 'needs' : 'neutral' })
        : kpi('Oldest unresolved request', 'none', { source: 'tickets in triage or proposed', at: nowIso, window: '0 open requests' }));
      const queued = board?.queued || [];
      const ready = queued.filter((it) => it.ticket?.status === 'todo' && !(it.ticket.after_key && tickets.find((x) => x.key === it.ticket.after_key && x.status !== 'done')));
      k.push(kpi('Ready to build', String(ready.length), { source: 'queued "To do" tickets with no unmet dependency (attention board)', at: nowIso, window: 'now' }));
    } else if (d.id === 'backend') {
      k.push(UNKNOWN('Execution & reconciliation incidents', 'incidents are not tagged by domain, so execution ones cannot be told apart', 'log watch incidents'));
      const b = bugs('backend');
      k.push(kpi('Open backend defects', String(b.length), { source: 'open tickets of type bug in this department (correctness is not labelled separately)', at: nowIso, window: 'all open', tone: b.length ? 'needs' : 'neutral' }));
    } else if (d.id === 'data') {
      k.push(UNKNOWN('Ingest freshness vs threshold', 'the desk does not observe the ingestors or their freshness', 'none'));
      k.push(UNKNOWN('Failing Timescale jobs', 'the desk has no read of the database job table', 'none'));
    } else if (d.id === 'ui') {
      k.push(UNKNOWN('Verified phone workflow failures', 'no phone workflow check reports into the desk', 'none'));
      const b = bugs('ui');
      k.push(kpi('Open UI defects', String(b.length), { source: 'open tickets of type bug in this department', at: nowIso, window: 'all open', tone: b.length ? 'needs' : 'neutral' }));
    } else if (d.id === 'qa') {
      const inReview = tickets.filter((t) => t.status === 'review' || (t.status === 'ready_for_human' && t.pr_url));
      const since = (t) => ts(meta.waiting_since?.[`${t.key}:merge`]) || ts(t.updated_at);
      const o = inReview.reduce((x, t) => (!x || since(t) < since(x) ? t : x), null);
      k.push(o ? kpi('Oldest review wait', age(now - since(o)), { source: `tickets in acceptance or awaiting merge (${o.key} is oldest; last change)`, at: nowIso, window: `${inReview.length} waiting`, tone: now - since(o) > 86400_000 ? 'needs' : 'neutral' })
        : kpi('Oldest review wait', 'none', { source: 'tickets in acceptance or awaiting merge', at: nowIso, window: '0 waiting' }));
      const lock = meta.deploy_lock;
      const held = lock && ['failed', 'escalated'].includes(lock.state);
      k.push(kpi('Deployment hold', !lock ? 'none' : held ? `${lock.state === 'failed' ? 'failed deploy' : 'unconfirmed deploy'} · ${age(now - ts(lock.at))}` : `deploying · ${age(now - ts(lock.at))}`,
        { source: 'merge train deploy lock', at: lock?.at || nowIso, window: 'now', tone: held ? 'blocked' : 'neutral' }));
    } else if (d.id === 'reliability') {
      const active = incidents.filter((i) => ['investigating', 'paged', 'ticketed'].includes(i.status));
      const o = active.reduce((x, i) => (!x || ts(i.first_seen) < ts(x.first_seen) ? i : x), null);
      k.push(meta.watch && meta.watch.enabled === false ? UNKNOWN('Active production incidents', 'the log watch is off', 'log watch')
        : kpi('Active production incidents', active.length ? `${active.length} · oldest ${age(now - ts(o.first_seen))}` : '0', { source: 'log watch incidents investigating, paged or ticketed', at: nowIso, window: 'now', tone: active.length ? 'blocked' : 'neutral' }));
      const ok = (meta.watch?.sources || []).filter((s) => s.ok && s.lastPoll);
      const last = ok.reduce((x, s) => (!x || ts(s.lastPoll) > ts(x.lastPoll) ? s : x), null);
      k.push(last ? kpi('Latest healthy observation', `${age(now - ts(last.lastPoll))} ago`, { source: `log source ${last.label || last.type}`, at: last.lastPoll, window: `${ok.length} of ${(meta.watch?.sources || []).length} sources healthy`, tone: last.stale ? 'needs' : 'neutral' })
        : UNKNOWN('Latest healthy observation', (meta.watch?.sources || []).length ? 'no log source has polled successfully yet' : 'no log source is configured', 'log watch'));
    } else if (d.id === 'research') {
      const held = (board?.needs_you || []).filter((it) => it.kind === 'research').length;
      const pending = (meta.research_reviews || []).filter((r) => ['pending', 'changes'].includes(r.state)).length;
      k.push(kpi('Evidence awaiting a decision', String(held), { source: 'research proposals held for you (Inbox)', at: nowIso, window: `${pending} more in second review`, tone: held ? 'needs' : 'neutral' }));
      k.push(UNKNOWN('Reproducibility gaps', 'research reviews do not record reproducibility separately', 'research reviews'));
    } else {
      k.push(UNKNOWN('Domain KPI', 'no KPI is defined for this group', 'none'));
    }
    out[d.id] = { concern: d.concern, kpis: k };
  }
  // Release facts: merged, deployed and production-verified are different things (a merged change is not "shipped").
  // Deployed and production-verified count DISTINCT deployments from the desk's deploy history over one window (the
  // server's post-deploy watch summary), so "verified" is always "x of the deployments in that window".
  const p = meta.production?.kpis || null;
  const days = p?.window_days || 7;
  const week = p?.since ? ts(p.since) : now - days * 86400_000;
  const win = `last ${days} days`;
  const merged = tickets.filter((t) => t.status === 'done' && t.pr_url && ts(t.done_at || t.updated_at) >= week);
  const release = [
    kpi('Merged', String(merged.length), { source: 'tickets done with a PR (done_at)', at: nowIso, window: win }),
    p ? kpi('Deployed', String(p.deployed), { source: `distinct successful deployments in the deploy history${p.failed ? ` (${p.failed} failed)` : ''}`, at: p.observed_at || nowIso, window: win, tone: p.failed ? 'needs' : 'neutral' })
      : UNKNOWN('Deployed', 'the server sent no deploy history', 'deploy history'),
    p ? kpi('Production-verified', `${p.verified} of ${p.deployed}`, { source: `deployments whose post-deploy checks all passed${p.watching ? `; ${p.watching} still being watched` : ''}${p.regression ? `; ${p.regression} regression suspected` : ''}${p.inconclusive ? `; ${p.inconclusive} inconclusive` : ''}`,
      at: p.observed_at || nowIso, window: win, tone: p.regression ? 'blocked' : 'neutral' })
      : UNKNOWN('Production-verified', 'the server sent no post-deploy verdicts', 'post-deploy watch'),
  ];
  return { departments: out, release };
}

// ---------------- exceptions (the wall leads with these) ----------------
const KIND_LABEL = { guard: 'publish approval', merge: 'merge', publish: 'publish approval', question: 'question', design: 'design decision', council: 'council verdict',
  plan: 'plan review', deploy: 'deploy hold', regression: 'regression hold', access: 'access request', page: 'error page', conflict: 'conflict', setup: 'setup step', refresh: 'branch refresh',
  stuck: 'stuck task', owner_task: 'your task', epic_review: 'epic question', product: 'review feedback', research: 'research decision' };
export const decisionLabel = (kind) => KIND_LABEL[kind] || 'decision';

/**
 * Exceptions, most urgent first: suspected regressions (they hold deploying merges), deploy holds, incidents being paged/investigated, stalled runs, then approvals by age
 * (oldest first). Each: { id, type, title, detail, since, item?, seat?, ticket? }.
 */
/** @param {{ board: any, states?: Record<string, any>, agents?: any[], incidents?: any[], now?: number }} o */
export function exceptions({ board, states = {}, agents = [], incidents = [], now = Date.now() }) {
  const out = [];
  const name = (id) => String(agents.find((a) => a.id === id)?.name || id).split(/\s+/)[0];
  for (const it of board?.needs_you || []) if (it.kind === 'regression') out.push({ id: it.id, type: 'regression', title: it.verb, detail: it.reason, since: it.regression?.deployed_at || it.since || null, item: it });
  for (const it of board?.needs_you || []) if (it.kind === 'deploy') out.push({ id: it.id, type: 'deploy', title: it.verb, detail: it.reason, since: it.deploy?.at || it.since || null, item: it });
  for (const i of incidents) if (['paged', 'investigating'].includes(i.status)) out.push({ id: `incident-${i.id}`, type: 'incident', title: `${i.label || 'Service'} errors · ${i.status}`, detail: String(i.normalized || '').slice(0, 140), since: i.first_seen || null, ticket: i.ticket_key || null });
  for (const [seat, s] of Object.entries(states)) if (s.state === 'stalled') out.push({ id: `stalled-${seat}`, type: 'stalled', title: `${name(seat)} · no update for ${Math.max(1, mins(s.ageMs || 0))} min`, detail: s.label || '', since: s.ageMs != null ? new Date(now - s.ageMs).toISOString() : null, seat, ticket: s.ticket });
  const approvals = (board?.needs_you || []).filter((it) => it.kind !== 'deploy' && it.kind !== 'regression').sort((a, b) => ts(a.since) - ts(b.since));
  for (const it of approvals) out.push({ id: it.id, type: 'approval', title: it.verb, detail: decisionLabel(it.kind), since: it.since || null, item: it });
  return out;
}

/** Night on the wall: local hours [from, to) wrap past midnight. settings.wall_night "22-7"; "off" disables. */
export function isNight(date, spec = '22-7') {
  if (spec === 'off') return false;
  const m = String(spec || '').match(/^(\d{1,2})-(\d{1,2})$/);
  const [from, to] = m ? [Number(m[1]), Number(m[2])] : [22, 7];
  const h = date.getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}
