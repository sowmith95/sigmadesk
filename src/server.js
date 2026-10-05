import * as productReview from './product-review.js';
import * as features from './features.js';
import * as epicReview from './epic-review.js';
import * as teamStats from './team-stats.js';
import * as lessons from './lessons.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, validateConfig } from './config.js';
import { AGENTS, ENGINEERS, STATUSES, applyTeamOverrides, agentById , TEAM_PROBLEMS } from './team.js';
import { teamCoverage } from './team-catalog.js';
import { board } from '../public/attention.js';
import { stageOf } from '../public/stages.js';
import * as inboxState from './inbox-state.js';
import * as flow from '../public/flow.js';
import { ENGINES, detectEngines, presets, suggestFor, SEAT_TIER, TIER_TEXT } from './engines/index.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as sched from './scheduler.js';
import * as watch from './watch.js';
import * as prsync from './prsync.js';
import * as prs from './prs.js';
import * as reviews from './reviews.js';
import * as mergetrain from './mergetrain.js';
import * as refresh from './refresh.js';
import { nameOf } from '../public/names.js';
import * as dispatch from './dispatch.js';
import * as advisors from './advisors.js';
import * as council from './council.js';
import * as runtime from './runtime.js';
import * as usage from './usage.js';
import { normalizeSeat, supportsSeat } from './team-settings.js';
import * as research from './research.js';
import * as researchReview from './research-review.js';
import * as connectors from './connectors.js';

const PUBLIC = path.join(config.root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
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

// Display name: an explicit alias (owner rename) or one derived from the title. Stored in kv: no schema change.
const withName = (t) => ({ ...t, name: nameOf({ ...t, name: store.kvGet(`name:${t.key}`) || '' }) });

export function snapshot({ inbox = true } = {}) {
  const states = Object.fromEntries(store.listAgentStates().map((a) => [a.id, a]));
  const spend = store.spendByAgentSince(sched.startOfToday());
  const settings = store.getSettings();
  const mergeReasons = {};
  const snap = {
    agents: AGENTS.map(({ charter, ...a }) => ({ ...a, ...states[a.id], spend_today: spend[a.id] || 0 })),
    tickets: store.listTickets().map(withName),
    events: store.recentEvents({ limit: 200 }),
    runs: store.recentRuns(40),
    settings,
    incidents: config.watch.enabled ? store.listIncidents({ limit: 150 }).map((i) => ({ ...i, window_count: watch.windowCount(i.signature) })) : [],
    meta: {
      watch: { enabled: config.watch.enabled, sources: watch.health(), window_minutes: config.watch.windowMinutes, min_count: config.watch.newSignatureMinCount },
      project: config.project.name, repo: config.project.githubRepo, preview: config.server.preview === true, spend_today: store.spendSince(sched.startOfToday()),
      capacity: sched.capacity(settings), busy_window: sched.inBusyWindow(), running: runner.runningCount() + advisors.runningCount() + council.externalRunningCount(),
      quota: JSON.parse(store.kvGet('quota:claude') || 'null'), plan_hold_at: config.limits.planHoldAt,
      providers: dispatch.providerHealth(), scheduler: sched.health(), advisors: advisors.status(), council: council.status(), background: runtime.status(), usage: usage.status(),
      routing: Object.fromEntries(AGENTS.map((a) => { const s = dispatch.selectionFor(a.id); return [a.id, { engine: s.seat?.engine, model: s.seat?.model, effort: s.seat?.effort, tier: SEAT_TIER[a.id], fallback: s.fallback || false, reason: s.reason }]; })),
      product_reviews: productReview.summaries(),
      feature_plans: features.summaries(),
      epic_reviews: epicReview.summaries(),
      team_stats: teamStats.current(),
      merge_states: mergeStates(undefined, mergeReasons), // per ticket ready to merge: queued / scheduled / held / owner / merging … (the request tracker reads it)
      merge_reasons: mergeReasons,
      deploy_lock: mergetrain.deployState(), // as stored (refreshed by the PR sync loop): the request tracker reads it
      lessons: store.listLessons(),
      groom: (() => { const sel = dispatch.pinnedSelection('manager', features.ENGINE, 'feature_groom'); return { engine: features.ENGINE, ready: !!sel.seat, reason: sel.reason || null, setting: settings.groom_engine || 'codex' }; })(),
      research: research.status(settings), research_reviews: researchReview.summaries(),
      decisions: { proposals: store.pendingProposals() }, engineers: ENGINEERS, statuses: STATUSES, last_event_id: store.recentEvents({ limit: 1 })[0]?.id || 0,
    },
  };
  // Inbox attention state: real waiting time per decision and the owner's snoozes (public/inbox.js applies them).
  // Tickets linked to an open incident are never snoozable, whether or not the watch lists incidents right now.
  snap.meta.protected_tickets = store.openIncidentTickets();
  // Facts the owner's step needs that live outside the ticket row: why a guard held, and failing publishes.
  const json = (k) => { try { return JSON.parse(store.kvGet(k) || 'null'); } catch { return null; } };
  snap.meta.guard_reasons = {}; snap.meta.publish_errors = {};
  for (const t of snap.tickets) {
    if (['done', 'wontdo'].includes(t.status)) continue;
    const g = /publish guard/i.test(t.progress_msg || '') && json(`guard-reasons:${t.key}`);
    if (g && g.head === t.head_sha) snap.meta.guard_reasons[t.key] = g;
    const e = json(`publish-error:${t.key}`);
    if (e && e.head === t.head_sha) snap.meta.publish_errors[t.key] = e;
  }
  if (!inbox) return snap;
  // One board per snapshot: computed with the stored state, then the stored state is reconciled with it (new
  // decisions start their clock, invalid snoozes are dropped for good). Routes on this snapshot reuse `snap.board`.
  snap.meta.waiting_since = inboxState.readSince();
  snap.meta.snoozes = inboxState.readSnoozes();
  const B = board(snap);
  snap.meta.waiting_since = inboxState.trackSince(B.decisions || []);
  snap.meta.snoozes = inboxState.snoozes(B.decisions || [], { incidents: snap.incidents || [], protectedKeys: snap.meta.protected_tickets });
  Object.defineProperty(snap, 'board', { value: B, enumerable: false });
  return snap;
}

// ---------------- SSE ----------------
const clients = new Set();
store.bus.on('msg', (m) => {
  const id = m.type === 'event' ? `id: ${m.data.id}\n` : '';
  const line = `${id}data: ${JSON.stringify(m)}\n\n`;
  for (const res of clients) res.write(line);
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000).unref();

// The owner's own requests (newest first) and where each stands: the Projects home lists them across desks.
// What needs the owner comes from the board (one source of truth); the deploy lock is read as stored, never polled.
/** Merge state of every ticket that is ready to merge (or confirming one): key → state. */
function mergeStates(tickets = store.listTickets(), reasons = null) {
  const out = {};
  for (const t of tickets) {
    if (t.review_stage === 'merge_unknown' || t.review_stage === 'merging') out[t.key] = 'merging'; // confirming with GitHub
    else if (t.status === 'ready_for_human') {
      const m = mergetrain.mergeState(t);
      out[t.key] = m?.state || null;
      if (reasons && m?.reason) reasons[t.key] = m.reason; // why the merge is the owner's (or held): the Inbox says it
    }
  }
  return out;
}
export function requestStage(t, snap, B, ix = flow.index(snap.tickets), merges = snap.meta?.merge_states || mergeStates(snap.tickets)) {
  const names = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
  const tree = new Set([t.key, ...flow.descendants(t.key, ix).map((k) => k.key)]);
  return stageOf(t, { kids: ix.kids.get(t.key) || [], plan: features.current(t.key), deploy: mergetrain.deployState(), names, merges,
    decisions: (B.decisions || B.needs_you).filter((d) => tree.has(d.key)) });
}
function requestsOf(snap, B, limit = 5) {
  const names = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
  const ix = flow.index(snap.tickets);
  return snap.tickets.filter((t) => t.reporter === 'owner' && !t.parent_key).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit)
    .map((t) => {
      const st = requestStage(t, snap, B, ix);
      return { key: t.key, title: t.title, name: nameOf(t), created_at: t.created_at, at: st.at, line: st.line, closed: st.closed, done: st.done,
        who: st.who, who_name: names[st.who] || (st.who === 'you' ? 'You' : null), needs_you: st.actions.length > 0, step: st.at ? st.steps.findIndex((x) => x.id === st.at) + 1 : 0, of: st.steps.length };
    });
}

// ---------------- owner auth (optional shared token → HttpOnly cookie) ----------------
// One cookie per project: desks on the same host but different ports would otherwise overwrite each other's token.
const COOKIE = config.projectId === 'legacy' ? 'sigmadesk_token' : `sigmadesk_token_${config.projectId}`;
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

  // These routes are below the same owner authentication boundary as ticket decisions.

  if (url.searchParams.get('token') && config.server.ownerToken) {
    if (url.searchParams.get('token') !== config.server.ownerToken) return send(res, 401, 'bad token', 'text/plain');
    // `next` (a desk page, optionally a ticket) lets the Projects home land on a request; anything else goes home.
    const next = url.searchParams.get('next') || '';
    const to = /^#\/[a-z]+(\/[A-Z][A-Z0-9]*-\d+)?$/.test(next) ? `/${next}` : '/';
    return send(res, 302, '', 'text/plain', { Location: to, 'Referrer-Policy': 'no-referrer', 'Set-Cookie': `${COOKIE}=${config.server.ownerToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  const isApi = p.startsWith('/api/');
  if (isApi && !ownerAuthed(req)) return send(res, 401, { error: 'open /?token=<ownerToken> once on this device' });
  // CSRF: state-changing calls must be JSON from this origin (SameSite=Strict cookie + content-type check).
  // CSRF: a write must be real JSON (the media type itself, not a parameter: `text/plain; x=application/json` is a
  // "simple" request a foreign page can send without a preflight) and, when a browser says where it came from, from this
  // page's own origin. Another local port is same-site, so the SameSite cookie alone does not stop it.
  if (isApi && req.method !== 'GET') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return send(res, 415, { error: 'json only' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null' ? (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })() : origin === 'null') return send(res, 403, { error: 'cross-origin write refused' });
  }

  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && p === '/api/state') return send(res, 200, snapshot());
  if (req.method === 'GET' && p === '/api/advisors') return send(res, 200, advisors.status());
  if (req.method === 'GET' && p === '/api/councils') return send(res, 200, council.status());
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/councils$'))) return send(res, 201, council.create(mm[1], await readBody(req)));
  if (req.method === 'GET' && (mm = m('^/api/councils/(\\d+)$'))) return send(res, 200, council.current(Number(mm[1])));
  if (req.method === 'POST' && (mm = m('^/api/councils/(\\d+)/(run|cancel|retry|decision)$'))) {
    const id = Number(mm[1]), action = mm[2];
    const result = action === 'run' ? council.queue(id) : action === 'cancel' ? council.cancel(id) : action === 'retry' ? council.retry(id) : council.decide(id, await readBody(req));
    council.pump();
    return send(res, action === 'run' || action === 'retry' ? 202 : 200, result);
  }
  if (req.method === 'POST' && p === '/api/providers/refresh') return send(res, 200, await usage.refresh());
  if (req.method === 'POST' && p === '/api/providers/desktop-usage') return send(res, 200, usage.recordDesktop(await readBody(req)));
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/architecture-reviews$')))
    return send(res, 201, advisors.createBrief(mm[1], await readBody(req)));
  if (req.method === 'GET' && (mm = m('^/api/architecture-reviews/(\\d+)$'))) {
    const review = store.getArchitectureReview(Number(mm[1]));
    return send(res, review ? 200 : 404, review || { error: 'Review not found' });
  }
  if (req.method === 'POST' && (mm = m('^/api/architecture-reviews/(\\d+)/import$')))
    return send(res, 200, advisors.importReport(Number(mm[1]), (await readBody(req)).result || ''));
  if (req.method === 'POST' && (mm = m('^/api/architecture-reviews/(\\d+)/run$'))) {
    const id = Number(mm[1]);
    advisors.assertCanRun(id);
    advisors.runReview(id).catch((err) => store.logEvent({ kind: 'error', agent_id: 'architecture-board', text: err.message }));
    return send(res, 202, { ok: true, id });
  }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/product-review$'))) {
    const body = await readBody(req);
    const result = body.action ? productReview.decide(mm[1], body) : productReview.start(mm[1], body);
    sched.tick(); return send(res, 200, result);
  }
  // Versioned summary for the Projects home: enough to show a project card, nothing more.
  if (req.method === 'GET' && p === '/api/summary') {
    const snap = snapshot();
    const B = snap.board || board(snap);
    const recent = requestsOf(snap, B, 5);
    return send(res, 200, { version: 1, id: config.projectId, project: config.project.name, repo: config.project.githubRepo || config.project.repoPath,
      paused: snap.settings.paused === 'true', team_confirmed: snap.settings.team_confirmed === 'true', needs_you: B.counts.needs_you, working: B.counts.working,
      blocked: B.counts.blocked, queued: B.counts.queued, spend_today: snap.meta.spend_today, budget: Number(snap.settings.daily_budget_usd), recent_requests: recent, snoozed: B.counts.snoozed || 0, at: store.now() });
  }
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { at: store.now(), providers: dispatch.providerHealth(), scheduler: sched.health(), watch: snapshot({ inbox: false }).meta.watch });
  if (req.method === 'GET' && (mm = m('^/api/tickets/KEY$'))) {
    const t = store.getTicket(mm[1]);
    if (!t) return send(res, 404, { error: 'not found' });
    return send(res, 200, { ticket: t, refresh: refresh.publicState(t.key), product_reviews: ['plan','feedback'].map(p => productReview.current(t.key,p)).filter(Boolean), research_reviews: researchReview.forTicket(t.key), comments: store.listComments(t.key), discussions: store.ticketDiscussions(t.key), reviews: store.listArchitectureReviews(t.key), pr_reviews: reviews.summary(t.key), merge_state: mergetrain.mergeState(t), conflict_jobs: mergetrain.conflictJobsView(t.key), events: store.recentEvents({ ticket_key: t.key, limit: 600 }) });
  }
  if (req.method === 'POST' && p === '/api/inbox/snooze') {
    const body = await readBody(req); // read first: validate against the state after the request arrived
    const snap = snapshot();
    const out = inboxState.setSnooze(body, { decisions: snap.board?.decisions || [], incidents: snap.incidents || [], protectedKeys: snap.meta.protected_tickets || [] });
    store.bus.emit('msg', { type: 'inbox', data: null });
    return send(res, 200, out);
  }
  if (req.method === 'GET' && p === '/api/team/stats') return send(res, 200, teamStats.current());
  if (req.method === 'GET' && p === '/api/lessons') return send(res, 200, store.listLessons());
  if (req.method === 'POST' && (mm = m('^/api/lessons/(\\d+)$'))) return send(res, 200, lessons.decide(mm[1], await readBody(req)));
  if (req.method === 'GET' && (mm = m('^/api/agents/([\\w-]+)/events$'))) return send(res, 200, store.recentEvents({ agent_id: mm[1], limit: 300 }));
  if (req.method === 'GET' && (mm = m('^/api/agents/([\\w-]+)$'))) {
    // One meaning of "first-try QA" and "cost per shipped" everywhere: the team stats' (first QA verdict, measured cost).
    const team = teamStats.current().seats[mm[1]]?.all;
    const stats = { ...store.agentStats(mm[1]), ...(team ? { first_pass_rate: team.first_pass_rate, first_pass: team.qa_first_pass, qa_first: team.qa_first, cost_per_shipped: team.cost_per_shipped, merged: team.shipped } : {}) };
    return send(res, 200, { stats, events: store.recentEvents({ agent_id: mm[1], limit: 300 }),
      tickets: store.listTickets().filter((t) => t.assignee === mm[1] || t.reporter === mm[1]).slice(0, 30) });
  }

  if (req.method === 'POST' && p === '/api/tickets') { const t = sched.ownerCreate(await readBody(req)); return send(res, t.duplicate ? 200 : 201, t); }
  if (req.method === 'POST' && p === '/api/features') return send(res, 201, features.create(await readBody(req)));
  if (req.method === 'GET' && (mm = m('^/api/features/KEY$'))) {
    const t = store.getTicket(mm[1]);
    if (!features.isFeature(t)) return send(res, 404, { error: 'Feature not found' });
    return send(res, 200, { ticket: withName(t), plan: features.current(t.key), history: features.history(t.key), request: features.requestOf(t.description) });
  }
  if (req.method === 'POST' && (mm = m('^/api/features/KEY/plan$'))) {
    const b = await readBody(req);
    const k = mm[1];
    const out = b.action === 'start' || b.action === 'revise' ? features.start(k, { direction: b.message, expected_revision: b.expected_revision })
      : b.action === 'retry' ? features.retry(k, b) : b.action === 'discard' ? features.discard(k, b)
        : b.action === 'approve' ? features.approve(k, { expected_revision: b.expected_revision, edits: b.edits, message: b.message })
          : (() => { throw Object.assign(new Error('Choose start, revise, retry, discard or approve'), { status: 400 }); })();
    return send(res, 200, out);
  }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/merge-hold$'))) { const b = await readBody(req); return send(res, 200, mergetrain.setHold(mm[1], b.hold !== false, b.reason)); }
  if (req.method === 'GET' && p === '/api/ci/required-checks') return send(res, 200, { ...prs.requiredChecks(), history: JSON.parse(store.kvGet('ci:history') || '[]'), workflows: JSON.parse(store.kvGet('ci:check-files') || '{}') });
  if (req.method === 'POST' && p === '/api/ci/required-checks') { const b = await readBody(req); return send(res, 200, prs.setRequiredChecks(b.names || [], b.learn === true ? 'auto' : 'owner')); }
  if (req.method === 'POST' && p === '/api/merge-train/clear-deploy') return send(res, 200, { cleared: mergetrain.ownerClearDeploy(await readBody(req)) });
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/approve-publish$'))) { await sched.ownerApprovePublish(mm[1]); return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/name$'))) {
    const t = store.getTicket(mm[1]);
    if (!t) return send(res, 404, { error: 'not found' });
    const name = String((await readBody(req)).name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    store.kvSet(`name:${t.key}`, name); // empty = back to the derived name
    store.logEvent({ kind: 'system', agent_id: 'owner', ticket_key: t.key, text: `renamed ${t.key} to “${name || nameOf(t)}”` });
    store.bus.emit('msg', { type: 'ticket', data: withName(store.getTicket(t.key)) });
    return send(res, 200, withName(store.getTicket(t.key)));
  }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/reply$'))) { const b = await readBody(req); return send(res, 200, sched.ownerReply(mm[1], b.body, b.mode, { expected_updated_at: b.expected_updated_at })); }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/decision$'))) return send(res, 200, await sched.ownerDecision(mm[1], await readBody(req)));
  if (req.method === 'POST' && (mm = m('^/api/discussions/(\\d+)/(retry|cancel)$'))) return send(res, 200, sched.ownerDiscussion(mm[1], mm[2]));
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/refresh-base$'))) return send(res, 200, await sched.ownerRefreshBase(mm[1], await readBody(req)));
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/owner-task$'))) { const b = await readBody(req); return send(res, 200, sched.ownerTask(mm[1], { owner_task: b.owner_task, why: b.why })); }
  if (req.method === 'POST' && (mm = m('^/api/epics/KEY/review$'))) {
    const b = await readBody(req);
    const out = b.action === 'start' ? epicReview.start(mm[1], { by: 'owner', reason: b.reason }) : b.action === 'retry' ? epicReview.retry(mm[1])
      : b.action === 'answer' ? epicReview.answer(mm[1], b) : b.action === 'close' ? epicReview.decideCloses(mm[1], { approve: !!b.approve, round: b.round })
        : b.action === 'dismiss' ? epicReview.dismiss(mm[1], b) : null;
    if (!out) return send(res, 400, { error: 'action must be start, retry, answer, close or dismiss' });
    return send(res, 200, out);
  }
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/owner-done$'))) return send(res, 200, sched.ownerTaskDone(mm[1], await readBody(req)));
  if (req.method === 'PATCH' && (mm = m('^/api/tickets/KEY$'))) return send(res, 200, sched.ownerPatch(mm[1], await readBody(req)));
  // ---- PR console (owner only; agents have no route to these) ----
  if (req.method === 'GET' && p === '/api/prs') {
    const rows = (await prs.listPrs({ refresh: url.searchParams.get('refresh') === '1' })).map((r) => ({ ...r, merge_state: r.key ? mergetrain.mergeState(store.getTicket(r.key)) : null }));
    return send(res, 200, { prs: rows, deploy_lock: mergetrain.deployState(), busy_window: sched.inBusyWindow(),
      override_phrase: prs.OVERRIDE_PHRASE, base: config.project.baseBranch, repo: config.project.githubRepo, last_sync: store.kvGet('prsync:last_ok') });
  }
  if (req.method === 'GET' && (mm = m('^/api/prs/(\\d+)/merge-check$'))) return send(res, 200, await prs.mergeCheck(Number(mm[1]), { inBusyWindow: sched.inBusyWindow(), halted: store.getSettings().paused === 'true' }));
  if (req.method === 'POST' && (mm = m('^/api/prs/(\\d+)/(approve|ready|merge|close|reviewer|tags)$'))) {
    const b = await readBody(req);
    const n = Number(mm[1]);
    const out = mm[2] === 'approve' ? await prs.approve(n, String(b.message || '').slice(0, 4000))
      : mm[2] === 'ready' ? await prs.ready(n)
        : mm[2] === 'merge' ? await mergetrain.ownerMerge(n, { method: b.method || 'squash', override: b.override || '', inBusyWindow: sched.inBusyWindow(),
          expectedSha: String(b.expected_sha || ''), overrideReason: String(b.override_reason || '').slice(0, 2000), ciAckReason: String(b.ci_ack_reason || '').slice(0, 2000), deployOverride: String(b.deploy_override_reason || '').slice(0, 2000), actor: 'owner' })
          : mm[2] === 'close' ? await prs.close(n, String(b.comment || '').slice(0, 2000))
            : mm[2] === 'reviewer' ? await prs.addReviewer(n, b.login)
              : await prs.setTags(n, { add: b.add || [], remove: b.remove || [] });
    prsync.reconcile(sched.prActions).catch(() => {}); // reflect merges/closes on the board right away
    return send(res, 200, { ok: true, ...out });
  }
  if (req.method === 'POST' && p === '/api/github/sync') {
    const n = await prsync.reconcile(sched.prActions);
    return send(res, 200, { ok: true, actions: n, last_ok: store.kvGet('prsync:last_ok') });
  }
  if (req.method === 'POST' && p === '/api/settings') {
    const b = await readBody(req);
    store.setSetting(b.key, b.value);
    store.logEvent({ kind: 'system', agent_id: 'owner', text: `setting ${b.key} = ${b.value}` });
    return send(res, 200, store.getSettings());
  }
  if (req.method === 'GET' && p === '/api/engines') {
    const engines = await detectEngines();
    dispatch.setAvailability(engines);
    const available = engines.filter((e) => e.available).map((e) => e.id);
    return send(res, 200, {
      engines, tiers: TIER_TEXT,
      presets: presets(available).map((pr) => ({ id: pr.id, label: pr.label, note: pr.note,
        seats: Object.fromEntries(AGENTS.map((a) => { const eng = pr.engine(a.id); return [a.id, { engine: eng, ...suggestFor(a.id, eng) }]; })) })),
      seats: AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.role, tier: SEAT_TIER[a.id] || 'strong', engine: a.engine, model: a.model, effort: a.effort, enabled: a.enabled, fallbacks: a.fallbacks, supported_engines: Object.keys(ENGINES).filter(e => supportsSeat(a.id, e)),
        suggestions: Object.fromEntries(available.map((e) => [e, suggestFor(a.id, e)])) })),
    });
  }
  if (req.method === 'POST' && p === '/api/team') {
    const b = await readBody(req);
    const clean = JSON.parse(store.getSettings().team || '{}');
    // Preferences may target an offline provider; readiness controls dispatch, not saving.
    for (const [id, o] of Object.entries(b.seats || {})) {
      if (!agentById[id] || !o || typeof o !== 'object') return send(res, 400, { error: `invalid seat ${id}` });
      clean[id] = normalizeSeat(id, o);
    }
    // Coverage: switching seats off may not leave a workflow without the roles it needs (checked as a whole team).
    const opts = { independentSeats: config.review.independentSeats };
    const before = new Set(teamCoverage(AGENTS.map((a) => ({ id: a.id, enabled: a.enabled })), opts));
    const gaps = teamCoverage(AGENTS.map((a) => ({ id: a.id, enabled: clean[a.id]?.enabled ?? a.enabled })), opts);
    const fresh = gaps.filter((g) => !before.has(g)); // a change may not open a new gap (an all-off preview desk stays editable)
    if (fresh.length) return send(res, 409, { error: `That would leave the desk without: ${fresh.join('; ')}.` });
    if (gaps.length && b.confirm) return send(res, 409, { error: `The team is missing: ${gaps.join('; ')}.` });
    store.setSetting('team', JSON.stringify(clean));
    applyTeamOverrides(clean);
    if (b.confirm) store.setSetting('team_confirmed', 'true');
    store.logEvent({ kind: 'system', agent_id: 'owner', text: `team updated: ${Object.entries(clean).map(([id, o]) => `${agentById[id].name}→${o.engine}${o.model ? `/${o.model}` : ''}${o.effort ? `·${o.effort}` : ''}`).join(', ')}` });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/start') {
    if (store.getSettings().team_confirmed !== 'true') return send(res, 409, { error: 'confirm_team', message: 'Choose which engine and model each seat runs on first.' });
    store.setSetting('paused', 'false');
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '▶ Desk open — seats will pick up work' });
    sched.tick();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/pause') {
    store.setSetting('paused', 'true');
    council.cancelAll();
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '⏸ Desk halted — running work finishes, nothing new starts' });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control/stop-all') {
    store.setSetting('paused', 'true');
    runner.killAll('owner circuit breaker');
    advisors.cancelAll();
    council.cancelAll();
    store.logEvent({ kind: 'system', agent_id: 'owner', text: '⛔ Circuit breaker — desk halted and every running seat stopped' });
    return send(res, 200, { ok: true });
  }
  // Research programs: "Run now" bypasses cadence and window, never budget, capacity, engine fit or the proposal allowance.
  const startProgram = async (programId, focus) => {
    const prog = research.get(programId);
    if (!prog) return send(res, 404, { error: `unknown research program ${programId}` });
    if (store.getSettings().paused === 'true') return send(res, 409, { error: 'Open the desk before starting research' });
    const sel = dispatch.selectionFor(prog.seat, Date.now(), research.requirements(prog));
    if (!sel.seat) return send(res, 409, { error: `${agentById[prog.seat]?.name || prog.seat}: ${sel.reason}` });
    if (store.getAgentState(prog.seat)?.status === 'working') return send(res, 409, { error: `${agentById[prog.seat]?.name || prog.seat} is busy` });
    if (sched.budgetHeadroom() < runner.runBudget(prog.seat)) return send(res, 409, { error: 'daily risk limit would be exceeded' });
    if (sched.workCount() >= sched.capacity()) return send(res, 409, { error: 'desk is at capacity — try again when a seat frees up' });
    if (sched.researchAllowance() <= 0) return send(res, 409, { error: 'enough proposals are waiting for grooming' });
    sched.launchResearch(String(focus || '').slice(0, 500), undefined, prog.id).catch((err) => store.logEvent({ kind: 'error', agent_id: prog.seat, text: err.message }));
    return send(res, 202, { ok: true, program: prog.id });
  };
  if (req.method === 'POST' && p === '/api/control/research') return startProgram(research.DEFAULT_PROGRAM, (await readBody(req)).focus);
  if (req.method === 'GET' && p === '/api/research') return send(res, 200, { ...research.status(), reviews: researchReview.summaries() });
  if (req.method === 'PUT' && p === '/api/research/programs') {
    const b = await readBody(req);
    // Conditional save: the editor sends the revision it loaded; another save since then is a conflict, not an overwrite.
    if (b.expected_revision !== undefined && b.expected_revision !== research.revision()) return send(res, 409, { error: 'Research programs changed since you opened them. Your edit is kept; review the latest list and save again.' });
    const saved = research.save(b.programs); sched.tick(); return send(res, 200, { programs: saved, status: research.status() });
  }
  if (req.method === 'POST' && p === '/api/research/programs/reset') return send(res, 200, { programs: research.reset(), status: research.status() });
  if (req.method === 'POST' && (mm = m('^/api/research/programs/([a-z0-9-]+)/run$'))) return startProgram(mm[1], (await readBody(req)).focus);
  if (req.method === 'POST' && (mm = m('^/api/tickets/KEY/research-review/waive$'))) { const b = await readBody(req); const t = researchReview.waive(mm[1], String(b.note || '').slice(0, 2000)); sched.tick(); return send(res, 200, t); }
  if (req.method === 'GET' && p === '/api/connectors') return send(res, 200, { connectors: connectors.list(), case_sections: connectors.CASE_SECTIONS, sdlc_stages: connectors.SDLC_STAGES });
  if (req.method === 'POST' && p === '/api/connectors') { const b = await readBody(req); return send(res, 201, connectors.propose({ name: b.name, purpose: b.purpose, case_md: b.case_md, proposed_by: 'owner' })); }
  if (req.method === 'POST' && (mm = m('^/api/connectors/([a-z0-9-]+)/(case|assess|approve|reject|retire)$'))) {
    const b = await readBody(req), name = mm[1], action = mm[2];
    const out = action === 'case' ? connectors.updateCase(name, { purpose: b.purpose, case_md: b.case_md })
      : action === 'assess' ? connectors.requestAssessment(name)
        : action === 'approve' ? connectors.approve(name, { binding: b.binding, tools: b.tools, review_after_days: b.review_after_days ?? 30, note: b.note })
          : action === 'reject' ? connectors.reject(name, b.reason) : connectors.retire(name, b.reason);
    if (action === 'assess') sched.tick();
    return send(res, 200, out);
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
    // Bundle assets never fall back to the page: a stale tab asking for a replaced chunk must see a 404, not HTML.
    if (rel.startsWith('app/') && !(file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile())) return send(res, 404, 'not found', 'text/plain');
    const target = file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUBLIC, 'index.html');
    return send(res, 200, fs.readFileSync(target), MIME[path.extname(target)] || 'application/octet-stream',
      target.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" } : {});
  }
  return send(res, 404, { error: 'not found' });
}

// ---------------- agent listener (unix socket; the only door agents can reach) ----------------
async function agentRoute(req, res, boundRunId) {
  const mm = new URL(req.url, 'http://x').pathname.match(/^\/desk\/([\w-]+)$/);
  if (req.method !== 'POST' || !mm) return send(res, 404, { error: 'not found' });
  const run = store.runByToken((req.headers.authorization || '').replace(/^Bearer\s+/, ''));
  // The socket itself is bound to one run: a token copied from another run is rejected here.
  if (!run || run.id !== boundRunId) return send(res, 401, { error: 'invalid or finished run token' });
  const out = await sched.deskAction(run, mm[1], await readBody(req));
  return send(res, 200, { ok: true, output: out });
}

// File-mailbox transport for engines whose sandbox blocks the socket (e.g. Codex with network off).
const inFlight = new Set();
const mailboxReplies = new Map();
// The mailbox lives in an agent-writable clone: never follow symlinks, and never write into it directly.
function mailboxIsSafe(runId, dir) {
  try {
    const cwd = fs.realpathSync(runner.runCwd(runId) || '/nonexistent');
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const real = fs.realpathSync(dir);
    return real === path.join(cwd, '.desk-mailbox', `r${runId}`) && fs.lstatSync(path.join(cwd, '.desk-mailbox')).isDirectory();
  } catch { return false; }
}
export function pollMailboxes() {
  for (const [runId, dir] of runner.openMailboxes()) {
    if (!mailboxIsSafe(runId, dir)) continue;
    let names;
    try { names = fs.readdirSync(dir).filter((n) => /^req-[0-9a-f]{16}\.json$/.test(n)); } catch { continue; }
    for (const name of names) {
      const id = name.slice(4, -5);
      if (inFlight.has(`${runId}:${id}`)) continue;
      inFlight.add(`${runId}:${id}`);
      const reply = (obj) => {
        const replyKey = `${runId}:${id}`;
        mailboxReplies.set(replyKey, obj);
        let tmp;
        try {
          if (!mailboxIsSafe(runId, dir)) return;
          // Write privately, then rename INTO the mailbox: rename replaces a planted symlink instead of following it.
          const privateDir = config.home ? config.runDir : path.join(config.root, 'run');
          fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
          tmp = path.join(privateDir, `mbx-${runId}-${id}-${crypto.randomBytes(6).toString('hex')}.tmp`);
          fs.writeFileSync(tmp, JSON.stringify(obj), { flag: 'wx', mode: 0o644 });
          fs.renameSync(tmp, path.join(dir, `res-${id}.json`));
          try { fs.unlinkSync(path.join(dir, name)); } catch { /* consumed or removed by the seat */ }
          mailboxReplies.delete(replyKey);
        } catch (err) {
          if (!obj._replyErrorReported) {
            store.logEvent({ kind: 'error', run_id: runId, text: `Desk mailbox reply failed: ${err.code || 'I/O error'}; response retained for retry` });
            Object.defineProperty(obj, '_replyErrorReported', { value: true });
          }
        } finally {
          if (tmp) { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
          inFlight.delete(replyKey);
        }
      };
      if (mailboxReplies.has(`${runId}:${id}`)) { reply(mailboxReplies.get(`${runId}:${id}`)); continue; }
      (async () => {
        let req;
        try {
          const file = path.join(dir, name);
          if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          let raw;
          try {
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.size > 1e6) throw new Error('invalid mailbox request');
            raw = fs.readFileSync(fd, 'utf8');
          } finally { fs.closeSync(fd); }
          if (raw.length > 1e6) throw new Error('too large');
          req = JSON.parse(raw);
        } catch {
          if (mailboxIsSafe(runId, dir)) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* gone */ } }
          inFlight.delete(`${runId}:${id}`); return;
        }
        const run = store.runByToken(req.token);
        if (!run || run.id !== runId) return reply({ error: 'invalid or finished run token' });
        try { reply({ ok: true, output: await sched.deskAction(run, String(req.cmd), req.body || {}) }); } catch (err) { reply({ error: err.message }); }
      })();
    }
  }
  for (const key of mailboxReplies.keys()) if (!store.getRun(Number(key.split(':')[0]))?.token) mailboxReplies.delete(key);
}

const handler = (route) => (req, res) => {
  route(req, res).catch((err) => { if (!res.headersSent) send(res, err.status || 500, { error: err.message }); });
};

// ---------------- main ----------------
/**
 * One running desk per project. Taken before the database opens: startup recovery stops processes recorded in the db,
 * so a second copy must never reach it while the first is alive. The lock file holds the owner's pid.
 */
export function acquireInstanceLock(runDir = config.runDir) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, 'desk.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      const release = () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
      process.on('exit', release);
      return { file, release };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
      let alive = false;
      try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) throw Object.assign(new Error(`another SigmaDesk (pid ${pid}) is already running for this project (${runDir})`), { code: 'ELOCKED' });
      fs.rmSync(file, { force: true }); // stale lock from a crashed desk
    }
  }
  throw new Error(`could not take the desk lock in ${runDir}`);
}

export async function main() {
  const problems = validateConfig();
  if (problems.length) {
    console.error(`SigmaDesk config problems (${config.configFile}):\n - ${problems.join('\n - ')}\n${config.home ? 'Edit the project config in its SigmaDesk folder.' : 'Copy sigmadesk.config.example.json to sigmadesk.config.json and edit it.'}`);
    process.exit(1);
  }
  if (TEAM_PROBLEMS.length) { console.error(`SigmaDesk not started: the team is invalid:\n - ${TEAM_PROBLEMS.join('\n - ')}`); process.exit(1); }
  try { acquireInstanceLock(); } catch (err) { console.error(`SigmaDesk not started: ${err.message}`); process.exit(1); }
  store.openDb();
  try { applyTeamOverrides(JSON.parse(store.getSettings().team || '{}')); } catch { /* ignore bad JSON */ }
  connectors.seed(); // config-defined connectors start as proposed; nothing is usable until assessed and approved
  for (const problem of (research.programs(), research.problems())) store.logEvent({ kind: 'error', agent_id: 'owner', text: `research programs: ${problem}` });
  const engines = await dispatch.refreshAvailability();
  engines.forEach((e) => runner.setEngineVersion(e.id, e.version));
  sched.recoverOrphans();
  advisors.recoverOrphans();
  council.recoverOrphans();
  runtime.start();
  usage.refresh().then(() => sched.tick());
  setInterval(() => usage.refresh(), 120000).unref();
  for (const host of config.server.hosts) {
    const srv = http.createServer(handler(ownerRoute));
    // A desk that cannot listen is not running: exit so the service manager reports it, instead of a silent half-desk.
    srv.on('error', (err) => { console.error(`listen ${host}:${config.server.port} failed: ${err.message}`); process.exit(1); });
    srv.listen(config.server.port, host, () => console.log(`SigmaDesk UI on http://${host}:${config.server.port}`));
  }
  // One unix socket per run, created on spawn and closed on exit (see runner.setSocketFactory).
  const sockDir = path.dirname(config.socketPath);
  fs.mkdirSync(sockDir, { recursive: true });
  for (const f of fs.readdirSync(sockDir)) if (/^r\d+\.sock$/.test(f)) fs.rmSync(path.join(sockDir, f), { force: true });
  runner.setSocketFactory((runId) => {
    const p = path.join(sockDir, `r${runId}.sock`);
    try { fs.unlinkSync(p); } catch { /* none */ }
    const srv = http.createServer((req, res) => agentRoute(req, res, runId).catch((err) => { if (!res.headersSent) send(res, err.status || 500, { error: err.message }); }));
    srv.listen(p, () => { try { fs.chmodSync(p, 0o600); } catch { /* raced with close */ } });
    return { path: p, close: () => { srv.close(); try { fs.unlinkSync(p); } catch { /* gone */ } } };
  });

  store.logEvent({ kind: 'system', text: `Desk online for ${config.project.name}${config.home ? ` (project ${config.projectId})` : ''} (${store.getSettings().paused === 'true' ? 'halted' : 'open'})` });
  github.ensureLabels().catch(() => {});
  setInterval(() => sched.tick(), 15_000);
  setInterval(pollMailboxes, 400);
  if (config.watch.enabled) {
    let polling = false; // serialize: overlapping polls would read the same cursor twice and double-count
    const loop = async () => {
      if (polling) return;
      polling = true;
      try { await watch.pollOnce(); sched.watchDecisions(); } catch (err) { console.error('watch:', err.message); } finally { polling = false; }
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
  // PRs: poll is the source of truth; the optional webhook only asks for an immediate reconcile.
  // Each PR sync also refreshes the deploy lock from GitHub: a finished deploy releases it (or a stuck one escalates)
  // even when no merge is waiting to ask. Before, only a merge attempt refreshed it, so a green deploy could hold for hours.
  const syncPrs = () => prsync.reconcile(sched.prActions).catch((err) => console.error('prsync:', err.message))
    .then(() => mergetrain.deployLock()).catch((err) => console.error('deploy lock:', err.message));
  setInterval(syncPrs, prsync.pollSeconds() * 1000);
  setTimeout(syncPrs, 15_000);
  prsync.startWebhook((event) => { store.logEvent({ kind: 'github', agent_id: 'github', text: `webhook: ${event} → syncing PRs` }); syncPrs(); });
  setInterval(() => github.flushComments(), 60_000);
  setInterval(() => mergetrain.sweep().catch((err) => console.error('merge train:', err.message)), 60_000); // PR comments, conflict check, merge train
  setInterval(() => sched.retryPublications(), 5 * 60_000);
  const shutdown = () => { council.cancelAll(); advisors.cancelAll(); runner.shutdownAll('desk shutdown').finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
