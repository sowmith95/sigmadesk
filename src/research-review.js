// Second-person review gate for research proposals. A proposal filed by a research run is invisible to grooming until
// `minReviewers` distinct seats, none of them the author, have passed it. State is versioned: each revision opens a new
// generation, and a verdict counts only for its own assignment and the generation it was given for. The owner can waive
// the gate (audited) or decide a held proposal; nothing else bypasses it.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as research from './research.js';
import { agentById, promptFor } from './team.js';

export const STATES = ['pending', 'passed', 'changes', 'held', 'waived'];
const MAX_REVISIONS = 1;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// The scheduler installs its setStatus (GitHub sync, notifications, roll-ups); tests may run with the plain store.
export const hooks = { setStatus: (key, status, extra = {}) => store.updateTicket(key, { status, ...extra }) };

export const hashOf = (t) => crypto.createHash('sha256').update(JSON.stringify([t.title, t.description])).digest('hex');
export const extractSources = (text) => [...new Set((String(text || '').match(/https?:\/\/[^\s)>\]"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 40);
export const gated = (t) => !!t && t.source === 'research' && !!t.research_review;
export const blocks = (t) => gated(t) && ['pending', 'changes', 'held'].includes(t.research_review);
export const held = (t) => gated(t) && t.research_review === 'held';
const parse = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
export const policyOf = (t) => parse(t.research_policy, null) || { minReviewers: config.research.review.minReviewers, reviewers: [...config.research.review.reviewers], web: true, sources: [] };
const current = (t) => store.listResearchReviews(t.key).filter((r) => r.generation === t.research_generation);
const passes = (t) => current(t).filter((r) => r.status === 'complete' && r.verdict === 'pass').length;
export const needed = (t) => Math.max(0, policyOf(t).minReviewers - passes(t));

// Called by `desk propose` inside a research run: freeze the review policy on the ticket and open generation 1.
export function open(t, job, run) {
  const policy = { minReviewers: job.review?.minReviewers || config.research.review.minReviewers, reviewers: job.review?.reviewers || config.research.review.reviewers, web: job.web !== false, sources: job.sources || [] };
  const row = store.updateTicket(t.key, { research_program: job.program, research_run: run.id, research_policy: JSON.stringify(policy), research_review: 'pending', research_generation: 1, research_revisions: 0, research_sources: JSON.stringify(extractSources(t.description)) });
  store.logEvent({ ticket_key: t.key, agent_id: t.reporter, kind: 'system', text: `research proposal awaits ${policy.minReviewers} independent review${policy.minReviewers === 1 ? '' : 's'} before grooming` });
  return row;
}

// Independence: a different seat always; a different model family when one is available.
export function familyOf(seatId) {
  const a = agentById[seatId];
  if (!a) return 'unknown';
  if (a.engine === 'codex') return 'gpt';
  if (a.engine === 'perplexity') { const id = String(a.model || '').toLowerCase(); for (const [re, f] of [[/kimi/, 'kimi'], [/grok/, 'grok'], [/glm/, 'glm'], [/deepseek/, 'deepseek'], [/gpt|astra|sol/, 'gpt']]) if (re.test(id)) return f; return 'claude'; }
  return 'claude';
}
export function nextReviewer(t) {
  const policy = policyOf(t);
  const taken = new Set(current(t).filter((r) => r.status !== 'cancelled').map((r) => r.reviewer));
  const author = t.reporter, authorFamily = familyOf(author);
  const candidates = policy.reviewers.filter((id) => id !== author && !taken.has(id) && agentById[id] && agentById[id].enabled !== false);
  return [...candidates].sort((a, b) => Number(familyOf(a) === authorFamily) - Number(familyOf(b) === authorFamily))[0] || null;
}
export const inFlight = (t) => current(t).some((r) => ['pending', 'running'].includes(r.status));

// Work for the scheduler: tickets whose next assignment should start now (one reviewer at a time per ticket).
export function nextAssignments() {
  const out = [];
  for (const t of store.ticketsByStatus('proposed')) {
    if (!gated(t) || t.research_review !== 'pending' || t.active_run || inFlight(t)) continue;
    if (needed(t) <= 0) { pass(t); continue; }
    const reviewer = nextReviewer(t);
    if (!reviewer) { hold(t, 'No eligible second reviewer is enabled for this proposal'); continue; }
    out.push({ t, reviewer });
  }
  return out;
}
export const nextRevisions = () => store.ticketsByStatus('proposed').filter((t) => gated(t) && t.research_review === 'changes' && !t.active_run && agentById[t.reporter]?.enabled !== false);
export function assign(t, reviewer) {
  return store.createResearchReview({ ticket_key: t.key, generation: t.research_generation, input_hash: hashOf(t), reviewer, status: 'pending' });
}
export function cancel(id, why = 'cancelled') {
  const a = store.getResearchReview(id);
  if (!a || !['pending', 'running'].includes(a.status)) return;
  if (a.status === 'running' && a.run_id) runner.killRun(a.run_id, `research review ${why}`);
  store.updateResearchReview(id, { status: 'cancelled', error: why, ended_at: store.now() });
}
const cancelOpen = (t, why) => { for (const r of current(t)) if (['pending', 'running'].includes(r.status)) cancel(r.id, why); };

export function parseReport(text) {
  const r = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const list = (k) => Array.isArray(r[k]) && r[k].length <= 20 && r[k].every((v) => typeof v === 'string');
  if (!['pass', 'changes', 'reject'].includes(r?.verdict) || typeof r.summary !== 'string' || !r.summary.trim() || !['evidence_checked', 'findings', 'conditions'].every(list)
    || (r.verdict === 'pass' && r.conditions.length)) throw new Error('Review needs verdict pass|changes|reject, a summary, evidence_checked[], findings[] and conditions[] (a pass has no conditions)');
  if (JSON.stringify(r).length > 8000) throw new Error('Review exceeds the bounded response size');
  return store.redactValue({ verdict: r.verdict, summary: r.summary, evidence_checked: r.evidence_checked, findings: r.findings, conditions: r.conditions });
}

function pass(t) {
  store.updateTicket(t.key, { research_review: 'passed' });
  store.logEvent({ ticket_key: t.key, agent_id: 'system', kind: 'system', text: `research review passed (${passes(t)}/${policyOf(t).minReviewers}); ready for grooming` });
}
function hold(t, reason) {
  store.updateTicket(t.key, { research_review: 'held' });
  hooks.setStatus(t.key, 'needs_human', { resume_status: 'proposed', active_run: null, progress_msg: `Research review: ${reason}`, hold_kind: 'research' });
}
const comment = (t, author, report) => store.addComment(t.key, author, `**Research review · ${report.verdict}** (second reviewer: ${agentById[author]?.name || author})\n\n${report.summary}\n\nEvidence checked: ${report.evidence_checked.join('; ') || 'none stated'}\nFindings: ${report.findings.join('; ') || 'none'}\nConditions: ${report.conditions.join('; ') || 'none'}`);

export function complete(id, { report = null, error = null, run_id = null, providerFailure = false } = {}) {
  const a = store.getResearchReview(id);
  if (!a || !['pending', 'running'].includes(a.status)) return null;
  const t = store.getTicket(a.ticket_key);
  // Stale: the proposal moved on (new generation, edited text, waived or held) while this review ran. Keep it for history only.
  const stale = !t || t.research_generation !== a.generation || hashOf(t) !== a.input_hash || t.research_review !== 'pending';
  if (!report) {
    store.updateResearchReview(id, { status: providerFailure ? 'cancelled' : 'failed', error, run_id, ended_at: store.now() });
    if (!stale && !providerFailure && current(t).filter((r) => r.status === 'failed').length >= 2) hold(t, 'two review attempts failed');
    return store.getResearchReview(id);
  }
  store.transaction(() => {
    store.updateResearchReview(id, { status: 'complete', verdict: report.verdict, report: JSON.stringify(report), run_id, ended_at: store.now() });
    if (t) comment(t, a.reviewer, report);
    if (stale) return;
    const fresh = store.getTicket(t.key);
    if (report.verdict === 'pass') { if (needed(fresh) <= 0) pass(fresh); return; }
    cancelOpen(fresh, 'superseded by a changes/reject verdict');
    if (report.verdict === 'changes' && (fresh.research_revisions || 0) < MAX_REVISIONS) {
      store.updateTicket(fresh.key, { research_review: 'changes' });
      store.logEvent({ ticket_key: fresh.key, agent_id: a.reviewer, kind: 'system', text: 'research review asked for changes; the author gets one revision' });
    } else hold(fresh, report.verdict === 'reject' ? `rejected by ${agentById[a.reviewer]?.name || a.reviewer}: ${report.summary.slice(0, 160)}` : 'changes still requested after the author\'s revision');
  });
  return store.getResearchReview(id);
}

// One reviewer run. The scheduler calls this through its admission path (`go`), which has reserved budget and a slot.
export async function launch(a, fence) {
  const t = store.getTicket(a.ticket_key);
  if (!t || t.research_review !== 'pending' || t.research_generation !== a.generation || hashOf(t) !== a.input_hash) { cancel(a.id, 'proposal changed before the review started'); return; }
  store.updateResearchReview(a.id, { status: 'running' });
  store.updateAgent(a.reviewer, { status: 'working', current_ticket: t.key, current_kind: 'research_review', last_action: 'Reviewing a research proposal', last_action_at: store.now() });
  store.updateTicket(t.key, { active_run: -1 });
  try {
    const cwd = await runner.ensureReadonlyWorkspace(a.reviewer);
    const policy = policyOf(t);
    const prompt = promptFor('research_review', { ticket: t, comments: store.listComments(t.key).slice(-6),
      extra: { author: agentById[t.reporter]?.role || t.reporter, program: t.research_program, sources: policy.sources, sources_cited: parse(t.research_sources, []) } });
    const outcome = await runner.startRun({ agentId: a.reviewer, kind: 'research_review', ticketKey: t.key, cwd, prompt, fence, job: { review: a.id, web: policy.web },
      onStart: (run) => { store.updateResearchReview(a.id, { run_id: run.id }); store.updateTicket(t.key, { active_run: run.id }); } });
    if (outcome.aborted || outcome.run?.status !== 'success') throw Object.assign(new Error(outcome.run?.result_text || 'Review interrupted'), { providerFailure: !!(outcome.failure || outcome.aborted) });
    complete(a.id, { report: parseReport(outcome.result?.result || outcome.run.result_text), run_id: outcome.run.id });
  } catch (e) {
    complete(a.id, { error: store.redact(e.message).slice(0, 500), providerFailure: !!e.providerFailure || !!e.providerUnavailable });
  } finally {
    const now = store.getTicket(t.key);
    if (now?.active_run && (now.active_run === -1 || !store.getRun(now.active_run)?.token)) store.updateTicket(t.key, { active_run: null });
    if (!store.getAgentState(a.reviewer)?.current_run) store.updateAgent(a.reviewer, { status: 'idle', current_ticket: null, current_kind: null });
  }
}

// The author's single bounded revision after a "changes" verdict. The owner's correction notes take precedence.
export function revisionNotes(t) {
  const owner = store.kvGet(`research-notes:${t.key}`);
  if (owner) return owner;
  const last = store.listResearchReviews(t.key).filter((r) => r.status === 'complete' && r.verdict !== 'pass').at(-1);
  const r = last ? parse(last.report, null) : null;
  return r ? `${r.summary}\nFindings: ${r.findings.join('; ') || 'none'}\nConditions: ${r.conditions.join('; ') || 'none'}` : 'Address the reviewer\'s notes on the ticket.';
}
export async function launchRevision(t, fence) {
  const author = t.reporter;
  store.updateAgent(author, { status: 'working', current_ticket: t.key, current_kind: 'research_revision', last_action: 'Revising a proposal after review', last_action_at: store.now() });
  store.updateTicket(t.key, { active_run: -1 });
  let outcome = null;
  try {
    const cwd = await runner.ensureReadonlyWorkspace(author);
    const program = t.research_program ? research.get(t.research_program) : null;
    const policy = policyOf(t);
    const job = program ? { ...research.job(program, { room: 0 }), revise: t.key } : { program: t.research_program, seat: author, maxProposals: 0, proposals: 0, web: policy.web, connectors: [], sources: policy.sources, focus: '', review: policy, revise: t.key };
    outcome = await runner.startRun({ agentId: author, kind: 'research_revision', ticketKey: t.key, cwd, fence, job,
      prompt: promptFor('research_revision', { ticket: t, comments: store.listComments(t.key).slice(-6), extra: revisionNotes(t) }),
      onStart: (run) => store.updateTicket(t.key, { active_run: run.id }) });
  } catch (e) { outcome = { run: null, failure: e.providerUnavailable ? e.message : null, error: e }; }
  finally {
    const now = store.getTicket(t.key);
    if (now?.active_run && (now.active_run === -1 || !store.getRun(now.active_run)?.token)) store.updateTicket(t.key, { active_run: null });
    if (!store.getAgentState(author)?.current_run) store.updateAgent(author, { status: 'idle', current_ticket: null, current_kind: null });
    const after = store.getTicket(t.key);
    // No `desk revise` happened. A provider failure or stop-all keeps the allowance; the author simply failing to revise does not.
    if (after?.research_review === 'changes' && !(outcome?.aborted || outcome?.failure || outcome?.run?.status === 'killed')) hold(after, 'the author did not revise the proposal');
  }
}
export function revise(t, run, { title, body }) {
  if (!(run.kind === 'research_revision' && run.ticket_key === t.key && run.agent_id === t.reporter)) fail('revise only from your own revision run for this proposal');
  if (t.research_review !== 'changes') fail('this proposal is not awaiting a revision');
  const text = String(body || '').trim();
  if (!text || text.length > 20000) fail('revised body required (max 20000 characters)');
  if (!/^## Problem/m.test(text) || !/^## Evidence/m.test(text)) fail('keep the proposal sections: ## Problem, ## Evidence, ## Proposal, ## Acceptance criteria, ## Success metric');
  store.transaction(() => {
    store.updateTicket(t.key, { ...(title ? { title: String(title).slice(0, 200) } : {}), description: text, research_review: 'pending', research_generation: (t.research_generation || 1) + 1,
      research_revisions: (t.research_revisions || 0) + 1, research_sources: JSON.stringify(extractSources(text)) });
    store.kvSet(`research-notes:${t.key}`, '');
    store.addComment(t.key, t.reporter, `✏️ **Proposal revised after review** (generation ${(t.research_generation || 1) + 1}); a fresh second review follows.`);
  });
  return store.getTicket(t.key);
}

// Owner controls: the only bypass is an audited waiver; held proposals get an explicit decision.
export function waive(key, note = '') {
  const t = store.getTicket(key) || fail('no such ticket', 404);
  if (!blocks(t)) fail('this proposal is not waiting on a research review');
  store.transaction(() => {
    cancelOpen(t, 'waived by owner');
    const a = store.createResearchReview({ ticket_key: key, generation: t.research_generation, input_hash: hashOf(t), reviewer: 'owner', status: 'complete' });
    store.updateResearchReview(a.id, { verdict: 'pass', report: JSON.stringify({ verdict: 'pass', summary: note || 'Waived by the owner', evidence_checked: [], findings: [], conditions: [] }), ended_at: store.now() });
    store.updateTicket(key, { research_review: 'waived' });
    store.kvSet(`research-notes:${key}`, '');
    if (t.status === 'needs_human') hooks.setStatus(key, 'proposed', { resume_status: null, progress_msg: 'Research review waived by the owner' });
    store.addComment(key, 'owner', `✅ **Research review waived by the owner**${note ? `\n\n${note}` : ''}\n\nGrooming, product review, QA and merge gates still apply.`);
  });
  store.logEvent({ ticket_key: key, agent_id: 'owner', kind: 'action', text: 'owner waived the second-person research review' });
  return store.getTicket(key);
}
export function ownerDecide(t, decision, note = '') {
  if (!held(t)) fail('this proposal is not held by a research review');
  if (decision === 'approve') return waive(t.key, note);
  if (decision === 'correction') {
    if (!String(note).trim()) fail('Describe the correction so the author can revise');
    store.transaction(() => {
      store.kvSet(`research-notes:${t.key}`, String(note).slice(0, 4000));
      store.updateTicket(t.key, { research_review: 'changes', research_revisions: 0 });
      hooks.setStatus(t.key, 'proposed', { resume_status: null, active_run: null, progress_msg: 'Owner sent the proposal back for revision' });
      store.addComment(t.key, 'owner', `🔁 **Owner sent the proposal back to ${agentById[t.reporter]?.name || t.reporter}**\n\n${note}`);
    });
    return store.getTicket(t.key);
  }
  if (decision === 'reject') {
    store.transaction(() => {
      store.addComment(t.key, 'owner', `⛔ **Research proposal rejected by owner**${note ? `\n\n${note}` : ''}`);
      hooks.setStatus(t.key, 'wontdo', { resume_status: null, active_run: null, progress_msg: 'Rejected by owner after research review' });
    });
    return store.getTicket(t.key);
  }
  fail('invalid decision');
}
export function reasonFor(t) {
  if (!blocks(t)) return null;
  if (t.research_review === 'changes') return `Author revising after the second review`;
  if (t.research_review === 'held') return t.progress_msg || 'Research review held for the owner';
  const running = current(t).find((r) => r.status === 'running');
  return running ? `Second review in progress (${agentById[running.reviewer]?.name || running.reviewer})` : `Awaiting ${needed(t)} independent review${needed(t) === 1 ? '' : 's'}`;
}
export function recover() {
  for (const r of store.openResearchReviews()) store.updateResearchReview(r.id, { status: 'cancelled', error: 'interrupted by a desk restart', ended_at: store.now() });
}
export const forTicket = (key) => store.listResearchReviews(key).map((r) => ({ ...r, report: parse(r.report, null) }));
export function summaries() {
  return store.listTickets().filter((t) => gated(t) && !['done', 'wontdo'].includes(t.status)).map((t) => ({ ticket_key: t.key, state: t.research_review, generation: t.research_generation, revisions: t.research_revisions,
    needed: needed(t), min_reviewers: policyOf(t).minReviewers, program: t.research_program, reason: reasonFor(t), reviews: current(t).map((r) => ({ id: r.id, reviewer: r.reviewer, status: r.status, verdict: r.verdict, created_at: r.created_at, ended_at: r.ended_at })) }));
}
