// The owner's decision, said once and the same in every place it shows (sowmith95/sigmadesk#6). Pure: the server
// gathers the facts (src/decision.js) and this file turns them into one snapshot the Inbox card, the Decision sheet and
// GET /api/tickets/KEY/decision-brief all read. A snapshot describes; it never authorizes. The checks at execution time
// (mergetrain.authorizeMerge, prs.authorizeMerge, the publish guard, the access policy) stay the only gates.
//
// Every fact carries where it came from and how old it is. Anything the desk did not observe says "unknown", and a fact
// about another commit says "stale": nothing is filled in to look complete.
export const BRIEF_VERSION = 1;
const short = (s) => String(s || '').slice(0, 7);
const list = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Minutes between an ISO time and now (null when unknown). */
export function minutesSince(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
}
/** "just now", "12 min", "3 h", "2 d". */
export function ageText(min) {
  if (min == null) return 'unknown';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}
const agoText = (min) => (min == null ? 'at an unknown time' : min < 1 ? 'just now' : `${ageText(min)} ago`);

// ---------------- consequence: what approving actually does ----------------
const isWorkflowFile = (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(String(f));
const base = (f) => String(f).split('/').pop();

/**
 * Deploy targets for detected workflows, ONLY from an explicit `deploy.targets` mapping (workflow file → service or
 * list of services). A workflow without an entry has an unknown target: the desk never guesses one from a name.
 */
export function targetsFor(workflows = [], map = {}) {
  const known = [], unknown = [];
  const m = map && typeof map === 'object' ? map : {};
  for (const w of workflows) {
    const v = m[base(w.file)] ?? m[w.file];
    const services = (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
    if (services.length) known.push({ workflow: w.name, file: w.file, services }); else unknown.push({ workflow: w.name, file: w.file });
  }
  return { known, unknown, services: [...new Set(known.flatMap((k) => k.services))] };
}

/**
 * deploy: null (not checked yet) | { state: 'deploys'|'none'|'unknown', workflows: [{file,name,reason}], reason, files }.
 * → { state, workflows (names), targets (services), target: 'known'|'partial'|'unknown'|'none', workflow_changes, steps }
 */
export function deployConsequence(deploy, { targets: map = {}, files = null } = {}) {
  const changed = (Array.isArray(files) ? files : deploy?.files || []).filter(isWorkflowFile);
  const steps = [];
  const unknown = (text) => { steps.push({ text, tone: 'unknown' }); return { state: 'unknown', workflows: [], targets: [], target: 'unknown', workflow_changes: changed, steps }; };
  if (!deploy) return unknown('Not checked yet which workflows this merge starts. Until it is, the desk treats it as deploying.');
  if (deploy.state === 'refreshing') return unknown('Unknown, refreshing: the last check was for another commit, base or configuration. Until it lands, the desk treats it as deploying.');
  // A change that edits workflow files: only a check of the versions at the approved commit may say anything definite.
  if (changed.length && deploy.workflows_at !== 'head' && deploy.state !== 'unknown')
    return unknown(`It edits ${plural(changed.length, 'workflow file')} (${list(changed.map(base))}): what runs after the merge depends on those new versions, which were not read. The desk treats it as deploying.`);
  const read = changed.length ? `the versions at the approved commit (it edits ${list(changed.map(base))})` : 'the workflows on the base branch';
  if (deploy.state === 'none') {
    steps.push({ text: `No deploying workflow runs for these files: nothing redeploys (checked against ${read}).`, tone: 'ok' });
    return { state: 'none', workflows: [], targets: [], target: 'none', workflow_changes: changed, steps };
  }
  const wfs = deploy.workflows || [];
  if (deploy.state === 'unknown' || !wfs.length) return unknown(`Which workflows run is unknown (${deploy.reason || 'not readable'}). The desk treats it as deploying.`);
  const names = wfs.map((w) => w.name);
  const assumed = wfs.filter((w) => /assuming/.test(w.reason || ''));
  if (assumed.length) return unknown(`Which workflows run is unknown: ${list(assumed.map((w) => w.name))} could not be read. The desk treats it as deploying.`);
  steps.push({ text: `Starts ${list(names)} (expected from ${read}).`, tone: 'deploy' });
  const t = targetsFor(wfs, map);
  let target = 'unknown';
  if (t.known.length && !t.unknown.length) { target = 'known'; steps.push({ text: `Redeploys ${list(t.services)} (deploy.targets).`, tone: 'deploy' }); }
  else if (t.known.length) { target = 'partial'; steps.push({ text: `Redeploys ${list(t.services)}; what ${list(t.unknown.map((u) => u.workflow))} deploys is unknown (no deploy.targets entry).`, tone: 'unknown' }); }
  else steps.push({ text: 'Deployment target unknown: no deploy.targets entry says which service these workflows deploy.', tone: 'unknown' });
  return { state: 'deploys', workflows: names, targets: t.services, target, workflow_changes: changed, steps };
}

// ---------------- evidence freshness ----------------
/** QA: passed THIS commit (current), another one (stale), none, or unknown (no commit recorded). */
export function qaEvidence({ head, qaSha, qaAt, now = Date.now() }) {
  if (!head) return { state: 'unknown', sha: qaSha || null, at: qaAt || null, text: 'No commit recorded yet, so QA cannot be matched to one.' };
  if (qaSha && qaSha === head) { const m = minutesSince(qaAt, now); return { state: 'current', sha: qaSha, at: qaAt || null, age_minutes: m, text: `QA passed ${short(head)}${qaAt ? ` ${agoText(m)}` : ' (time not recorded)'}.` }; }
  if (qaSha) return { state: 'stale', sha: qaSha, at: qaAt || null, text: `QA passed ${short(qaSha)}, not the current commit ${short(head)}.` };
  return { state: 'none', sha: null, at: null, text: `QA has not passed ${short(head)}.` };
}
/** The two code reviews at THIS commit. reviews: { inFlow, context, independent } (rows from pr_reviews or null). */
export function reviewEvidence({ head, inFlow = true, context = null, independent = null, ok = false, unpublished = 0, now = Date.now(), nameOf = (s) => s }) {
  if (!inFlow) return { state: 'none', flow: false, text: 'No desk code review on this change.' };
  if (!head) return { state: 'unknown', text: 'No commit recorded yet.' };
  const rows = [context, independent].filter(Boolean);
  const approved = rows.filter((r) => r.verdict === 'approve');
  const at = rows.map((r) => r.updated_at || r.created_at).filter(Boolean).sort().at(-1) || null;
  const m = minutesSince(at, now);
  if (ok) return { state: 'current', sha: head, at, age_minutes: m, seats: approved.map((r) => r.seat), unpublished,
    text: `2 approvals at ${short(head)} (${list(approved.map((r) => nameOf(r.seat)))}) ${agoText(m)}${unpublished ? `; ${unpublished} not posted on the PR yet` : ''}.` };
  const changes = rows.filter((r) => ['changes', 'request_changes', 'reject'].includes(r.verdict));
  if (changes.length) return { state: 'none', sha: head, at, seats: [], text: `${list(changes.map((r) => nameOf(r.seat)))} asked for changes at ${short(head)}.` };
  return { state: 'none', sha: head, at, seats: approved.map((r) => r.seat), text: `${approved.length} of 2 approvals at ${short(head)}${rows.length > approved.length ? '; a review is in progress' : ''}.` };
}
/** CI as last READ by the desk (GitHub rollup): for this commit, another commit, or never read. */
export function ciEvidence({ head, ci = null, now = Date.now(), baseSha }) {
  if (!ci) return { state: 'unknown', text: 'CI not read yet: the desk has not fetched this PR from GitHub.' };
  const m = minutesSince(ci.at, now);
  const read = `read ${agoText(m)}`;
  // Read before the base branch moved (or without the base it was read against): refreshing, never green.
  if (baseSha !== undefined && (ci.base_sha === undefined || (ci.base_sha || null) !== (baseSha || null)))
    return { state: 'refreshing', sha: ci.sha, at: ci.at, age_minutes: m, checks: ci.checks, text: `Refreshing: CI was ${read}, before the latest move of the base branch.` };
  if (head && ci.sha && ci.sha !== head) return { state: 'stale', sha: ci.sha, at: ci.at, age_minutes: m, checks: ci.checks, text: `CI was read for ${short(ci.sha)}, not the current commit ${short(head)} (${read}).` };
  const what = { passing: 'CI passing', failing: 'CI failing', pending: 'CI still running', none: 'No CI checks reported' }[ci.checks] || `CI ${ci.checks || 'unknown'}`;
  return { state: m != null && m > 60 ? 'old' : 'current', sha: ci.sha || head, at: ci.at, age_minutes: m, checks: ci.checks, mergeable: ci.mergeable || null, text: `${what} (${read}).` };
}

// ---------------- gate: ordered reasons ----------------
// state: ok · yours (it waits for the owner: why it is in the Inbox) · waiting (moves by itself) · blocked · unknown
const G = (id, label, state, text) => ({ id, label, state, text });
function overall(items) {
  const of = (st) => items.filter((g) => g.state === st);
  const [blocked, waiting, unknown] = [of('blocked'), of('waiting'), of('unknown')];
  // Ready only when every predicate is positively satisfied (or is simply yours); otherwise the first reason leads.
  const state = blocked.length ? 'blocked' : waiting.length ? 'waiting' : unknown.length ? 'unknown' : 'ready';
  const said = (g) => (g.text.toLowerCase().startsWith(`${g.label.toLowerCase()} `) ? `${g.text.charAt(0).toUpperCase()}${g.text.slice(1)}` : `${g.label}: ${g.text}`);
  const head = blocked[0] || waiting[0];
  const headline = head ? said(head) : unknown.length ? `Not confirmed: ${list(unknown.map((u) => (/^[A-Z]{2,}$/.test(u.label) ? u.label : u.label.toLowerCase())))} unknown.` : 'Ready for you.';
  return { state, items, headline };
}

const cap = (x) => (x ? `${x.charAt(0).toUpperCase()}${x.slice(1)}` : x);
/**
 * Merge gates, in order: QA, reviews, CI, mergeability, deploy window, deploy lock, merge policy. `live` carries the
 * codes and texts of the LIVE merge predicates (prs.authorizeMerge) evaluated on what the desk last read from GitHub,
 * so the brief and the real merge agree: unpublished approvals wait, unconfirmed mergeability is unknown, missing or
 * old required checks wait. Nothing is green unless its predicate is positively satisfied.
 */
export function mergeGate({ qa, reviews, ci, deploy, busy = false, windowEnd = null, lock = null, policy = null, hold = null, live = null }) {
  const codes = live?.codes || [];
  const has = (c) => codes.includes(c);
  const said = (c, fallback) => { const i = codes.indexOf(c); return cap(String(i >= 0 && live.blockers?.[i] ? live.blockers[i] : fallback).replace(/ — or give an owner override reason.*$/, '')) + (/[.!?]$/.test(String(i >= 0 ? live.blockers[i] : fallback)) ? '' : '.'); };
  const items = [];
  items.push(has('qa') ? G('qa', 'QA', 'blocked', qa.text) : G('qa', 'QA', qa.state === 'current' ? 'ok' : qa.state === 'unknown' ? 'unknown' : 'blocked', qa.text));
  if (reviews.flow === false) items.push(G('reviews', 'Reviews', 'yours', reviews.text));
  else if (has('approvals') || (reviews.state !== 'current' && reviews.state !== 'unknown')) items.push(G('reviews', 'Reviews', 'blocked', reviews.text));
  else if (has('unpublished') || reviews.unpublished) items.push(G('reviews', 'Reviews', 'waiting', `${reviews.text} The review comments are not on the PR yet; the merge waits for them.`));
  else items.push(G('reviews', 'Reviews', reviews.state === 'current' ? 'ok' : 'unknown', reviews.text));
  if (ci.state === 'unknown') items.push(G('ci', 'CI', 'unknown', ci.text));
  else if (ci.state === 'stale') items.push(G('ci', 'CI', 'unknown', `${ci.text} Re-reading before it counts.`));
  else if (ci.state === 'refreshing') items.push(G('ci', 'CI', 'unknown', ci.text));
  else if (!live || !live.rolled) items.push(G('ci', 'CI', 'unknown', `${ci.text} The individual checks were not recorded, so the required ones cannot be confirmed.`));
  else if (['ci_failing', 'ci_inconclusive', 'ci_gap'].find(has)) items.push(G('ci', 'CI', 'blocked', said(['ci_failing', 'ci_inconclusive', 'ci_gap'].find(has))));
  else if (['ci_pending', 'ci_none', 'required_missing'].find(has)) items.push(G('ci', 'CI', 'waiting', said(['ci_pending', 'ci_none', 'required_missing'].find(has))));
  else if (ci.state === 'old') items.push(G('ci', 'CI', 'waiting', `${ci.text} Old evidence: it is read again before the merge counts it.`));
  else items.push(G('ci', 'CI', 'ok', `${ci.text}${live.required?.length ? ` Required: ${list(live.required)}.` : ''}`));
  if (has('pr_state') || has('base')) items.push(G('pr', 'Pull request', 'blocked', said(has('pr_state') ? 'pr_state' : 'base')));
  if (has('conflict') || ci.mergeable === 'CONFLICTING') items.push(G('conflicts', 'Conflicts', 'blocked', 'It conflicts with the base branch; the builder resolves it first.'));
  else if (!live || has('mergeable_unknown')) items.push(G('mergeable', 'Mergeability', 'unknown', 'GitHub has not confirmed that it merges cleanly.'));
  const deploying = deploy.state !== 'none';
  if (deploying && busy) items.push(G('deploy_window', 'Deploy window', 'blocked', `Inside the busy window${windowEnd ? ` until ${windowEnd}` : ''}: a deploying merge now needs the market-hours override, or wait.`));
  else items.push(G('deploy_window', 'Deploy window', 'ok', deploying ? 'Outside the busy window.' : 'Nothing deploys, so the busy window does not apply.'));
  if (deploying && lock) {
    const running = ['running', 'merging'].includes(lock.state);
    items.push(G('deploy_lock', 'Deploy lock', running ? 'waiting' : 'blocked', running ? `The deploy of ${lock.key || 'the last merge'} is still running; deploying merges go one at a time.`
      : `The last deploy (${lock.key || 'last merge'}) ${lock.state === 'failed' ? 'failed' : 'was never confirmed'}: check it and clear the hold, or merge with a reason.`));
  }
  if (hold) items.push(G('hold', 'Hold', 'yours', `On hold: ${hold}.`));
  items.push(G('policy', 'Merge policy', policy?.eligible ? 'ok' : 'yours', policy?.eligible ? 'Low risk: the desk may merge it by itself once every check passes.' : `Needs your merge: ${policy?.reason || 'risk or policy'}.`));
  return overall(items);
}
/** Publish gates: QA, the publish guard, and whether publishing is switched on at all. */
export function publishGate({ qa, guard = false, guardReasons = [], githubSync = true, draftPrs = true }) {
  const items = [G('qa', 'QA', qa.state === 'current' ? 'ok' : qa.state === 'unknown' ? 'unknown' : 'blocked', qa.text)];
  if (guard) items.push(G('guard', 'Publish guard', 'yours', guardReasons.length ? `Held before pushing: ${guardReasons.join('; ')}.` : 'It touches protected paths or is unusually large.'));
  if (!githubSync || !draftPrs) items.push(G('publishing', 'Publishing', 'blocked', `${!githubSync ? 'GitHub sync' : 'Draft PRs'} is off (Settings → GitHub): approving records it, but nothing is pushed until it is on.`));
  return overall(items);
}
/** A production read access request: the policy's reasons it came to the owner, in order. */
export function accessGate({ violations = [], opsOn = true }) {
  const items = [];
  if (!opsOn) items.push(G('ops', 'Production read access', 'blocked', 'Production read access is off (Settings): a grant would not let any probe run until it is on.'));
  items.push(G('policy', 'Access policy', 'yours', violations.length ? `Beyond the policy: ${violations.join('; ')}.` : 'No agent approver is available within the policy.'));
  return overall(items);
}
/** Anything else waits only for the owner, unless a run is still finishing. */
export function simpleGate({ running = false, text = 'Only your answer is missing.' }) {
  return overall([running ? G('run', 'Run', 'waiting', 'The worker is finishing; the decision unlocks when its run settles.') : G('you', 'You', 'yours', text)]);
}

// ---------------- the snapshot ----------------
/**
 * One decision → its brief. `facts` (all optional, gathered by src/decision.js):
 *   ticket, decision (board item), base, pr, since, now, releases [{key,name,status}], qa, reviews, ci, deploy, targets,
 *   files, busy, windowEnd, lock, policy (autoMergePolicy), mergeState, guardReasons, settings, access {violations,opsOn},
 *   autoMerge {enabled, excludeRiskHigh}, deployWaitMinutes, policyVersion, nameOf
 */
export function brief(facts) {
  const { decision: d, ticket: t = null, base: baseBranch = 'main', now = Date.now(), nameOf = (s) => s, settings = {} } = facts;
  const kind = d.kind || 'question';
  const head = t?.head_sha || null;
  const name = d.name || t?.title || d.key;
  const since = facts.since || null;
  const waitMin = minutesSince(since, now);
  const releases = facts.releases || [];
  const out = {
    version: BRIEF_VERSION, id: d.id, key: d.key, kind, generated_at: new Date(now).toISOString(), policy_version: facts.policyVersion || null,
    you_decide: d.verb || name,
    wait: { since, minutes: waitMin, text: since ? `waiting ${ageText(waitMin)}` : 'waiting time unknown' },
    releases: { tickets: releases, text: releases.length ? `Unblocks ${plural(releases.length, 'task')}: ${list(releases.slice(0, 3).map((r) => r.name))}${releases.length > 3 ? ` and ${releases.length - 3} more` : ''}.` : 'Nothing else waits on it.' },
    evidence: { head_sha: head, base_sha: facts.baseSha || null },
  };
  const qa = qaEvidence({ head, qaSha: t?.qa_sha, qaAt: facts.qaAt, now });
  if (kind === 'merge') {
    const reviews = reviewEvidence({ head, now, nameOf, ...(facts.reviews || {}) });
    const ci = ciEvidence({ head, ci: facts.ci, now, baseSha: facts.baseSha ?? null });
    const dep = deployConsequence(facts.deploy || null, { targets: facts.targets, files: facts.files });
    const n = facts.pr || null;
    out.you_decide = d.verb && /^Release/.test(d.verb) ? d.verb : `Merge ${name} into ${baseBranch}`;
    out.consequence = { summary: [`Merges${n ? ` PR #${n}` : ''} into ${baseBranch}`, dep.state === 'none' ? 'nothing redeploys'
      : dep.state === 'unknown' ? 'what it starts is unknown' : `starts ${list(dep.workflows)}`, dep.state === 'deploys' ? (dep.target === 'known' ? `redeploys ${list(dep.targets)}` : 'deployment target unknown') : null].filter(Boolean).join(' → '),
    steps: [{ text: `Merges${n ? ` PR #${n}` : ''} into ${baseBranch}${head ? ` at ${short(head)}` : ''}.`, tone: 'ok' }, ...dep.steps], deploy: dep };
    out.gate = mergeGate({ qa, reviews, ci, deploy: dep, busy: facts.busy, windowEnd: facts.windowEnd, lock: facts.lock, policy: facts.policy, hold: t?.merge_hold || null, live: facts.live || null });
    out.evidence = { ...out.evidence, qa, reviews, ci };
    const human = [];
    if (dep.state !== 'none') human.push(`Watching the deploy: the desk waits up to ${facts.deployWaitMinutes || 45} min for its run, and a failed or unconfirmed deploy comes back to you and holds every deploying merge.`);
    if (dep.state === 'deploys' && dep.target !== 'known') human.push('Knowing what it redeployed: no deploy.targets mapping names the service.');
    if (dep.state === 'unknown') human.push('Checking what actually ran: the desk could not tell which workflows this merge starts.');
    human.push(dep.state === 'none' ? 'Nothing to watch after the merge: no workflow redeploys these files.' : 'Production behaviour: nothing checks it by itself after the deploy. Ask “Verify in production” once it is out.');
    out.human = human;
  } else if (kind === 'publish' || kind === 'guard') {
    const reasons = facts.guardReasons || [];
    out.you_decide = kind === 'guard' ? `Approve publishing ${name} past the publish guard` : `Publish ${name}`;
    const steps = [{ text: `Pushes ${t?.branch ? `branch ${t.branch}` : 'the branch'}${head ? ` at ${short(head)}` : ''} and opens a draft PR. Nothing merges.`, tone: 'ok' },
      { text: 'Pull-request CI runs on the pushed commit; then two code reviewers check this exact commit.', tone: 'ok' }];
    const wf = (facts.files || []).filter(isWorkflowFile);
    if (wf.length) steps.push({ text: `It edits ${list(wf.map(base))}: once pushed, that workflow code runs on your CI runners with the repository's secrets.`, tone: 'deploy' });
    out.consequence = { summary: 'Pushes the branch → opens a draft PR → CI and two reviews. Nothing merges.', steps };
    out.gate = publishGate({ qa, guard: kind === 'guard', guardReasons: reasons, githubSync: settings.github_sync !== 'false', draftPrs: settings.open_draft_prs !== 'false' });
    out.evidence = { ...out.evidence, qa };
    const am = facts.autoMerge || {};
    out.human = [am.enabled ? `The merge, if it is high or unknown risk${am.excludeRiskHigh === false ? ' (your config lets the desk merge high-risk work too)' : ''}: low-risk work that passes QA, two reviews and CI merges by itself.` : 'The merge: automatic merging is off, so every merge is yours.'];
  } else if (kind === 'deploy') {
    const lock = d.deploy || facts.lock || {};
    out.you_decide = d.verb;
    out.consequence = { summary: 'Clears the deploy hold → the next deploying merge may go.', steps: [{ text: 'Clears the deploy hold. Nothing is redeployed or rolled back by clearing it.', tone: 'ok' },
      { text: `Deploying merges continue one at a time${facts.pending ? ` (${plural(facts.pending, 'merge')} queued)` : ''}.`, tone: 'deploy' }] };
    out.gate = overall([G('deploy', 'Deploy', 'yours', `${lock.state === 'failed' ? 'Its deploy run failed' : 'Its deploy run was never confirmed'}${lock.note ? `: ${lock.note}` : ''}. Check the runs first.`)]);
    out.human = ['Whether production is healthy: clearing the hold only lets the next deploying merge go.'];
  } else if (kind === 'access') {
    const r = d.access || {};
    out.you_decide = d.verb;
    out.consequence = { summary: `Gives ${d.name} read-only production probes${r.ticket_key ? ` for ${r.ticket_key}` : r.minutes ? ` for ${r.minutes} min` : ''}.`,
      steps: [{ text: `${d.name} may run the read-only probes${Array.isArray(r.probes) && !r.probes.includes('*') ? ` ${list(r.probes)}` : ''}. Writes, restarts and deploys stay impossible.`, tone: 'ok' },
        { text: 'Every probe re-checks the grant; revoking it stops probes in flight.', tone: 'ok' }] };
    out.gate = accessGate(facts.access || {});
    out.human = ['Revoking it early (Settings → Production access) if the work ends sooner.'];
  } else {
    const steps = {
      question: [`${d.worker ? nameOf(d.worker) : t?.assignee ? nameOf(t.assignee) : 'The engineer'} resumes with your answer.`, 'QA and two code reviews still gate whatever comes next.'],
      conflict: ['The engineer combines both sides the way you say; QA and both reviewers re-confirm.'],
      setup: ['The paused step resumes once the seat or setup is fixed.'], refresh: ['The branch moves onto the latest code; QA runs again.'],
      stuck: ['The team continues the way you direct (or you reassign, split or close it).'],
      design: ['Records the design for planning. Implementation, QA and merge keep their own gates.'],
      council: ['Records the council decision. Implementation, QA and merge keep their own gates.'],
      research: ['Waives the second review (recorded as your verdict); the manager can groom it.'],
      plan: ['Creates the tasks of the plan; each one is built, QA’d and reviewed as usual.'],
      epic_review: ['Records your answer for the epic (and the closes, if you approve them).'],
      owner_task: ['Nobody on the team picks it up: the tasks after it wait until you mark it done or hand it back.'],
      page: ['Looking changes nothing by itself; muting stops these alerts, investigating wakes the SRE.'],
      product: ['Updates the product review; the plan cannot start until its objections are resolved.'],
    }[kind] || ['Records your decision.'];
    out.consequence = { summary: steps[0], steps: steps.map((text) => ({ text, tone: 'ok' })) };
    out.gate = simpleGate({ running: !!(t?.active_run && t.active_run > 0) });
    out.human = [{ question: 'Nothing more unless the engineer asks again.', owner_task: 'All of it: this step is yours.', page: 'Deciding whether it is real.',
      plan: 'Each task still meets the merge rules.', design: 'Approving the merge later, if it is high risk.', council: 'Approving the merge later, if it is high risk.' }[kind] || 'The later gates (QA, reviews, merge rules) stay as they are.'];
    if (head && ['question', 'conflict', 'stuck', 'setup', 'refresh'].includes(kind)) out.evidence = { ...out.evidence, qa };
  }
  return out;
}

// ---------------- "What remains before merge?" ----------------
/**
 * The steps between now and a merge, in order, each done / now / next / blocked / n/a. Deterministic, from the ticket
 * and the facts above; the Conversation's quick prompt shows it before (optionally) asking a seat.
 */
export function beforeMerge({ ticket: t, qa, reviews, ci, policy, mergeState = null, nameOf = (s) => s }) {
  const s = t.status;
  if (['done'].includes(s)) return { closed: true, steps: [], text: t.pr_url ? 'Merged: nothing remains before merge.' : 'Done without a PR: nothing to merge.' };
  if (s === 'wontdo') return { closed: true, steps: [], text: 'Closed without shipping: nothing will merge.' };
  const order = ['triage', 'proposed', 'todo', 'in_progress', 'qa', 'review', 'ready_for_human'];
  const at = order.indexOf(s === 'needs_human' ? (t.resume_status || 'todo') : s);
  const steps = [
    { id: 'groom', label: 'Groomed and staffed', state: at <= 1 ? 'now' : 'done' },
    { id: 'build', label: t.assignee ? `Built by ${nameOf(t.assignee)}` : 'Built', state: at < 2 ? 'next' : at <= 3 ? 'now' : 'done' },
    { id: 'qa', label: 'QA passes this commit', state: qa?.state === 'current' ? 'done' : at === 4 ? 'now' : at > 4 && qa?.state !== 'current' ? 'blocked' : 'next', text: qa?.text },
    { id: 'reviews', label: 'Two code reviews approve it', state: reviews?.state === 'current' ? 'done' : at === 5 ? 'now' : at > 5 ? 'blocked' : 'next', text: reviews?.text },
    { id: 'ci', label: 'CI passes on GitHub', state: ci?.checks === 'passing' && ci.state !== 'stale' ? 'done' : ci?.state === 'unknown' ? (at >= 6 ? 'unknown' : 'next') : at >= 6 ? 'blocked' : 'next', text: ci?.text },
    { id: 'merge', label: policy?.eligible ? 'The desk merges it (low risk)' : 'You merge it', state: at >= 6 ? 'now' : 'next', text: policy?.eligible ? null : policy?.reason ? `Needs your merge: ${policy.reason}.` : null },
  ];
  if (t.status === 'needs_human') steps.unshift({ id: 'answer', label: 'Your answer', state: 'blocked', text: t.progress_msg || 'Waiting for your direction.' });
  if (mergeState?.state === 'held') steps.push({ id: 'hold', label: 'Your hold is released', state: 'blocked', text: mergeState.reason });
  const next = steps.find((x) => ['now', 'blocked', 'unknown'].includes(x.state));
  const left = steps.filter((x) => x.state !== 'done');
  return { closed: false, steps, text: left.length ? `${plural(left.length, 'step')} left; next: ${next ? next.label.toLowerCase() : left[0].label.toLowerCase()}.` : 'Nothing: it is ready to merge.' };
}
