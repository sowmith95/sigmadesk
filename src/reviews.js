// Two independent reviewers on every PR (sowmith95/sigmadesk#2).
//
// After QA passes, the desk publishes the draft PR and runs two SEQUENTIAL code reviews on the exact QA-passed commit:
//   1. the CONTEXT reviewer — the principal who designed/sliced the work (recorded at slice creation), else the EM;
//   2. the INDEPENDENT reviewer — a senior or principal who neither built nor designed it, preferably on another engine.
// A reviewer either approves (saying what was checked) or requests changes as numbered findings. The author answers
// every blocking finding: fix it (new commit → QA again → both approvals void) or push back (same commit → the same
// reviewer re-reviews with the thread). Every verdict and answer is mirrored to the PR as a plain-language comment
// through a durable outbox. Two approvals at one commit → auto-merge (low risk only, outside the busy window) or
// "waiting for your merge". The database is authoritative; GitHub comments/labels are a mirror.
import { config } from './config.js';
import { agentById, PRINCIPALS, promptFor } from './team.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import { selectionFor } from './dispatch.js';
// Circular on purpose: only used at call time (function declarations are live bindings).
import { setStatus } from './scheduler.js';

export const enabled = () => Number(config.review.required) > 0;
const NEVER_REVIEW = new Set(['pm', 'sre', 'support', 'qa']);
const short = (sha) => String(sha || '').slice(0, 7);
const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
function need(cond, msg) { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); }

// ---------------- globs + risk ----------------
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Deterministic: a diff touching any configured trading/deploy path is high-risk. No file list = unknown. */
export function classifyDiff(files, paths = config.review.riskPaths) {
  if (!Array.isArray(files) || !files.length) return { risk: 'unknown', hits: [] };
  const pats = (paths || []).map(globToRegExp);
  const hits = files.filter((f) => pats.some((r) => r.test(f)));
  return { risk: hits.length ? 'high' : 'low', hits };
}

const diffHits = (key) => { try { return JSON.parse(store.kvGet(`diff-risk:${key}`) || '[]'); } catch { return []; } };

/** Is this ticket allowed to merge itself after two approvals? (Transient blockers — CI, window — are checked later.) */
export function autoMergePolicy(t) {
  const am = config.review.autoMerge || {};
  if (!am.enabled) return { eligible: false, reason: 'auto-merge is switched off' };
  if (am.excludeRiskHigh !== false) {
    if (!t.risk) return { eligible: false, reason: 'nobody recorded a risk level for this ticket, so it counts as high-risk' };
    if (t.risk !== 'low') return { eligible: false, reason: 'the ticket is marked high-risk' };
    if (t.diff_risk === 'high') { const h = diffHits(t.key); return { eligible: false, reason: `it touches trading/deploy paths${h.length ? ` (${h.slice(0, 3).join(', ')}${h.length > 3 ? '…' : ''})` : ''}` }; }
    if (t.diff_risk !== 'low') return { eligible: false, reason: 'the changed files could not be classified, so it counts as high-risk' };
  }
  return { eligible: true, reason: null };
}

// ---------------- reviewer selection (frozen at assignment) ----------------
const seatOn = (id) => !!agentById[id] && agentById[id].enabled !== false;
const engineOfSeat = (id) => { try { return selectionFor(id).seat?.engine || agentById[id]?.engine || 'claude'; } catch { return agentById[id]?.engine || 'claude'; } };
const AREA_SEATS = { frontend: ['principal-fe', 'senior-fe'], db: ['dba', 'principal-be'], backend: ['principal-be', 'senior-be', 'dba'], infra: ['principal-be', 'senior-be'] };

/**
 * context: recorded designer/slicer (a principal or the EM) → else the EM. Never PM/SRE/support/QA, never the author.
 * independent: a senior or principal from review.independentSeats, ≠ author, ≠ context; prefer a different engine than
 * the author, then a seat that knows the area, then a principal for risky work.
 */
export function selectReviewers(t) {
  const author = t.assignee;
  const contrib = store.contributorsOf(t); // everyone who wrote code for it, not just the current assignee
  const ok = (id) => id && seatOn(id) && !NEVER_REVIEW.has(id) && id !== author && !contrib.has(id);
  const context = [t.designer, 'manager'].find((id) => ok(id) && (PRINCIPALS.includes(id) || id === 'manager')) || null;
  if (!context) return { context: null, independent: null, error: 'neither the designer nor the Engineering Manager can review it (switched off, or they built it)' };
  const authorEngine = engineOfSeat(author);
  const risky = t.risk !== 'low' || t.diff_risk === 'high';
  const pool = (config.review.independentSeats || []).filter((id) => ok(id) && id !== context);
  if (!pool.length) return { context, independent: null, error: 'no senior or principal who did not build or design it is switched on' };
  const score = (id) => (engineOfSeat(id) !== authorEngine ? 4 : 0) + ((AREA_SEATS[t.area] || []).includes(id) ? 2 : 0) + (risky && PRINCIPALS.includes(id) ? 1 : 0);
  const independent = pool.map((id, i) => ({ id, s: score(id), i })).sort((a, b) => b.s - a.s || a.i - b.i)[0].id;
  return { context, independent, error: null };
}

const nameOf = (seat) => agentById[seat]?.name || seat;
const roleOf = (seat) => agentById[seat]?.role || seat;
const whyContext = (t, seat) => (seat === t.designer ? 'designed this change' : seat === 'manager' ? 'Engineering Manager, has the overall context' : 'has the context');
const roleNote = (t, row) => (row.role === 'context' ? whyContext(t, row.seat) : 'independent reviewer');
const header = (t, row) => `**${nameOf(row.seat)} — ${roleOf(row.seat)} (${roleNote(t, row)})**`;
const footer = (t, sha, extra = '') => `\n\n<sub>SigmaDesk ${t.key} · commit \`${short(sha)}\`${extra}</sub>`;

// ---------------- state machine ----------------
/** Make sure the frozen reviewers exist and each has an active row for the current commit. */
function ensureAssignments(t) {
  // A frozen reviewer who has since written code for this ticket (rework, resolution, reassignment) is no longer
  // independent: that assignment is cancelled and a new reviewer is chosen.
  const contrib = store.contributorsOf(t);
  for (const [col, role] of [['reviewer_context', 'context'], ['reviewer_independent', 'independent']]) {
    const seat = t[col];
    if (!seat || !contrib.has(seat)) continue;
    store.transaction(() => {
      for (const r of store.listPrReviews(t.key)) if (r.role === role && r.state === 'active') store.updatePrReview(r.id, { state: 'superseded' });
      store.updateTicket(t.key, { [col]: null });
    });
    store.addComment(t.key, 'system', `🔁 ${nameOf(seat)} wrote code for this ticket, so they can no longer review it as the ${role} reviewer; choosing someone else.`);
    t = store.getTicket(t.key);
  }
  let { reviewer_context: context, reviewer_independent: independent } = t;
  if (!context || !independent) {
    const pick = selectReviewers(t);
    if (pick.error) return { error: pick.error };
    context ||= pick.context; independent ||= pick.independent;
    store.updateTicket(t.key, { reviewer_context: context, reviewer_independent: independent });
    store.logEvent({ ticket_key: t.key, kind: 'system', text: `reviewers assigned: ${nameOf(context)} (context — ${whyContext(t, context)}) then ${nameOf(independent)} (independent)` });
  }
  for (const [role, seat] of [['context', context], ['independent', independent]]) {
    if (!store.latestReview(t.key, role, t.head_sha)) store.createPrReview({ ticket_key: t.key, seat, role, sha: t.head_sha, round: t.review_round || 0 });
  }
  return { context, independent };
}

/** What should run next for a ticket in review (pure: no writes). */
export function jobFor(t) {
  if (t?.status !== 'review' || !t.head_sha || t.review_stage === 'resolving') return null;
  if (t.review_stage === 'responding') return t.assignee ? { kind: 'respond', seat: t.assignee, key: t.key } : null;
  const ctx = store.latestReview(t.key, 'context', t.head_sha);
  const ind = store.latestReview(t.key, 'independent', t.head_sha);
  if (ctx?.verdict === 'pending') return { kind: 'pr_review', seat: ctx.seat, key: t.key, review: ctx };
  if (ctx?.verdict === 'approve' && ind?.verdict === 'pending') return { kind: 'pr_review', seat: ind.seat, key: t.key, review: ind };
  return null;
}

/** Idempotent: settle whatever the persisted state implies (also how a restart resumes mid-review). */
export function advance(key) {
  const t = store.getTicket(key);
  if (t?.status !== 'review' || !t.head_sha) return null;
  if (t.review_stage === 'resolving') return null; // a merge conflict is being resolved: the merge train owns it
  if (!t.review_stage) store.updateTicket(key, { review_stage: 'reviewing' });
  if (t.review_stage !== 'responding') {
    const a = ensureAssignments(store.getTicket(key));
    if (a.error) {
      const text = `⏸ **Code review cannot start**: ${a.error}. Switch a reviewer seat on (or reassign the work), then reply here to resume.`;
      store.addComment(key, 'system', text);
      setStatus(key, 'needs_human', { resume_status: 'review', progress_msg: 'no eligible code reviewer' });
      return null;
    }
    const ctx = store.latestReview(key, 'context', t.head_sha);
    const ind = store.latestReview(key, 'independent', t.head_sha);
    if (ctx?.verdict === 'approve' && ind?.verdict === 'approve') { approved(store.getTicket(key), ctx, ind); return null; }
    if ([ctx, ind].some((r) => r?.verdict === 'changes')) store.updateTicket(key, { review_stage: 'responding' }); // crash between verdict and stage
  }
  return jobFor(store.getTicket(key));
}

/** Review/respond jobs the scheduler may start now (tickets without a run in flight). */
export function nextJobs() {
  const jobs = [];
  for (const t of store.ticketsByStatus('review')) {
    if (t.active_run) continue;
    const job = advance(t.key);
    if (!job) continue;
    if (!seatOn(job.seat)) { escalateIfStuck(t, job); continue; }
    jobs.push(job);
  }
  return jobs;
}

function escalateIfStuck(t, job) {
  const since = Date.parse(job.review?.created_at || t.updated_at);
  const limit = Number(config.review.escalateAfterMinutes ?? 240) * 60_000;
  if (!(Date.now() - since > limit)) return;
  store.addComment(t.key, 'system', `⏸ ${nameOf(job.seat)} (${roleOf(job.seat)}) is assigned to ${job.kind === 'respond' ? 'answer the review' : 'review this PR'} but has been switched off for over ${Math.round(limit / 60_000)} minutes. Switch the seat back on, then reply here to resume.`);
  setStatus(t.key, 'needs_human', { resume_status: 'review', progress_msg: `${nameOf(job.seat)} is switched off` });
}

/** QA passed commit `sha`: classify risk, void earlier reviews, and start the two-reviewer flow. */
export async function afterQaPass(ticket, sha) {
  let files = null;
  try { ({ files } = await runner.stageApproved(ticket.key, runner.workspaceDir(ticket.key), sha)); }
  catch (err) { store.logEvent({ ticket_key: ticket.key, kind: 'error', text: `risk classifier could not read the diff: ${err.message}` }); }
  const c = classifyDiff(files);
  store.kvSet(`diff-risk:${ticket.key}`, JSON.stringify(c.hits.slice(0, 20)));
  store.kvSet(`diff-files:${ticket.key}`, JSON.stringify(Array.isArray(files) ? files.slice(0, 2000) : null)); // deploy classification
  store.supersedeReviews(ticket.key, null); // a new QA-approved commit voids every earlier verdict
  setStatus(ticket.key, 'review', { head_sha: sha, qa_sha: sha, diff_risk: c.risk, review_stage: 'reviewing', progress: 95, progress_msg: 'QA passed — code review next' });
  const job = advance(ticket.key);
  if (job) store.updateTicket(ticket.key, { progress_msg: `QA passed — ${nameOf(job.seat)} reviewing` });
  return store.getTicket(ticket.key);
}

function approved(t, ctx, ind) {
  const names = `${nameOf(ctx.seat)} and ${nameOf(ind.seat)}`;
  const policy = autoMergePolicy(t);
  const next = policy.eligible ? 'SigmaDesk merges it next once CI is green (if it redeploys something during market hours, it is scheduled for the end of the window).' : `Waiting for the owner to merge: ${policy.reason}.`;
  const text = `✅ **Two approvals at \`${short(t.head_sha)}\`** — ${nameOf(ctx.seat)} (${roleOf(ctx.seat)}, ${whyContext(t, ctx.seat)}) and ${nameOf(ind.seat)} (${roleOf(ind.seat)}, independent). ${next}`;
  store.transaction(() => {
  store.enqueueOutbox(t.key, `${t.key}:approved:${t.head_sha}`, `${text}${footer(t, t.head_sha)}`);
  store.addComment(t.key, 'system', text);
  setStatus(t.key, 'ready_for_human', { review_stage: 'approved', progress: 100, approved_at: t.approved_at || store.now(),
    reconfirm_from: null, reconfirm_kind: null, reconfirm_base: null,
    progress_msg: policy.eligible ? `Approved by ${names} — queued to merge` : `Approved by ${names} — waiting for your merge (${policy.reason})` });
  });
  github.flushOutbox();
}

// ---------------- findings ----------------
export function parseFindings(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { need(false, '--findings must be a JSON array (see the prompt for the shape)'); } }
  need(Array.isArray(list) && list.length > 0, '--findings must be a non-empty JSON array');
  need(list.length <= 20, 'at most 20 findings — group related ones');
  return list.map((f, i) => {
    need(f && typeof f === 'object', `finding ${i + 1} must be an object`);
    const problem = String(f.problem || '').trim();
    need(problem, `finding ${i + 1} needs "problem"`);
    const line = Number(f.line);
    return { file: f.file ? String(f.file).slice(0, 300) : null, line: Number.isInteger(line) && line > 0 ? line : null, problem: problem.slice(0, 2000),
      why: String(f.why_it_matters || f.why || '').trim().slice(0, 2000), fix: String(f.suggested_fix || f.fix || '').trim().slice(0, 2000), blocking: f.blocking !== false };
  });
}
const where = (f) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : 'General');

export function threadFor(key) {
  return store.listFindings(key).map((f) => {
    const answer = f.response === 'fixed' ? `fixed in ${short(f.response_sha)}: ${f.response_body}` : f.response === 'pushback' ? `pushed back: ${f.response_body}` : 'no answer yet';
    return `[${f.id}] ${nameOf(f.seat)}${f.blocking ? '' : ' (suggestion)'} · ${where(f).replace(/`/g, '')} — ${f.problem}\n    → ${nameOf(store.getTicket(key)?.assignee)}: ${answer} [${f.resolution}]`;
  }).join('\n');
}
const openFindings = (key) => store.listFindings(key).filter((f) => f.resolution === 'open');

// ---------------- desk commands ----------------
/** `desk review approve|changes --code N ...` from a pr_review run. */
export function reviewVerdict(run, t, body) {
  need(t && t.key === run.ticket_key && run.kind === 'pr_review', 'you are not reviewing this ticket');
  need(t.status === 'review' && t.review_stage === 'reviewing', 'this ticket is not waiting for a code review');
  need(run.nonce && body.code === run.nonce, 'missing or wrong --code (it is in your instructions)');
  const row = store.listPrReviews(t.key).find((r) => r.run_id === run.id && r.nonce === run.nonce);
  need(row && row.seat === run.agent_id, 'no review assignment is bound to this run');
  need(!store.contributorsOf(t).has(row.seat), 'you wrote code for this change, so you cannot review it');
  need(row.state === 'active' && row.verdict === 'pending', 'this review was already recorded or is out of date');
  need(row.sha === t.head_sha, `the change moved since your review started (${short(row.sha)} → ${short(t.head_sha)}); your verdict no longer applies`);
  need(row.round === (t.review_round || 0), 'this review round is over');
  need(['approve', 'changes'].includes(body.verdict), 'verdict approve|changes');
  const summary = store.redact(String(body.body || '').trim()).slice(0, 4000);
  need(summary, 'a short summary is required');
  const author = t.assignee;

  if (body.verdict === 'approve') {
    const checked = String(body.checked || '').trim().slice(0, 3000);
    need(checked.length >= 15, 'say concretely what you checked (--checked "...")');
    const risks = String(body.risks || '').trim().slice(0, 3000) || 'None noted.';
    const earlier = store.listFindings(t.key).filter((f) => f.seat === row.seat && f.resolution === 'open');
    const resolved = earlier.length ? `\n\n**Earlier points now settled:** ${earlier.map((f) => `${f.id} (${f.response === 'pushback' ? 'accepted the pushback' : f.response === 'fixed' ? 'fix verified' : 'dropped'})`).join(', ')}.` : '';
    const text = `${header(t, row)} · ✅ Approved\n\n${summary}\n\n**What I checked:** ${checked}\n**Risks I still see:** ${risks}${resolved}`;
    // The verdict and its PR comment commit together: a crash can never leave an approval without its comment.
    store.transaction(() => {
      store.updatePrReview(row.id, { verdict: 'approve', body: summary, checked, risks });
      for (const f of earlier) store.updateFinding(f.id, { resolution: 'resolved' });
      store.enqueueOutbox(t.key, `${t.key}:review:${row.id}`, `${text}${footer(t, row.sha, ` · review round ${row.round + 1}`)}`, row.id);
      store.addComment(t.key, row.seat, text);
    });
    store.logEvent({ run_id: run.id, agent_id: row.seat, ticket_key: t.key, kind: 'action', text: `approved ${t.key} at ${short(row.sha)} (${row.role} reviewer)` });
    const next = advance(t.key);
    if (next?.kind === 'pr_review') store.updateTicket(t.key, { progress_msg: `${nameOf(row.seat)} approved — ${nameOf(next.seat)} reviewing next` });
    github.flushOutbox();
    return 'Approval recorded. Stop now.';
  }

  const findings = parseFindings(body.findings);
  need(findings.some((f) => f.blocking), 'no blocking findings — approve instead and list the suggestions under --risks');
  const round = (t.review_round || 0) + 1;
  const earlier = store.listFindings(t.key).filter((f) => f.seat === row.seat && f.resolution === 'open');
  const ids = findings.map((_, i) => `R${row.id}-${i + 1}`);
  const blocking = findings.filter((f) => f.blocking).length;
  const list = findings.map((f, i) => `${i + 1}. ${where(f)} — ${f.problem}${f.why ? `\n   *Why it matters:* ${f.why}` : ''}${f.fix ? `\n   *Suggested fix:* ${f.fix}` : ''}\n   <sub>${ids[i]} · ${f.blocking ? 'must be fixed or answered' : 'suggestion, optional'}</sub>`).join('\n');
  const text = `${header(t, row)} · ✏️ Changes requested — ${blocking} ${blocking === 1 ? 'thing' : 'things'} to fix${findings.length > blocking ? ` (+${findings.length - blocking} optional)` : ''}:\n\n${list}\n\n${summary}`;
  store.transaction(() => {
    store.updatePrReview(row.id, { verdict: 'changes', body: summary, findings_json: JSON.stringify(findings) });
    for (const f of earlier) store.updateFinding(f.id, { resolution: 'superseded' });
    findings.forEach((f, i) => store.addFinding({ ...f, id: ids[i], review_id: row.id, ticket_key: t.key, seat: row.seat }));
    store.updateTicket(t.key, { review_round: round, review_stage: 'responding', reconfirm_from: null, reconfirm_kind: null, reconfirm_base: null }); // next look is a full review
    store.enqueueOutbox(t.key, `${t.key}:review:${row.id}`, `${text}${footer(t, row.sha, ` · review round ${row.round + 1}`)}`, row.id);
    store.addComment(t.key, row.seat, text);
  });
  store.logEvent({ run_id: run.id, agent_id: row.seat, ticket_key: t.key, kind: 'action', text: `requested ${blocking} change(s) on ${t.key} (${row.role} reviewer, round ${round})` });
  const cap = Number(config.review.maxRounds ?? 3);
  if (round > cap) {
    const open = openFindings(t.key).filter((f) => f.blocking);
    const pushed = store.listFindings(t.key).filter((f) => f.response === 'pushback').slice(-4);
    const summaryText = [`🧭 **Your call: the review has gone ${round} rounds** (limit ${cap}).`,
      `${nameOf(row.seat)} (${roleOf(row.seat)}) still wants changes; ${nameOf(author)} (${roleOf(author)}) built it.`,
      open.length ? `**Still asked for:**\n${open.map((f) => `- ${where(f)} — ${f.problem}`).join('\n')}` : '',
      pushed.length ? `**What ${nameOf(author)} argued earlier:**\n${pushed.map((f) => `- ${f.id}: ${f.response_body}`).join('\n')}` : '',
      `Reply with your decision (e.g. "do what ${nameOf(row.seat)} asks" or "${nameOf(author)} is right, approve as is") — ${nameOf(author)} then answers the review with your guidance; or merge from the PR page with an override reason.`].filter(Boolean).join('\n\n');
    store.transaction(() => {
      store.addComment(t.key, 'system', summaryText);
      store.enqueueOutbox(t.key, `${t.key}:cap:${row.id}`, `${summaryText}${footer(t, row.sha)}`);
      setStatus(t.key, 'needs_human', { resume_status: 'review', progress_msg: `Reviewers and ${nameOf(author)} disagree — your call` });
    });
  } else {
    store.updateTicket(t.key, { progress_msg: `${nameOf(row.seat)} requested ${blocking} change${blocking === 1 ? '' : 's'} — ${nameOf(author)} is responding` });
  }
  github.flushOutbox();
  return 'Recorded. Stop now.';
}

/** `desk respond fixed|pushback --finding ID "..."` and `desk respond done "..."` from the author's respond run. */
export async function respond(run, t, body) {
  need(t && t.key === run.ticket_key && run.kind === 'respond' && run.agent_id === t.assignee, 'only the author answers the review, from a respond run');
  need(t.status === 'review' && t.review_stage === 'responding', 'no review feedback is waiting for your answer');
  need(['fixed', 'pushback', 'done'].includes(body.action), 'desk respond fixed|pushback --finding ID "<text>"  |  desk respond done "<summary>"');
  const text = store.redact(String(body.body || '').trim()).slice(0, 4000);
  need(text, 'say what you did (or why not)');
  const dir = runner.workspaceDir(t.key);
  const head = await runner.headSha(dir);
  if (body.action !== 'done') {
    const f = store.getFinding(String(body.finding || ''));
    need(f && f.ticket_key === t.key && f.resolution === 'open', `unknown or closed finding id ${body.finding || '(missing --finding)'}`);
    need(!f.response, `you already answered ${f.id}`);
    if (body.action === 'fixed') need(head !== t.head_sha, 'commit the fix first (git add + git commit) — HEAD is still the reviewed commit');
    const reply = `**${nameOf(t.assignee)} — ${roleOf(t.assignee)}** replying to ${nameOf(f.seat)} on ${f.id} (${where(f)}):\n\n${body.action === 'fixed' ? `Fixed in \`${short(head)}\`: ${text}` : `Pushing back: ${text}`}`;
    store.transaction(() => {
      store.updateFinding(f.id, { response: body.action, response_body: text, response_sha: body.action === 'fixed' ? head : t.head_sha });
      store.enqueueOutbox(t.key, `${t.key}:reply:${f.id}`, `${reply}${footer(t, body.action === 'fixed' ? head : t.head_sha)}`);
      store.addComment(t.key, t.assignee, reply);
      if (body.action === 'fixed') store.addContributor(t.key, t.assignee);
    });
    const left = openFindings(t.key).filter((x) => x.blocking && !x.response).length;
    return `Recorded your answer to ${f.id}. ${left ? `${left} blocking point(s) still need an answer.` : 'Every blocking point is answered — finish with desk respond done "<summary>".'}`;
  }
  const open = openFindings(t.key);
  const missing = open.filter((f) => f.blocking && !f.response);
  need(!missing.length, `answer these first: ${missing.map((f) => f.id).join(', ')}`);
  const moved = head !== t.head_sha;
  if (moved) {
    need(await runner.commitsAhead(dir) > 0, 'no commits on your branch');
    const msg = `🔧 **${nameOf(t.assignee)} answered the review** with new commits (now \`${short(head)}\`): ${text}\n\nQA re-checks the new commit, then both reviewers look again — earlier approvals no longer count because the code changed.`;
    store.transaction(() => {
      store.supersedeReviews(t.key, null); // the code changed: both approvals are void
      store.addContributor(t.key, t.assignee);
      store.addComment(t.key, t.assignee, msg);
      store.enqueueOutbox(t.key, `${t.key}:respond:${head}`, `${msg}${footer(t, head)}`);
      setStatus(t.key, 'qa', { head_sha: head, review_stage: null, progress: 90, progress_msg: 'review fixes committed — QA re-checking' });
    });
    github.flushOutbox();
    return 'Submitted to QA with your fixes. Your run is complete — stop now.';
  }
  need(!open.some((f) => f.response === 'fixed'), 'you reported fixes, but HEAD is back at the reviewed commit — commit them or answer with pushback');
  const askers = [...new Set(open.filter((f) => f.response).map((f) => f.review_id))].map((id) => store.getPrReview(id)).filter(Boolean);
  const msg = `💬 **${nameOf(t.assignee)} answered the review without code changes**: ${text}\n\n${askers.map((r) => nameOf(r.seat)).join(' and ')} will read the answers and approve or hold.`;
  store.transaction(() => {
    for (const r of askers) store.createPrReview({ ticket_key: t.key, seat: r.seat, role: r.role, sha: t.head_sha, round: t.review_round || 0 });
    store.updateTicket(t.key, { review_stage: 'reviewing', progress_msg: `${nameOf(t.assignee)} pushed back — ${askers.map((r) => nameOf(r.seat)).join(' and ')} re-reviewing` });
    store.addComment(t.key, t.assignee, msg);
    store.enqueueOutbox(t.key, `${t.key}:respond:pushback:${askers.map((r) => r.id).join('-')}`, `${msg}${footer(t, t.head_sha)}`);
  });
  github.flushOutbox();
  return 'Recorded. The reviewer will reply. Stop now.';
}

// ---------------- prompts + snapshots ----------------
export async function prepareSnapshot(t, seat) {
  await runner.stageApproved(t.key, runner.workspaceDir(t.key), t.head_sha); // publisher must hold the reviewed commit
  return runner.reviewSnapshot(t.key, seat, t.head_sha);
}
export function reviewPrompt(t, row, code, reconfirm = null) {
  const why = row.role === 'context' ? whyContext(t, row.seat) : 'a senior/principal who neither built nor designed it';
  return promptFor('pr_review', { ticket: t, comments: store.listComments(t.key).slice(-12),
    extra: { code, role: row.role, why, sha: row.sha, author: `${nameOf(t.assignee)} (${roleOf(t.assignee)})`, thread: threadFor(t.key), reconfirm } });
}
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);
/**
 * Light re-confirm after the desk rebased the approved change or the builder resolved a conflict: what changed since
 * the approved commit (range-diff; for a resolution also how the conflicts were resolved and what came in from base).
 */
export async function reconfirmContext(t) {
  if (!t.reconfirm_from || !t.reconfirm_kind) return null;
  return runner.withPublisher(async (pgit) => {
    const from = t.reconfirm_from; const head = t.head_sha; const base = t.reconfirm_base;
    const oldBase = (await pgit(['merge-base', from, base])).stdout.trim();
    const newBase = (await pgit(['merge-base', head, base])).stdout.trim();
    const range = oldBase && newBase ? (await pgit(['range-diff', '--no-color', `${oldBase}..${from}`, `${newBase}..${head}`])).stdout : '';
    let resolution = ''; let incoming = '';
    if (t.reconfirm_kind === 'resolution') {
      resolution = (await pgit(['show', '--no-color', '--remerge-diff', '--format=%h %s', head])).stdout;
      const files = (await pgit(['diff', '--name-only', '-z', oldBase, base])).stdout.split('\0').filter(Boolean);
      const mine = new Set((await pgit(['diff', '--name-only', '-z', oldBase, from])).stdout.split('\0').filter(Boolean));
      const overlap = files.filter((f) => mine.has(f));
      if (overlap.length) incoming = (await pgit(['diff', '--no-color', oldBase, base, '--', ...overlap.slice(0, 30)])).stdout;
    }
    return { kind: t.reconfirm_kind, from, rangeDiff: cut(range, 10000) || '(no difference in the PR\'s own commits)', resolution: cut(resolution, 8000), incoming: cut(incoming, 6000) };
  }).catch(() => null);
}
export function respondPrompt(t) {
  const open = openFindings(t.key);
  const findings = open.map((f) => `[${f.id}] ${f.blocking ? 'BLOCKING' : 'optional'} · ${nameOf(f.seat)} · ${where(f).replace(/`/g, '')}\n  Problem: ${f.problem}${f.why ? `\n  Why it matters: ${f.why}` : ''}${f.fix ? `\n  Suggested fix: ${f.fix}` : ''}${f.response ? `\n  (already answered: ${f.response})` : ''}`).join('\n');
  const reviewers = [...new Set(open.map((f) => nameOf(f.seat)))].join(' and ') || 'the reviewers';
  return promptFor('respond', { ticket: t, comments: store.listComments(t.key).slice(-12), extra: { findings, reviewer: reviewers } });
}

// ---------------- API view (v2 UI renders this) ----------------
export function summary(key) {
  const t = store.getTicket(key);
  if (!t) return null;
  const rows = store.listPrReviews(key);
  const ap = store.approvalsAt(key, t.head_sha);
  const policy = autoMergePolicy(t);
  return {
    enabled: enabled(), stage: t.review_stage || null, round: t.review_round || 0, max_rounds: Number(config.review.maxRounds ?? 3),
    risk: t.risk || null, diff_risk: t.diff_risk || null, diff_risk_paths: diffHits(key), auto_merge: policy,
    context: t.reviewer_context ? { seat: t.reviewer_context, name: nameOf(t.reviewer_context), role: roleOf(t.reviewer_context), why: whyContext(t, t.reviewer_context) } : null,
    independent: t.reviewer_independent ? { seat: t.reviewer_independent, name: nameOf(t.reviewer_independent), role: roleOf(t.reviewer_independent) } : null,
    approvals_ok: ap.ok, unpublished_comments: ap.unpublished,
    reviews: rows.map((r) => ({ id: r.id, seat: r.seat, name: nameOf(r.seat), role: r.role, verdict: r.verdict, sha: r.sha, round: r.round, state: r.state,
      summary: r.body, checked: r.checked, risks: r.risks, published: !!r.published_comment_id, at: r.updated_at })),
    findings: store.listFindings(key).map((f) => ({ id: f.id, seat: f.seat, name: nameOf(f.seat), file: f.file, line: f.line, problem: f.problem, why_it_matters: f.why,
      suggested_fix: f.fix, blocking: !!f.blocking, response: f.response, response_body: f.response_body, response_sha: f.response_sha, resolution: f.resolution })),
  };
}

// Auto-merge, scheduling and the conflict sweep live in mergetrain.js (#3).
