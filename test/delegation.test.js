// Delegation (#9): the EM and the SRE decide some owner decisions for the owner. These tests pin the model (modes,
// policy, deterministic owner rules, metrics), structured hold reasons, server-owned records (one per decision and
// version), atomic apply with re-validation, every delegable kind, override/reopen, peer access and the owner-only
// write paths. Decide runs are simulated by binding a run row; test/delegation-run.test.js drives a real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-delegation-')));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'D' }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false }, ops: { enabled: true, containers: [] } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, store, sched, delegation, model, attention, access, researchReview, team, runner;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  sched = await import('../src/scheduler.js'); delegation = await import('../src/delegation.js'); model = await import('../src/delegation-model.js');
  attention = await import('../public/attention.js'); access = await import('../src/access.js'); researchReview = await import('../src/research-review.js');
  team = await import('../src/team.js'); runner = await import('../src/runner.js');
  config.delegation.maxPerDay = 1000; // every test here binds runs; the daily allowance has its own test
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const ticket = (patch = {}) => { const t = store.createTicket({ title: `Delegation fixture ${++n}`, description: 'Fix the retry helper in utils/net.py.', status: 'todo', area: 'backend', complexity: 'S', assignee: 'junior', reporter: 'owner' }); return store.updateTicket(t.key, { risk: 'low', ...patch }); };
/** An engineer asks the owner through the real desk command (structured hold: question, asker, subject, comment). */
async function ask(t, seat = 'junior', q = 'Which test file covers the retry helper?', about = 'factual') {
  store.updateTicket(t.key, { status: 'in_progress', assignee: seat });
  const run = store.createRun({ agent_id: seat, ticket_key: t.key, kind: 'implement', token: `i-${Math.random()}`, model: 'claude:opus' });
  await sched.deskAction(run, 'needs-human', { body: q, ...(about ? { about } : {}) });
  store.updateRun(run.id, { status: 'success', token: null });
  return store.getTicket(t.key);
}
/** Bind a decide run to a queued record, the way delegation.launch does (what it may cite, the server-owned job, the run id). */
function bind(r) {
  delegation.seal(r);
  const run = store.createRun({ agent_id: r.seat, ticket_key: r.ticket_key, kind: 'decide', token: `d-${r.id}-${Math.random()}`, model: 'claude:opus', job: { delegation: r.id } });
  store.updateDelegation(r.id, { status: 'running', run_id: run.id, attempts: 1 });
  return run;
}
const policy = (kinds, peerAccess = false) => delegation.setPolicy({ kinds: { owner_task: 'owner', question: 'owner', research: 'owner', loop_limit: 'owner', design: 'owner', ...kinds }, peerAccess });
const recFor = (decisionId) => store.recentDelegations(200).find((r) => r.decision_id === decisionId) || null;
function reset() {
  for (const r of store.delegationsByStatus('queued', 'running')) store.updateDelegation(r.id, { status: 'superseded' });
  for (const a of store.listAgentStates()) store.updateAgent(a.id, { status: 'idle', current_ticket: null, current_run: null, current_kind: null });
  if (store.getSettings().delegation_escalate_all === 'true') delegation.setEscalateAll(false);
  store.setSetting('ops_enabled', 'false');
}

test('model: every delegable kind defaults to shadow; the matrix validates as a whole; enabled:false and Escalate everything make all of it yours', () => {
  const s = model.settingsFrom({});
  assert.deepEqual(Object.values(s.kinds), ['shadow', 'shadow', 'shadow', 'shadow', 'shadow']);
  assert.equal(s.peerAccess, false, 'peer access is off by default');
  assert.equal(s.budgetUsd, 0.75); assert.equal(s.maxMinutes, 6);
  assert.throws(() => model.validatePolicy({ kinds: { question: 'sre' } }), /Engineers' questions: mode must be one of owner, shadow, em/);
  assert.throws(() => model.validatePolicy({ kinds: { merge: 'em' } }), /unknown decision kind "merge"/, 'merges are not a delegable kind at all');
  assert.throws(() => model.validatePolicy({ kinds: {}, peerAccess: 'yes' }), /peerAccess must be true or false/);
  assert.deepEqual(model.validatePolicy({ kinds: { design: 'sre' } }).kinds.design, 'sre');
  const saved = { kinds: { question: 'em', design: 'sre' }, peerAccess: true };
  assert.equal(model.effective({ cfg: s, saved }).kinds.question, 'em');
  const halt = model.effective({ cfg: s, saved, escalateAll: true });
  assert.ok(Object.values(halt.kinds).every((m) => m === 'owner'), 'Escalate everything');
  assert.equal(halt.peerAccess, false, 'escalate everything also ends peer access');
  assert.ok(Object.values(model.effective({ cfg: { ...s, enabled: false }, saved }).kinds).every((m) => m === 'owner'), 'config kill switch beats the saved matrix');
  assert.notEqual(model.versionOf(model.effective({ cfg: s, saved }), 1), model.versionOf(model.effective({ cfg: s, saved }), 2), 'a new epoch is a new version');
  assert.equal(model.delegateFor('question', 'em'), 'manager'); assert.equal(model.delegateFor('design', 'sre'), 'sre');
  assert.equal(model.delegateFor('question', 'shadow'), 'manager'); assert.equal(model.delegateFor('question', 'owner'), null);
  assert.deepEqual(model.allowedActions('question'), ['answer', 'escalate']);
  assert.ok(!model.allowedActions('loop_limit').includes('approve'), 'a loop limit can never be cleared by a delegate');
  assert.ok(!model.allowedActions('research').includes('approve'), 'a research hold is never approved past dissent');
});

test('model: the deterministic owner rules (self-interest, risk, lifetime limits, owner-task kinds) need no model call', () => {
  const L = model.settingsFrom({});
  const low = { status: 'needs_human', risk: 'low' };
  const r = (f) => model.ownerReason({ limits: L, delegate: 'manager', ticket: low, ...f });
  assert.equal(r({ kind: 'question', scope: 'factual' }), null);
  assert.match(r({ kind: 'question', scope: 'factual', interest: 'asked this question' }), /manager asked this question, so manager cannot decide it for you/);
  assert.match(r({ kind: 'question', scope: 'factual', ticket: { ...low, risk: 'high' } }), /high risk/);
  assert.match(r({ kind: 'question', scope: 'factual', ticket: { ...low, risk: null } }), /no low-risk classification/, 'unknown risk counts as high');
  assert.match(r({ kind: 'question', scope: 'factual', ticket: { ...low, diff_risk: 'high' } }), /high risk/);
  // Only a question its asker marked factual: any other subject, an unknown one or none at all stays the owner's.
  assert.match(r({ kind: 'question' }), /did not mark it as a factual engineering question/);
  assert.match(r({ kind: 'question', scope: 'nonsense' }), /unknown subject/);
  for (const [scope, re] of [['money', /about money: money and budget are yours/], ['credentials', /credentials and accounts/], ['product', /product preference/], ['trading', /trading semantics/], ['schema', /schema or data change/], ['other', /not a factual engineering question/]])
    assert.match(r({ kind: 'question', scope }), re, scope);
  assert.match(r({ kind: 'research', interest: 'wrote the proposal' }), /wrote the proposal/);
  assert.match(r({ kind: 'research', lifetime: { count: 1, spend: 0 } }), /already sent this proposal back 1 time \(limit 1/);
  assert.match(r({ kind: 'research', lifetime: { count: 0, spend: 1.6 } }), /already cost \$1\.60/);
  assert.match(r({ kind: 'loop_limit', interest: 'asked for the changes' }), /manager asked for the changes, so manager cannot decide it/);
  assert.match(r({ kind: 'design', interest: 'wrote the recommendation' }), /wrote the recommendation/, 'the EM never approves its own plan');
  assert.match(r({ kind: 'design', ticket: { ...low, risk: null }, designStatus: 'complete' }), /positively low-risk/);
  assert.equal(r({ kind: 'design', designStatus: 'complete' }), null);
  for (const [k, re] of [['write', /production write/], ['restart', /restart/], ['credential', /credentials/], ['business', /business decision/], ['probe', /could not answer/], ['owner', /took this task yourself/], [null, /kind of step/]])
    assert.match(r({ kind: 'owner_task', ownerTaskKind: k }), re, String(k));
  assert.match(r({ kind: 'owner_task', ownerTaskKind: 'check', verifyReady: false }), /nobody on the team can read production/);
  assert.equal(r({ kind: 'owner_task', ownerTaskKind: 'check', verifyReady: true }), null);
  assert.equal(r({ kind: 'owner_task', ownerTaskKind: 'package', packagesEnabled: true }), null);
  assert.match(r({ kind: 'question', delegateOff: true }), /switched off/);
});

test('model: metrics count each decision once per kind; avoided excludes overrides and reopens; spend says what was estimated', () => {
  const now = Date.now(), at = new Date(now - 3600_000).toISOString(), old = new Date(now - 9 * 86400_000).toISOString();
  const m = model.metrics([
    { kind: 'question', status: 'applied', created_at: at, spent_usd: 0.4, runs: 1 },
    { kind: 'question', status: 'overridden', created_at: at, spent_usd: 0.3, runs: 1 },
    { kind: 'question', status: 'shadow', created_at: at, spent_usd: 0.2, runs: 1, estimated_runs: 1 },
    { kind: 'owner_task', status: 'applied', created_at: at },
    { kind: 'research', status: 'escalated', created_at: at },
    { kind: 'question', status: 'applied', created_at: old, spent_usd: 5 },
  ], { now });
  assert.deepEqual([m.kinds.question.applied, m.kinds.question.avoided, m.kinds.question.overridden, m.kinds.question.shadow], [2, 1, 1, 1]);
  assert.equal(m.kinds.owner_task.avoided, 1); assert.equal(m.kinds.research.escalated, 1);
  assert.equal(m.total.avoided, 2); assert.equal(m.total.spend_usd, 0.9, 'only the window counts');
  assert.match(m.spend_text, /\$0\.90 across 3 runs \(1 without a cost report/);
  assert.match(m.avoided_text, /^2 owner interventions avoided/);
});

test('config: delegation.* from the file and SIGMADESK_* env, validated (an invalid mode is a problem, never silently yours)', async () => {
  const { loadConfig, validateConfig } = await import('../src/config.js');
  const f = path.join(tmp, 'dlg.json');
  fs.writeFileSync(f, JSON.stringify({ project: { repoPath: repo }, delegation: { kinds: { question: 'em', design: 'boss' }, peerAccess: true } }));
  const keep = { ...process.env };
  try {
    process.env.SIGMADESK_DELEGATION_LOOP_LIMIT = 'em'; process.env.SIGMADESK_DELEGATION_PEER_ACCESS = 'false';
    const c = loadConfig(f);
    assert.equal(c.delegation.kinds.question, 'em'); assert.equal(c.delegation.kinds.loop_limit, 'em', 'env beats the file');
    assert.equal(c.delegation.peerAccess, false);
    assert.ok(validateConfig(c).some((p) => /delegation\.kinds\.design must be owner, shadow or em or sre/.test(p)));
    process.env.SIGMADESK_DELEGATION = 'off';
    assert.equal(loadConfig(f).delegation.enabled, false);
    assert.equal(loadConfig(path.join(tmp, 'none.json')).delegation.kinds.question, 'shadow', 'the defaults were not mutated by the env');
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

test('records: one per decision and evidence version; owner mode opens none; shadow records the decision and changes nothing', async () => {
  reset();
  policy({});
  const t = await ask(ticket());
  assert.equal(delegation.sweep({ paused: false }).created, 0, 'owner mode: nothing runs');
  policy({ question: 'shadow' });
  delegation.sweep({ paused: false }); delegation.sweep({ paused: false });
  const recs = store.delegationsForTicket(t.key);
  assert.equal(recs.length, 1, 'deduplicated by decision and version');
  const r = recs[0];
  assert.deepEqual([r.kind, r.mode, r.seat, r.asker, r.status], ['question', 'shadow', 'manager', 'junior', 'queued']);
  assert.deepEqual(JSON.parse(r.allowed), ['answer', 'escalate']);
  const brief = JSON.parse(r.brief);
  assert.equal(brief.id, `${t.key}:question`); assert.ok(brief.policy_version && brief.gate, 'audited with the brief the owner sees');
  assert.equal(JSON.parse(r.provenance).decided_for, 'owner');
  const run = bind(r);
  const out = await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'answer', body: 'tests/test_net.py covers it.', why: 'tests/test_net.py:12 exercises retry(); playbook: answer from the code.' });
  assert.match(out, /shadow mode/);
  const after = store.getDelegation(r.id);
  assert.deepEqual([after.status, after.action], ['shadow', 'answer']);
  assert.equal(store.getTicket(t.key).status, 'needs_human', 'the owner still decides');
  assert.ok(!store.listComments(t.key).some((c) => /test_net/.test(c.body)), 'a shadow answer never reaches the thread the engineer reads');
  const B = attention.board({ tickets: store.listTickets(), agents: [], events: [], settings: store.getSettings(), meta: { delegation: delegation.summary() } });
  const d = B.decisions.find((x) => x.id === `${t.key}:question`);
  assert.equal(d.delegate.status, 'shadow'); assert.match(d.delegate.line, /Morgan answered Riley: tests\/test_net\.py/);
  // A new question is a new decision (a new version).
  store.updateTicket(t.key, { status: 'in_progress' });
  await ask(store.getTicket(t.key), 'junior', 'And which fixture does it use?');
  delegation.sweep({ paused: false });
  assert.equal(store.delegationsForTicket(t.key).length, 2);
});

test('apply (em): the answer is posted as Morgan\'s, decided for the owner, and the work resumes; never an owner write', async () => {
  reset();
  policy({ question: 'em' });
  const t = await ask(ticket());
  store.setSetting('paused', 'false');
  assert.equal(delegation.takesNotice(store.getTicket(t.key)), true, 'the hold is announced only if it comes back to you');
  store.setSetting('paused', 'true');
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:question`);
  assert.equal(r.status, 'queued');
  const B = attention.board({ tickets: store.listTickets(), agents: [], events: [], settings: { ...store.getSettings(), paused: 'false' }, meta: { delegation: delegation.summary() } });
  assert.ok(!B.needs_you.some((x) => x.id === `${t.key}:question`), 'the delegate is deciding it: not in your Inbox');
  assert.match(B.queued.find((x) => x.key === t.key)?.reason || '', /Morgan is deciding this for you/);
  const owners = store.listComments(t.key).filter((c) => c.author === 'owner').length;
  const run = bind(r);
  await assert.rejects(sched.deskAction(run, 'decide', { action: 'approve', body: 'x', why: 'not allowed here at all' }), /this decision allows answer, escalate/);
  await assert.rejects(sched.deskAction(run, 'decide', { action: 'answer', body: 'x', why: 'short' }), /say why/);
  await assert.rejects(sched.deskAction(run, 'submit', { body: 'x' }), /decision run reads the ticket/);
  const out = await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'answer', body: 'Yes: utils/net.py:40.', why: 'utils/net.py:40 defines retry(); playbook says prefer the shared helper.' });
  assert.match(out, /Decided for the owner and applied/);
  const after = store.getDelegation(r.id);
  assert.equal(after.status, 'applied');
  const c = store.listComments(t.key).find((x) => x.id === after.comment_id);
  assert.equal(c.author, 'manager', 'recorded as the delegate\'s');
  assert.match(c.body, /Morgan answered Riley for you[\s\S]*utils\/net\.py:40[\s\S]*Decided for the owner by Morgan[\s\S]*override or reopen/);
  assert.equal(store.listComments(t.key).filter((x) => x.author === 'owner').length, owners, 'nothing was written as the owner');
  const now = store.getTicket(t.key);
  assert.deepEqual([now.status, now.hold_kind, now.resume_status], ['todo', null, null], 'resumed where the hold said (the builder picks it up again)');
  await assert.rejects(sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'answer', body: 'again', why: 'trying a second time here' }), /no longer open/);
  const v = delegation.summary();
  assert.ok(v.decided.some((x) => x.id === r.id && /Morgan answered Riley: Yes/.test(x.line)), 'Decided for you (last 24 h)');
  assert.equal(v.metrics.kinds.question.avoided >= 1, true);
});

test('re-validation at apply: a changed decision is superseded, a policy change or Escalate everything invalidates, and a rule still wins', async () => {
  reset();
  policy({ question: 'em' });
  // 1. The owner answered first: nothing is applied.
  const a = await ask(ticket());
  delegation.sweep({ paused: false });
  const ra = recFor(`${a.key}:question`); const runA = bind(ra);
  sched.ownerReply(a.key, 'Use the shared helper.', 'answer', { mentions: [] });
  const outA = await sched.deskAction(runA, 'decide', { cite: 'R1,E1', action: 'answer', body: 'late answer', why: 'the evidence says so clearly' });
  assert.match(outA, /changed or was settled meanwhile: nothing was applied/);
  assert.equal(store.getDelegation(ra.id).status, 'superseded');
  assert.ok(!store.listComments(a.key).some((c) => /late answer/.test(c.body)));
  // 2. The owner changed the matrix while it ran.
  const b = await ask(ticket());
  delegation.sweep({ paused: false });
  const rb = recFor(`${b.key}:question`); const runB = bind(rb);
  policy({ question: 'em', loop_limit: 'em' });
  assert.equal(store.getDelegation(rb.id).status, 'invalidated', 'invalidated at once by the policy change');
  await assert.rejects(sched.deskAction(runB, 'decide', { cite: 'R1,E1', action: 'answer', body: 'x', why: 'the evidence says so clearly' }), /no longer open/);
  // 3. Escalate everything: in-flight authority ends and nothing new is delegated.
  const c = await ask(ticket());
  delegation.sweep({ paused: false });
  const rc = recFor(`${c.key}:question`); bind(rc);
  delegation.setEscalateAll(true);
  assert.equal(store.getDelegation(rc.id).status, 'invalidated');
  assert.equal(delegation.policy().kinds.question, 'owner');
  const d = await ask(ticket());
  assert.equal(delegation.sweep({ paused: false }).created, 0, 'every decision is yours');
  assert.equal(recFor(`${d.key}:question`), null);
  delegation.setEscalateAll(false);
  // 4. A rule that is not evidence still wins at apply: the delegate's seat was switched off while it decided.
  const e = await ask(ticket());
  delegation.sweep({ paused: false });
  const re = recFor(`${e.key}:question`); const runE = bind(re);
  team.applyTeamOverrides({ manager: { enabled: false } });
  try {
    const outE = await sched.deskAction(runE, 'decide', { cite: 'R1,E1', action: 'answer', body: 'x', why: 'the evidence says so clearly' });
    assert.match(outE, /owner's: Morgan's seat is switched off/);
    assert.equal(store.getDelegation(re.id).status, 'escalated');
  } finally { team.applyTeamOverrides({}); }
});

// Values a fixture writes to change one field (anything different from what the ticket holds).
const changed = (f, v) => (['qa_loops', 'review_round', 'owner_task', 'assign_pinned', 'research_generation', 'research_revisions', 'owner_merge_only'].includes(f) ? (Number(v) || 0) + 1
  : f === 'contributors' ? JSON.stringify(['senior-be', 'manager']) : f === 'risk' ? 'high' : f === 'status' ? 'todo' : `${v ?? ''}~changed`);
test('evidence and policy at apply (property): any one substantive change after the run started means nothing is applied', async () => {
  reset();
  policy({ question: 'em' });
  const fields = delegation.EVIDENCE_FIELDS.filter((f) => !['key', 'reporter'].includes(f)); // set once, at creation
  const savedPolicy = store.getSettings().access_policy;
  const mutations = [
    ...fields.map((f) => [`the ticket's ${f}`, (t) => { store.updateTicket(t.key, { [f]: changed(f, t[f]) }); assert.notEqual(String(store.getTicket(t.key)[f]), String(t[f]), `${f} changed`); }]),
    ['a new message on the thread', (t) => store.addComment(t.key, 'senior-be', 'This now touches the broker order path.')],
    ['the changed files', (t) => store.kvSet(`diff-files:${t.key}`, JSON.stringify(['broker/orders.py']))],
    ['production read access', () => store.setSetting('ops_enabled', 'true')],
    ['GitHub sync', () => store.setSetting('github_sync', store.getSettings().github_sync === 'true' ? 'false' : 'true')],
    ['opening PRs', () => store.setSetting('open_draft_prs', store.getSettings().open_draft_prs === 'true' ? 'false' : 'true')],
    ['the access policy', () => store.writeSetting('access_policy', JSON.stringify({ approvers: ['manager'], seats: ['sre'], probes: ['*'], maxMinutes: 30 }))],
  ];
  const sync = store.getSettings().github_sync, prs = store.getSettings().open_draft_prs;
  try {
    for (const [what, mutate] of mutations) {
      const t = await ask(ticket({ description: 'Fix the retry helper in utils/net.py.' }));
      delegation.sweep({ paused: false });
      const r = recFor(`${t.key}:question`);
      assert.equal(r?.status, 'queued', what);
      const run = bind(r);
      const thread = store.listComments(t.key).length;
      mutate(store.getTicket(t.key));
      const out = await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'answer', body: 'Yes, buy it.', why: 'utils/net.py:40 says so; the playbook says reuse.' });
      const after = store.getDelegation(r.id);
      assert.ok(['superseded', 'invalidated'].includes(after.status), `${what}: ${after.status}`);
      assert.match(out, /nothing was applied/, what);
      assert.ok(!store.listComments(t.key).some((c) => c.author === 'manager'), `${what}: nothing posted as Morgan`);
      assert.ok(store.listComments(t.key).length <= thread + 1, `${what}: no decision on the thread`);
      store.setSetting('ops_enabled', 'false'); store.setSetting('github_sync', sync); store.setSetting('open_draft_prs', prs);
      store.writeSetting('access_policy', savedPolicy ?? '');
    }
  } finally { store.setSetting('ops_enabled', 'false'); store.setSetting('github_sync', sync); store.setSetting('open_draft_prs', prs); store.writeSetting('access_policy', savedPolicy ?? ''); }
});

test('a failed final write rolls the whole decision back: no answer on the thread, the ticket still waits for the owner', async () => {
  reset();
  policy({ question: 'em' });
  const t = await ask(ticket());
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:question`); const run = bind(r);
  const thread = store.listComments(t.key).length;
  store.handle().exec("CREATE TRIGGER fail_apply BEFORE UPDATE OF status ON delegated_decisions WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  try {
    await assert.rejects(sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'answer', body: 'utils/net.py:40.', why: 'utils/net.py:40 defines retry(); the playbook says reuse.' }), /injected failure/);
  } finally { store.handle().exec('DROP TRIGGER fail_apply'); }
  const now = store.getTicket(t.key);
  assert.deepEqual([now.status, now.hold_kind], ['needs_human', 'question'], 'the work did not resume');
  assert.equal(store.listComments(t.key).length, thread, 'the answer was rolled back with it');
  assert.equal(store.getDelegation(r.id).status, 'running', 'still open: the run ends without a decision and it goes to the owner');
});

test('authority: an answer must cite a standing rule and its evidence; "approve the $5,000 purchase" without them goes to the owner and nothing resumes', async () => {
  reset();
  policy({ question: 'em' });
  const buy = 'Can I buy the $5,000 market-data vendor license for this?';
  // 1. A question about money, or one whose asker did not say what it is about: the owner's by rule, before any run.
  const money = await ask(ticket(), 'junior', buy, 'money');
  const unmarked = await ask(ticket(), 'junior', buy, null);
  delegation.sweep({ paused: false });
  assert.match(recFor(`${money.key}:question`).why, /about money: money and budget are yours/);
  assert.match(recFor(`${unmarked.key}:question`).why, /did not mark it as a factual engineering question/);
  for (const t of [money, unmarked]) assert.deepEqual([recFor(`${t.key}:question`).status, recFor(`${t.key}:question`).run_id], ['escalated', null]);
  await assert.rejects(ask(ticket(), 'junior', buy, 'cheap'), /--about must be one of factual, money/);
  // 2. Mislabelled as factual, so a run starts: an approval that does not cite what it rests on is never applied.
  await runner.scratchTemplate({ force: true }); // the trusted base that file: citations are checked against
  const approve = 'Approved: buy the $5,000 license today.';
  for (const [what, cite, re] of [
    ['no citation at all', undefined, /cites nothing from its brief/],
    ['a rule only', 'R1', /cites no evidence from its brief/],
    ['evidence only', 'E1', /cites none of your standing rules/],
    ['an evidence id it was never given', 'R1,E99', /cites E99, which is not in its brief or the repository/],
    ['a rule id it was never given', 'R999,E1', /cites R999, which is not/],
    ['a file outside the repository', 'R1,file:../../etc/passwd', /cites file:\.\.\/\.\.\/etc\/passwd, which is not/],
    ['an absolute path', 'R1,file:/etc/passwd', /cites file:\/etc\/passwd, which is not/],
    ['a file that does not exist', 'R1,file:no/such/file.py:3', /cites file:no\/such\/file\.py:3, which is not/],
    ['a line past the end of a real file', 'R1,file:README.md:2', /cites file:README\.md:2, which is not/],
    ['a made-up kind of id', 'R1,E1,ticket:42', /cites ticket:42, which is not/],
  ]) {
    const t = await ask(ticket(), 'junior', buy, 'factual');
    delegation.sweep({ paused: false });
    const r = recFor(`${t.key}:question`);
    assert.equal(r.status, 'queued', what);
    const out = await sched.deskAction(bind(r), 'decide', { action: 'answer', body: approve, why: 'The vendor is reliable and the team needs it now.', ...(cite ? { cite } : {}) });
    assert.match(out, /Not applied: your decision/, what);
    const after = store.getDelegation(r.id);
    assert.equal(after.status, 'escalated', what); assert.match(after.why, re, what);
    assert.equal(after.recommendation, approve, `${what}: the text reaches the owner only as a recommendation`);
    const now = store.getTicket(t.key);
    assert.deepEqual([now.status, now.hold_kind], ['needs_human', 'question'], `${what}: the work did not resume`);
    assert.ok(!store.listComments(t.key).some((c) => c.author === 'manager'), `${what}: nothing was posted as Morgan's`);
  }
  // 3. Shadow shows it the same way: left to the owner, never as what Morgan would decide.
  policy({ question: 'shadow' });
  const s = await ask(ticket(), 'junior', buy, 'factual');
  delegation.sweep({ paused: false });
  const rs = recFor(`${s.key}:question`);
  await sched.deskAction(bind(rs), 'decide', { action: 'answer', body: approve, why: 'Looks fine to me, really.' });
  assert.equal(store.getDelegation(rs.id).status, 'escalated');
  // 4. A factual answer that cites a rule, the brief and a real file is applied, and the audit says what it cited.
  policy({ question: 'em' });
  const ok = await ask(ticket(), 'junior', 'Which file defines the retry helper?', 'factual');
  delegation.sweep({ paused: false });
  const ro = recFor(`${ok.key}:question`);
  const out = await sched.deskAction(bind(ro), 'decide', { action: 'answer', body: 'utils/net.py, retry().', why: 'The ticket names utils/net.py; the playbook says follow existing patterns.', cite: 'R1, E1 file:README.md:1' });
  assert.match(out, /Decided for the owner and applied/);
  const audit = delegation.get(ro.id);
  assert.deepEqual(audit.cited.map((x) => x.id), ['R1', 'E1', 'file:README.md:1']);
  assert.match(audit.cited[1].text, /the ticket description/);
  assert.ok(JSON.parse(store.getDelegation(ro.id).citables).rules.length > 0, 'the rules its run was given are on the record');
});

test('self-interest and risk escalate by rule, before any run: the asker never answers itself; risky tickets stay yours', async () => {
  reset();
  policy({ question: 'em' });
  const own = await ask(ticket({ assignee: 'manager' }), 'manager', 'Should the groom split this?');
  const risky = await ask(ticket({ risk: 'high' }));
  const unknown = await ask(ticket({ risk: null }));
  delegation.sweep({ paused: false });
  for (const [t, re] of [[own, /Morgan asked this question, so Morgan cannot decide it for you/], [risky, /high risk/], [unknown, /no low-risk classification/]]) {
    const r = recFor(`${t.key}:question`);
    assert.equal(r.status, 'escalated', t.key); assert.match(r.why, re); assert.equal(r.run_id, null, 'no model call');
    assert.ok(store.kvGet(`delegation:noticed:${r.decision_id}:${r.version}`), 'the owner is told, once');
  }
  assert.ok(!delegation.nextJobs().some((r) => [own.key, risky.key, unknown.key].includes(r.ticket_key)));
  const B = attention.board({ tickets: store.listTickets(), agents: [], events: [], settings: { ...store.getSettings(), paused: 'false' }, meta: { delegation: delegation.summary() } });
  const d = B.needs_you.find((x) => x.id === `${risky.key}:question`);
  assert.match(d.escalation.why, /high risk/, 'the card says why it is yours');
});

test('owner-task triage by rule (em): a check goes to the SRE, a package becomes a package request, writes stay yours', async () => {
  reset();
  policy({ owner_task: 'em' });
  const check = ticket(); store.updateTicket(check.key, { owner_task: 1, owner_task_kind: 'check', assignee: null });
  const pkg = ticket({ complexity: 'S' }); store.updateTicket(pkg.key, { owner_task: 1, owner_task_kind: 'package', assignee: null });
  const write = ticket(); store.updateTicket(write.key, { owner_task: 1, owner_task_kind: 'write', assignee: null });
  delegation.sweep({ paused: false });
  assert.equal(recFor(`${check.key}:owner-task`).status, 'escalated', 'access off: nobody can read production, so it stays yours');
  assert.match(recFor(`${check.key}:owner-task`).why, /nobody on the team can read production/);
  assert.equal(recFor(`${write.key}:owner-task`).status, 'escalated');
  assert.match(recFor(`${write.key}:owner-task`).why, /production write is yours/);
  const p = recFor(`${pkg.key}:owner-task`);
  assert.equal(p.status, 'applied'); assert.equal(p.run_id, null, 'by rule: no model call');
  const pt = store.getTicket(pkg.key);
  assert.deepEqual([pt.owner_task, pt.assign_pinned], [0, 1]); assert.ok(['junior', 'senior-be'].includes(pt.assignee));
  assert.match(store.listComments(pkg.key).at(-1).body, /package request[\s\S]*desk pkg request[\s\S]*You approve the wheel list/);
  // With production read access on, the SRE takes a check.
  store.setSetting('ops_enabled', 'true');
  const check2 = ticket(); store.updateTicket(check2.key, { owner_task: 1, owner_task_kind: 'check', assignee: null });
  delegation.sweep({ paused: false });
  const rc = recFor(`${check2.key}:owner-task`);
  assert.equal(rc.status, 'applied', rc.why || rc.outcome);
  const ct = store.getTicket(check2.key);
  assert.deepEqual([ct.owner_task, ct.assignee, store.kvGet(`verify:${check2.key}`)], [0, 'sre', '1']);
  assert.equal(store.listComments(check2.key).at(-1).author, 'manager');
  // Shadow: the same rule is only recorded.
  policy({ owner_task: 'shadow' });
  const check3 = ticket(); store.updateTicket(check3.key, { owner_task: 1, owner_task_kind: 'check', assignee: null });
  delegation.sweep({ paused: false });
  assert.equal(recFor(`${check3.key}:owner-task`).status, 'shadow');
  assert.equal(store.getTicket(check3.key).owner_task, 1, 'still yours');
  store.setSetting('ops_enabled', 'false');
});

test('owner requests: only structured, mode-checked triage routes them, at once and in shadow too; text is never read; --verify is its own route', async () => {
  reset();
  store.setSetting('ops_enabled', 'true'); store.setSetting('paused', 'false');
  // A principal slicing a design (so the delegate did not file it) and the manager grooming (the delegate did).
  const slice = async (title, extra) => {
    const parent = ticket({ status: 'in_progress' });
    const run = store.createRun({ agent_id: 'principal-be', ticket_key: parent.key, kind: 'design', token: `p-${Math.random()}`, model: 'claude:opus' });
    const out = await sched.deskAction(run, 'create-task', { title, complexity: 'S', area: 'db', body: 'Count yesterday\'s fills.', ...extra });
    return [out, out.match(/D-\d+/)[0]];
  };
  const groomed = async (title, extra) => {
    const parent = ticket({ status: 'in_progress' });
    const run = store.createRun({ agent_id: 'manager', ticket_key: parent.key, kind: 'groom', token: `g-${Math.random()}`, model: 'claude:opus' });
    const out = await sched.deskAction(run, 'create-task', { parent: parent.key, title, complexity: 'S', area: 'db', body: 'Count yesterday\'s fills.', ...extra });
    return [out, out.match(/D-\d+/)[0]];
  };
  const check = { owner: 'needs production access', 'owner-kind': 'check' };
  try {
    // You decide: the owner's task, and no record at all.
    policy({});
    const [a, ka] = await slice('Count fills (owner mode)', check);
    assert.match(a, /→ the owner/);
    assert.deepEqual([store.getTicket(ka).owner_task, store.delegationsForTicket(ka).length], [1, 0]);
    // Shadow: the rule's route is recorded at once, and the owner keeps the task.
    policy({ owner_task: 'shadow' });
    const [b, kb] = await slice('Count fills (shadow)', check);
    assert.match(b, /→ the owner/);
    const rb = recFor(`${kb}:owner-task`);
    assert.deepEqual([rb?.status, rb?.action, rb?.run_id], ['shadow', 'route', null], 'a shadow record, by rule');
    assert.deepEqual([store.getTicket(kb).owner_task, store.getTicket(kb).assignee], [1, null], 'still the owner\'s');
    // Morgan decides: a stated check goes to Devon by rule.
    policy({ owner_task: 'em' });
    const [c, kc] = await slice('Count fills (em)', check);
    assert.match(c, /→ sre \(read-only production check\)/);
    assert.deepEqual([recFor(`${kc}:owner-task`).status, store.getTicket(kc).assignee, store.kvGet(`verify:${kc}`)], ['applied', 'sre', '1']);
    // An owner step with no kind stays the owner's, however much its words sound like a check.
    const [d, kd] = await slice('Verify in production that ingest freshness recovered', { owner: 'check the freshness of the Timescale jobs in production' });
    assert.match(d, /→ the owner/);
    assert.match(recFor(`${kd}:owner-task`).why, /nobody said what kind of step it is/);
    // Morgan never routes an owner step Morgan filed.
    const [, ke] = await groomed('Count fills (filed by Morgan)', check);
    assert.match(recFor(`${ke}:owner-task`).why, /Morgan filed it as your task/);
    assert.equal(store.getTicket(ke).owner_task, 1);
    // --verify is the SRE's route, not an owner request: no delegation record. With access off it is the owner's check.
    const [, kf] = await groomed('Confirm caggs refresh', { verify: true });
    assert.deepEqual([store.getTicket(kf).assignee, store.getTicket(kf).owner_task, store.delegationsForTicket(kf).length], ['sre', 0, 0]);
    store.setSetting('ops_enabled', 'false');
    const [g, kg] = await groomed('Confirm freshness', { verify: true });
    assert.match(g, /assigned to the owner/);
    assert.deepEqual([store.getTicket(kg).owner_task_kind, store.getTicket(kg).owner_task_by], ['check', 'desk']);
    assert.match(recFor(`${kg}:owner-task`).why, /nobody on the team can read production/);
    // Halted: nothing is triaged at filing; the sweep does it once the desk runs.
    store.setSetting('ops_enabled', 'true'); store.setSetting('paused', 'true');
    const [, kh] = await slice('Count fills (halted)', check);
    assert.equal(recFor(`${kh}:owner-task`), null);
    delegation.sweep({ paused: false });
    assert.equal(recFor(`${kh}:owner-task`).status, 'applied');
  } finally { store.setSetting('ops_enabled', 'false'); store.setSetting('paused', 'true'); }
});

test('research holds (em): Morgan coordinates a correction recorded as Morgan\'s; never an approval; the lifetime limit survives revisions', async () => {
  reset();
  policy({ research: 'em' });
  const t = store.createTicket({ title: 'Proposal fixture', status: 'proposed', reporter: 'pm', source: 'research', description: '## Problem\nx\n## Evidence\ny' });
  researchReview.open(t, { program: 'product-discovery', review: { minReviewers: 1, reviewers: ['principal-be'] } }, { id: 1 });
  const rv = store.createResearchReview({ ticket_key: t.key, generation: 1, input_hash: researchReview.hashOf(store.getTicket(t.key)), reviewer: 'principal-be', status: 'pending' });
  researchReview.complete(rv.id, { report: { verdict: 'reject', summary: 'The evidence does not support it', evidence_checked: [], findings: ['no source'], conditions: ['cite a source'] } });
  assert.equal(store.getTicket(t.key).research_review, 'held');
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:research:1`);
  assert.deepEqual([r.status, JSON.parse(r.allowed)], ['queued', ['changes', 'escalate']]);
  const run = bind(r);
  await assert.rejects(sched.deskAction(run, 'decide', { action: 'approve', body: 'ok', why: 'waive it, looks fine to me' }), /allows changes, escalate/);
  await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'changes', body: 'Cite the vendor changelog and cut v1 to the alert only.', why: 'The reviewer found no source; the playbook needs cited evidence.' });
  const after = store.getTicket(t.key);
  assert.deepEqual([after.status, after.research_review, after.research_revisions], ['proposed', 'changes', 0]);
  assert.equal(store.kvGet(`research-notes:${t.key}`), 'Cite the vendor changelog and cut v1 to the alert only.');
  assert.equal(store.listComments(t.key).at(-1).author, 'manager');
  assert.ok(!store.listResearchReviews(t.key).some((x) => x.reviewer === 'owner'), 'no waiver');
  // The author revises; the reviewer still holds it: a second delegated correction is over the proposal's lifetime limit.
  researchReview.revise(store.getTicket(t.key), { kind: 'research_revision', ticket_key: t.key, agent_id: 'pm' }, { body: '## Problem\nx2\n## Evidence\ny2' });
  const rv2 = store.createResearchReview({ ticket_key: t.key, generation: 2, input_hash: researchReview.hashOf(store.getTicket(t.key)), reviewer: 'principal-be', status: 'pending' });
  researchReview.complete(rv2.id, { report: { verdict: 'changes', summary: 'Still thin', evidence_checked: [], findings: ['x'], conditions: ['y'] } });
  assert.equal(store.getTicket(t.key).research_review, 'held');
  delegation.sweep({ paused: false });
  const r2 = recFor(`${t.key}:research:2`);
  assert.equal(r2.status, 'escalated'); assert.match(r2.why, /already sent this proposal back 1 time \(limit 1 for its whole life\)/);
});

test('loop limits (em): rescope or reassign, recorded as Morgan\'s; never a QA pass; a review party never settles its own disagreement', async () => {
  reset();
  policy({ loop_limit: 'em' });
  const t = ticket({ status: 'needs_human', assignee: 'junior', builder: 'junior', qa_loops: 3, resume_status: 'todo', hold_kind: 'qa_loops', progress_msg: 'QA failed repeatedly' });
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:stuck`);
  assert.equal(r.status, 'queued');
  const run = bind(r);
  await assert.rejects(sched.deskAction(run, 'decide', { action: 'approve', body: 'ship it', why: 'QA is too strict here' }), /allows changes, escalate/);
  await assert.rejects(sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'changes', body: 'x', why: 'reassign to the qa seat', assign: 'qa' }), /--assign must be an enabled builder/);
  await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'changes', body: 'Drop the cache layer; fix only the parser.', why: 'Three QA fails on the cache; playbook: smallest change.', assign: 'senior-be' });
  const after = store.getTicket(t.key);
  assert.deepEqual([after.status, after.assignee, after.assign_pinned], ['todo', 'senior-be', 1]);
  assert.match(store.listComments(t.key).at(-1).body, /^🔁 \*\*Morgan's direction, deciding for you\*\*[\s\S]*reassigned to Jordan[\s\S]*Drop the cache layer/);
  // The context reviewer (the EM) is a party to a review disagreement: the owner settles it.
  const d = ticket({ status: 'needs_human', assignee: 'junior', resume_status: 'review', hold_kind: 'review_disagree', hold_seat: 'senior-fe', reviewer_context: 'manager', review_round: 4 });
  delegation.sweep({ paused: false });
  const rd = recFor(`${d.key}:conflict`);
  assert.equal(rd.status, 'escalated'); assert.match(rd.why, /Morgan reviews this change, so Morgan cannot decide it for you/);
  // A second rescope of the same ticket is over the lifetime limit.
  store.updateTicket(t.key, { status: 'needs_human', qa_loops: 4, resume_status: 'todo', hold_kind: 'qa_loops' });
  delegation.sweep({ paused: false });
  assert.equal(store.delegationsForTicket(t.key).at(-1).status, 'escalated');
  assert.match(store.delegationsForTicket(t.key).at(-1).why, /already rescoped this ticket 1 time/);
});

test('self-interest (property): whoever holds, requested, built, reviews, designed or filed a decision never decides it, in every kind', async () => {
  reset();
  policy({ owner_task: 'em', question: 'em', research: 'em', loop_limit: 'em', design: 'em' });
  const me = 'manager';
  const cases = []; // [what, decision id, the reason it must give]
  // Questions: the asker, and every work role on the ticket.
  cases.push(['question: the asker', `${(await ask(ticket(), me)).key}:question`, /Morgan asked this question/]);
  for (const [role, value, re] of [['assignee', me, /is assigned this ticket/], ['builder', me, /built this change/], ['designer', me, /designed this ticket/], ['contributors', JSON.stringify([me]), /worked on this ticket/]]) {
    const t = await ask(ticket());
    store.updateTicket(t.key, { [role]: value });
    cases.push([`question: the ${role}`, `${t.key}:question`, re]);
  }
  // Loop limits: the seat that put the hold, for EVERY loop kind; the requester of a requester's loop; both reviewers.
  for (const hold of model.LOOP_HOLDS) {
    const t = ticket({ status: 'needs_human', resume_status: 'todo', qa_loops: 3, hold_kind: hold, hold_seat: me });
    cases.push([`loop limit (${hold}): the seat that held it`, `${t.key}:${hold === 'review_disagree' ? 'conflict' : 'stuck'}`, /Morgan (failed it in QA|asked for the changes|is the reviewer who disagrees|put the hold on it)/]);
  }
  const legacy = store.createTicket({ title: 'Requester loop without a holder', status: 'needs_human', area: 'backend', complexity: 'S', assignee: 'junior', reporter: me });
  store.updateTicket(legacy.key, { risk: 'low', resume_status: 'todo', qa_loops: 3, hold_kind: 'review_loops' }); // a hold recorded before hold_seat
  cases.push(['loop limit: the requester of a requester\'s loop', `${legacy.key}:stuck`, /Morgan requested this work/]);
  for (const role of ['reviewer_context', 'reviewer_independent']) {
    const t = ticket({ status: 'needs_human', resume_status: 'todo', qa_loops: 3, hold_kind: 'qa_loops', hold_seat: 'qa', [role]: me });
    cases.push([`loop limit: the ${role}`, `${t.key}:stuck`, /Morgan reviews this change/]);
  }
  // Research: the author, and a reviewer of the current generation.
  for (const [who, reviewer] of [[me, 'principal-be'], ['pm', me]]) {
    const t = store.createTicket({ title: `Proposal by ${who}`, status: 'proposed', reporter: who, source: 'research', description: '## Problem\nx\n## Evidence\ny' });
    researchReview.open(t, { program: 'product-discovery', review: { minReviewers: 1, reviewers: [reviewer] } }, { id: 1 });
    const rv = store.createResearchReview({ ticket_key: t.key, generation: 1, input_hash: researchReview.hashOf(store.getTicket(t.key)), reviewer, status: 'pending' });
    researchReview.complete(rv.id, { report: { verdict: 'reject', summary: 'No source', evidence_checked: [], findings: ['x'], conditions: ['y'] } });
    cases.push([`research: ${who === me ? 'the author' : 'a reviewer'}`, `${t.key}:research:1`, who === me ? /Morgan wrote the proposal/ : /Morgan reviewed the proposal/]);
  }
  // Design: the recommendation's author. Owner tasks: whoever filed it as the owner's.
  const dt = ticket({ status: 'todo' });
  const disc = store.createDiscussion(dt.key, 'Design the retention.');
  store.updateDiscussion(disc.id, { status: 'complete', response: 'Keep 30 days.' });
  cases.push(['design: the author', `${dt.key}:design:${disc.id}`, /Morgan wrote the recommendation/]);
  const ot = ticket(); store.updateTicket(ot.key, { owner_task: 1, owner_task_kind: 'package', owner_task_by: me, assignee: null });
  cases.push(['owner task: whoever filed it', `${ot.key}:owner-task`, /Morgan filed it as your task/]);
  delegation.sweep({ paused: false });
  for (const [what, id, re] of cases) {
    const r = recFor(id);
    assert.ok(r, `${what}: a record`);
    assert.deepEqual([r.status, r.run_id], ['escalated', null], `${what}: left to the owner before any run`);
    assert.match(r.why, re, what);
  }
  // The same one list everywhere: every seat it names gets an owner reason for every open decision on the board.
  const live = delegation.candidates();
  for (const c of live) for (const [seat] of delegation.interestedSeats(c)) assert.ok(delegation.ownerReasonFor(c, seat), `${c.decision_id}: ${seat} is a party`);
  assert.ok(delegation.interestedSeats({ kind: 'design', ticket: dt, ref: { type: 'council', chair: 'sre' } }).has('sre'), 'a council chair never decides its own verdict');
  // And at apply: a seat that becomes a party after its run started decides nothing.
  const late = ticket({ status: 'needs_human', resume_status: 'todo', qa_loops: 3, hold_kind: 'review_loops', hold_seat: 'principal-be' });
  delegation.sweep({ paused: false });
  const rl = recFor(`${late.key}:stuck`); const run = bind(rl);
  store.updateTicket(late.key, { hold_seat: me });
  const out = await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'changes', body: 'Narrow it to the parser.', why: 'Three rounds on the cache; playbook: smallest change.' });
  assert.match(out, /nothing was applied/);
  assert.notEqual(store.getDelegation(rl.id).status, 'applied');
  assert.equal(store.getTicket(late.key).status, 'needs_human');
});

test('design (sre): Devon approves a positively low-risk recommendation; Morgan never approves the design Morgan wrote', async () => {
  reset();
  policy({ design: 'em' });
  const t = ticket({ status: 'todo' });
  const disc = store.createDiscussion(t.key, 'Design the alert retention.');
  store.updateDiscussion(disc.id, { status: 'complete', response: 'Keep 30 days; prune nightly.' });
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:design:${disc.id}`);
  assert.equal(r.status, 'escalated'); assert.match(r.why, /Morgan wrote the recommendation/);
  policy({ design: 'sre' });
  const disc2 = store.createDiscussion(t.key, 'Design the export.');
  store.updateDiscussion(disc2.id, { status: 'complete', response: 'One CSV per day.' });
  delegation.sweep({ paused: false });
  const r2 = recFor(`${t.key}:design:${disc2.id}`);
  assert.deepEqual([r2.status, r2.seat], ['queued', 'sre']);
  const run = bind(r2);
  await sched.deskAction(run, 'decide', { cite: 'R1,E1', action: 'approve', body: 'One CSV per day is fine.', why: 'Low risk: no trading path; playbook allows read-only exports.' });
  assert.equal(store.getDiscussion(disc2.id).status, 'approved');
  assert.equal(store.listComments(t.key).at(-1).author, 'sre');
  assert.match(store.listComments(t.key).at(-1).body, /Design approved by Devon, deciding for you/);
  // Not positively low risk: the owner's.
  const h = ticket({ risk: null });
  const disc3 = store.createDiscussion(h.key, 'Design the order router.');
  store.updateDiscussion(disc3.id, { status: 'complete', response: 'Route by venue.' });
  delegation.sweep({ paused: false });
  assert.match(recFor(`${h.key}:design:${disc3.id}`).why, /positively low-risk/);
});

test('override and reopen: the owner replaces or reconsiders a delegated decision; nothing is rolled back', async () => {
  reset();
  policy({ question: 'em' });
  const t = await ask(ticket());
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:question`);
  await sched.deskAction(bind(r), 'decide', { cite: 'R1,E1', action: 'answer', body: 'Use the cache.', why: 'utils/cache.py exists; playbook prefers reuse.' });
  store.updateTicket(t.key, { active_run: null, status: 'todo' });
  const o = delegation.ownerOverride(r.id, { message: 'Do not use the cache; call the API directly.' });
  assert.equal(o.status, 'overridden');
  const last = store.listComments(t.key).at(-1);
  assert.deepEqual([last.author, /overrode Morgan's decision[\s\S]*call the API directly/.test(last.body)], ['owner', true]);
  assert.throws(() => delegation.ownerOverride(r.id, { message: 'again' }), /already overrode/);
  // Reopen another one: the ticket waits for the owner again, with a structured hold.
  const t2 = await ask(ticket());
  delegation.sweep({ paused: false });
  const r2 = recFor(`${t2.key}:question`);
  await sched.deskAction(bind(r2), 'decide', { cite: 'R1,E1', action: 'answer', body: 'Yes.', why: 'The code at a.py:1 says so.' });
  store.updateTicket(t2.key, { active_run: 5 });
  assert.throws(() => delegation.ownerReopen(r2.id, {}), /working on it right now/);
  store.updateTicket(t2.key, { active_run: null });
  const ro = delegation.ownerReopen(r2.id, { note: 'I want to look at this one' });
  assert.equal(ro.status, 'reopened');
  const now = store.getTicket(t2.key);
  assert.deepEqual([now.status, now.hold_kind, now.hold_ref], ['needs_human', 'reopened', String(r2.id)]);
  assert.match(store.listComments(t2.key).at(-1).body, /reopened Morgan's decision to reconsider it[\s\S]*Nothing was rolled back/);
  delegation.sweep({ paused: false });
  assert.equal(store.delegationsForTicket(t2.key).filter((x) => ['queued', 'running'].includes(x.status)).length, 0, 'a reopened decision is never delegated again');
  const m = delegation.summary().metrics.kinds.question;
  assert.ok(m.overridden >= 1 && m.reopened >= 1);
});

test('time limits: a decision nobody started within the wait goes to the owner, explained; the halted desk applies nothing', async () => {
  reset();
  policy({ question: 'em' });
  const t = await ask(ticket());
  delegation.sweep({ paused: true });
  assert.equal(recFor(`${t.key}:question`), null, 'halted: no new records');
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:question`);
  store.handle().prepare('UPDATE delegated_decisions SET created_at=? WHERE id=?').run(new Date(Date.now() - 31 * 60_000).toISOString(), r.id);
  delegation.sweep({ paused: true });
  const after = store.getDelegation(r.id);
  assert.equal(after.status, 'escalated'); assert.match(after.why, /did not get to it within 30 minutes \(the desk is halted\)/);
});

test('peer access: off by default; on, the EM approves the SRE\'s ticket-bound access within policy; timed grants and renewals stay yours', () => {
  reset();
  config.ops.enabled = true; store.setSetting('ops_enabled', 'true');
  try {
    const t = ticket({ status: 'in_progress' });
    const off = access.request({ seat: 'sre', probes: ['*'], why: 'verify the fix', ticketScoped: true, ticketKey: t.key, filedBy: 'desk' });
    assert.equal(off.request.status, 'owner'); assert.match(off.request.owner_reason, /Devon approves access, so their own access is the owner's decision/);
    store.updateAccessRequest(off.request.id, { status: 'withdrawn' });
    policy({}, true);
    const t2 = ticket({ status: 'in_progress' });
    const on = access.request({ seat: 'sre', probes: ['*'], why: 'verify the fix', ticketScoped: true, ticketKey: t2.key, filedBy: 'desk' });
    assert.deepEqual([on.request.status, on.request.approver], ['pending', 'manager'], 'the other approver reviews it');
    store.updateAccessRequest(on.request.id, { status: 'withdrawn' });
    const timed = access.request({ seat: 'sre', probes: ['*'], why: 'look around', minutes: 30, ticketScoped: false, ticketKey: null });
    assert.equal(timed.request.status, 'owner'); assert.match(timed.request.owner_reason, /peer access covers ticket-bound grants only/);
    store.updateAccessRequest(timed.request.id, { status: 'withdrawn' });
  } finally { policy({}); store.setSetting('ops_enabled', 'false'); }
});

test('owner-only writes: settings refuse the delegation keys; the API validates the matrix and the switch', async () => {
  for (const k of ['delegation', 'delegation_escalate_all', 'delegation_epoch']) assert.throws(() => store.setSetting(k, 'x'), /Settings → Autonomy/);
  assert.throws(() => delegation.setPolicy({ kinds: { question: 'boss' } }), /mode must be one of/);
  const d = delegation.details();
  assert.deepEqual(d.kinds.map((k) => k.id), ['owner_task', 'question', 'research', 'loop_limit', 'design']);
  assert.ok(d.never.some((x) => /Budget, policies and this matrix/.test(x)));
  assert.deepEqual(d.kinds.find((k) => k.id === 'design').modes, ['owner', 'shadow', 'em', 'sre']);
});

test('incidents: the SRE holds deploying merges and prepares an owner-only revert; the revert merge and the hold release stay yours', async () => {
  reset();
  const deploywatch = await import('../src/deploywatch.js');
  const shipped = ticket({ status: 'done', builder: 'senior-be', assignee: 'senior-be', pr_url: 'https://github.com/o/r/pull/7' });
  const sha = 'a'.repeat(40);
  store.createWatch({ deploy_key: `d-${sha}`, merge_sha: sha, ticket_key: shipped.key, pr: 7, target: 'trader', workflows: '[]', source: 'desk', deployed_at: new Date(Date.now() - 3600_000).toISOString(), trading_path: 1 });
  const inc = store.recordIncident({ signature: `sig-${Math.random()}`, normalized: 'KeyError: price', source_index: 0, label: 'trader', project: 'p', line: 'KeyError: price', ts: store.now() });
  store.updateIncident(inc.id, { status: 'investigating' });
  const run = store.createRun({ agent_id: 'sre', kind: 'investigate', incident_id: inc.id, token: `inv-${Math.random()}`, model: 'claude:opus' });
  await assert.rejects(sched.deskAction(run, 'incident', { action: 'regression', body: '' }), /say why a recent deployment caused it/);
  const out = await sched.deskAction(run, 'incident', { action: 'regression', body: 'KeyError since the deploy: the new price parser drops the field.' });
  assert.match(out, /Held every deploying merge and paged the owner; a revert is being prepared in D-\d+ \(only the owner merges it\)/);
  const w = deploywatch.regressionHold();
  assert.deepEqual([w.merge_sha, w.status, w.hold, w.hold_kind], [sha, 'regression', 1, 'regression'], 'every deploying merge now waits for the owner');
  const revert = store.getTicket(w.revert_key);
  assert.deepEqual([revert.owner_merge_only, revert.risk], [1, 'high'], 'only the owner merges the revert');
  assert.equal(store.getIncident(inc.id).status, 'paged');
  assert.ok(store.listComments(shipped.key).some((c) => c.author === 'sre' && /suspects deploying[\s\S]*Deploying merges are on hold until you clear it/.test(c.body)));
  // Nothing on record to hold: the SRE pages instead.
  store.updateWatch(w.id, { status: 'superseded', hold: 0 });
  await assert.rejects(deploywatch.sreSuspects({ why: 'x', hours: 24 }), /no deployment in the last 24 hours is on record/);
});

test('notices: a delegated hold is announced only when it comes back to the owner, even if the kind is switched off first', async () => {
  reset();
  policy({ question: 'em' });
  store.setSetting('paused', 'false');
  try {
    const t = await ask(ticket());
    const d = `${t.key}:question`;
    const key = store.handle().prepare("SELECT key FROM kv WHERE key LIKE ?").get(`delegation:deferred:${d}:%`)?.key;
    assert.ok(key, 'the hold\'s notice was deferred and remembered');
    const version = key.split(':').at(-1);
    assert.equal(store.kvGet(`delegation:noticed:${d}:${version}`), null, 'not announced yet: Morgan has it');
    // The owner switches questions back to themselves before any record exists: the deferred hold must not sit silent.
    policy({ question: 'owner' });
    delegation.sweep({ paused: false });
    assert.ok(store.kvGet(`delegation:noticed:${d}:${version}`), 'announced once the decision is the owner\'s again');
    // A hold the delegate still has is not announced.
    policy({ question: 'em' });
    const t2 = await ask(ticket());
    delegation.sweep({ paused: false });
    const r2 = recFor(`${t2.key}:question`);
    assert.equal(r2.status, 'queued');
    assert.equal(store.kvGet(`delegation:noticed:${r2.decision_id}:${r2.version}`), null);
  } finally { store.setSetting('paused', 'true'); }
});

test('shadow only takes idle time: its runs queue apart, a late one ends quietly, and the daily allowance never opens one', async () => {
  reset();
  policy({ question: 'shadow', loop_limit: 'em' });
  const s = await ask(ticket());
  const l = ticket({ status: 'needs_human', assignee: 'junior', builder: 'junior', qa_loops: 3, resume_status: 'todo', hold_kind: 'qa_loops' });
  delegation.sweep({ paused: false });
  const rs = recFor(`${s.key}:question`), rl = recFor(`${l.key}:stuck`);
  assert.deepEqual(delegation.nextJobs({ shadow: false }).map((r) => r.id).filter((id) => [rs.id, rl.id].includes(id)), [rl.id], 'decisions for the owner run early in the tick');
  assert.deepEqual(delegation.nextJobs({ shadow: true }).map((r) => r.id).filter((id) => [rs.id, rl.id].includes(id)), [rs.id], 'shadow ones after grooming');
  store.handle().prepare('UPDATE delegated_decisions SET created_at=? WHERE id=?').run(new Date(Date.now() - 31 * 60_000).toISOString(), rs.id);
  delegation.sweep({ paused: false });
  assert.equal(store.getDelegation(rs.id).status, 'failed', 'a shadow decision that never ran is not an escalation');
  assert.equal(delegation.summary().open[`${s.key}:question`], undefined, 'nothing is shown on the card for it');
  const prev = config.delegation.maxPerDay;
  config.delegation.maxPerDay = 0;
  try {
    const s2 = await ask(ticket());
    delegation.sweep({ paused: false });
    assert.equal(recFor(`${s2.key}:question`), null, 'shadow over the allowance: no record, no noise');
  } finally { config.delegation.maxPerDay = prev; }
});

test('overrides replace what the next run reads: a proposal\'s revision notes, and the latest rework note', async () => {
  reset();
  policy({ research: 'em', loop_limit: 'em' });
  const t = store.createTicket({ title: 'Override fixture', status: 'proposed', reporter: 'pm', source: 'research', description: '## Problem\nx\n## Evidence\ny' });
  researchReview.open(t, { program: 'product-discovery', review: { minReviewers: 1, reviewers: ['principal-be'] } }, { id: 1 });
  const rv = store.createResearchReview({ ticket_key: t.key, generation: 1, input_hash: researchReview.hashOf(store.getTicket(t.key)), reviewer: 'principal-be', status: 'pending' });
  researchReview.complete(rv.id, { report: { verdict: 'reject', summary: 'No evidence', evidence_checked: [], findings: ['x'], conditions: ['y'] } });
  delegation.sweep({ paused: false });
  const r = recFor(`${t.key}:research:1`);
  await sched.deskAction(bind(r), 'decide', { cite: 'R1,E1', action: 'changes', body: 'Cite a source.', why: 'The reviewer found no source; the playbook needs one.' });
  delegation.ownerOverride(r.id, { message: 'Narrow it to the alert only and cite the vendor docs.' });
  assert.equal(store.kvGet(`research-notes:${t.key}`), 'Narrow it to the alert only and cite the vendor docs.', 'the revision run reads the owner\'s notes');
  const l = ticket({ status: 'needs_human', assignee: 'junior', builder: 'junior', qa_loops: 3, resume_status: 'todo', hold_kind: 'qa_loops' });
  delegation.sweep({ paused: false });
  const rl = recFor(`${l.key}:stuck`);
  await sched.deskAction(bind(rl), 'decide', { cite: 'R1,E1', action: 'changes', body: 'Fix only the parser.', why: 'Three QA fails on the cache; smallest change.' });
  delegation.ownerOverride(rl.id, { message: 'Keep the cache; fix its key.' });
  const notes = store.listComments(l.key).filter((c) => /^(❌|🔁)/.test(c.body));
  assert.match(notes.at(-1).body, /^🔁 \*\*The owner overrode Morgan's decision\*\*[\s\S]*Keep the cache; fix its key/, 'rework reads the owner\'s note, not Morgan\'s');
});
