// Isolated, paused UI fixture. No real model, publishing, notification, or production data access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-preview-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'Isolated preview fixture\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Preview', '-c', 'user.email=preview@example.com', 'commit', '-qm', 'fixture']);
const cli = path.join(tmp, 'fixture-cli.mjs');
fs.writeFileSync(cli, `#!/usr/bin/env node
import readline from 'node:readline';
if(process.argv.includes('--version')) console.log('preview CLI');
else if(process.argv.includes('app-server')) readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  if(m.method==='account/rateLimits/read') console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:3,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}}));
});
else {process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}})));}
`); fs.chmodSync(cli, 0o755);
const log = path.join(tmp, 'application.log'); fs.writeFileSync(log, 'INFO preview ready\n');
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ server: { port: Number(process.env.SIGMADESK_PORT || 8791), hosts: ['127.0.0.1'], preventIdleSleep: false, preview: true, ...(process.env.SIGMADESK_PREVIEW_TOKEN ? { ownerToken: process.env.SIGMADESK_PREVIEW_TOKEN } : {}) /* tests of the sign-in link */ },
  project: { name: 'SigmaDesk · local preview', repoPath: repo, githubRepo: 'test/fixture', playbook: path.join(root, 'playbooks/default.md') },
  bins: { claude: cli }, engines: { codex: { bin: cli } }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false },
  watch: { enabled: true, intervalSeconds: 5, sources: [{ type: 'file', path: log, label: 'Preview service' }] }, notify: { webhookUrl: '' },
  // Decision demo: one workflow mapped to a service (the brief names a target only from this), read-only probes configured.
  ...(process.env.SIGMADESK_DECISION_DEMO === '1' ? { deploy: { targets: { 'deploy-mac-mini.yml': 'alpaca-trader' } }, ops: { enabled: true } } : {}) }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_DB = path.join(tmp, 'state.db'); process.env.SIGMADESK_SOCKET = path.join(tmp, 'run', 'agent.sock'); process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
process.env.CODEX_HOME = path.join(tmp, 'owner-codex'); fs.mkdirSync(process.env.CODEX_HOME);
for (const name of ['PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'SIGMADESK_TOKEN']) delete process.env[name];
const { config } = await import('../src/config.js'); config.root = tmp;
fs.symlinkSync(path.join(root, 'public'), path.join(tmp, 'public'));
fs.symlinkSync(path.join(root, 'bin'), path.join(tmp, 'bin'));
const server = await import('../src/server.js'); const store = await import('../src/db.js');
await server.main();
const team = await import('../src/team.js');
store.setSetting('team', JSON.stringify(Object.fromEntries(team.AGENTS.map((a) => [a.id, { engine: a.engine, model: a.model, effort: a.effort, enabled: false }]))));
team.applyTeamOverrides(JSON.parse(store.getSettings().team)); store.setSetting('team_confirmed', 'true');
store.kvSet('quota:claude', JSON.stringify({ engine: 'claude', source: 'Preview fixture', at: store.now(), five_hour: .99, seven_day: .16, resets_at: new Date(Date.now() + 3600000).toISOString() }));
const tickets = [
  ['qa', 'Verify provider fallback and budget accounting', 'qa', 'P1', 'backend', 'M'],
  ['todo', 'Improve the mobile navigation and ticket composer', 'senior-fe', 'P1', 'frontend', 'M'],
  ['todo', 'Add a clear SRE source-health summary', 'junior', 'P2', 'fullstack', 'S'],
  ['ready_for_human', 'Preserve review contracts when switching models', 'senior-be', 'P2', 'backend', 'M'],
  ['needs_human', 'Choose the acceptance contract for the alert policy', 'manager', 'P1', 'backend', 'M'],
  ['proposed', 'Compare task-specific models through a peer review', 'principal-be', 'P2', 'backend', 'L'],
  ['triage', 'Expose why a queued ticket is waiting', 'support', 'P2', 'frontend', 'S'],
  ['done', 'Separate read-only workspaces by engineer', 'senior-be', 'P1', 'backend', 'M'],
];
for (const [status, title, assignee, priority, area, complexity] of tickets) {
  const t = store.createTicket({ title, status, assignee, priority, area, complexity, reporter: 'owner', description: 'Make the workflow usable and observable.\n\nAcceptance criteria:\n- Show accurate state and recovery behavior.\n- Preserve the ticket draft during updates.\n- Verify desktop and phone layouts locally.' });
  if (status === 'needs_human') {
    store.updateTicket(t.key, { resume_status: 'todo' }); store.addComment(t.key, 'manager', '❓ Should alerts page after three errors in ten minutes?');
    const d = store.createDiscussion(t.key, 'Discuss a feature integration branch with the manager and principals.');
    const response = 'Use a short-lived feature integration branch for coupled work. QA each slice, validate the combined candidate, and keep the final merge with the owner. Simple independent fixes can follow the existing draft PR workflow.';
    store.updateDiscussion(d.id, { status: 'complete', response, ended_at: store.now() });
    store.addComment(t.key, 'manager', `💬 **Design response #${d.id}**\n\n${response}`);
  }
  if (status === 'ready_for_human') store.addComment(t.key, 'qa', 'Verified the submitted commit and the relevant tests. Ready for owner review.');
}
// Features: one plan waiting for the owner, one approved and building. No model calls: plans are fixtures.
{
  const features = await import('../src/features.js');
  const plan = (title) => ({ summary: `Record what each ${title} costs, observe-only, so slippage per strategy is visible before any change to trading.`,
    goal: 'The owner can see the real cost of every options fill per strategy, without touching order flow.', users: ['Owner reviewing ETF4 performance each evening'],
    scope: ['A journal table with one row per fill', 'An observe-only writer behind a flag', 'A daily summary on the dashboard'], out_of_scope: ['Any change to order placement or sizing'],
    acceptance: ['Every filled order has exactly one journal row', 'Turning the flag off stops writes with no other effect', 'The summary matches the broker statement within one cent'],
    risks: ['The writer runs next to the trading loop: it must never block or raise into it'], questions: ['Should partial fills be one row or one row per partial?'],
    tasks: [
      { ref: 'T1', title: 'Define the fill-cost journal contract and DDL', area: 'db', complexity: 'S', risk: 'low', after: null, description: 'Draft the table, indexes and retention. Files: `migrations/`, `docs/journal.md`.', acceptance: ['Reviewed DDL', 'Retention documented'] },
      { ref: 'T2', title: 'Write fills to the journal behind a flag', area: 'backend', complexity: 'M', risk: 'high', after: 'T1', description: 'Observe-only writer in the fill handler, off by default, never raising into the loop.', acceptance: ['No order path changed', 'Flag off means no writes'] },
      { ref: 'T3', title: 'Show a daily fill-cost summary', area: 'frontend', complexity: 'S', risk: 'low', after: 'T2', description: 'A card on the dashboard with cost per strategy for the day.', acceptance: ['Matches the journal totals'] },
    ] });
  const groomed = (key, title) => {
    const p = features.current(key);
    store.kvSet(`feature-plan:${key}`, JSON.stringify({ ...p, stale: undefined, status: 'grooming', attempt: 'demo' }));
    return features.complete(key, p.revision, 'demo', { plan: features.parsePlan(JSON.stringify(plan(title))), model: 'codex:gpt-6.1-sol' });
  };
  const a = features.create({ title: 'Options fill-cost journal', goal: 'Record what each ETF4 options fill actually cost, so I can see slippage per strategy. Observe-only: never touch orders.', priority: 'P1', area: 'backend' }).ticket;
  groomed(a.key, 'options fill');
  const b = features.create({ title: 'Equity fill-cost journal', goal: 'Same idea for equity fills, after the options journal proves itself.', priority: 'P2', area: 'backend' }).ticket;
  const ready = groomed(b.key, 'equity fill');
  const { tasks } = features.approve(b.key, { expected_revision: ready.revision });
  store.updateTicket(tasks[0], { status: 'done' });
  // A principal split the writer task into slices: a nested epic, the second slice ordered after the first.
  store.updateTicket(tasks[1], { status: 'in_progress', assignee: 'principal-be' });
  const s1 = store.createTicket({ title: 'Normalize equity fills into the journal contract', status: 'needs_human', type: 'task', area: 'backend', complexity: 'M', assignee: 'senior-be', reporter: 'principal-be', source: 'agent', parent_key: tasks[1] });
  store.updateTicket(s1.key, { resume_status: 'todo' }); store.addComment(s1.key, 'senior-be', '❓ **Question for the owner:** Should odd-lot fills be journaled, or skipped like the options journal?');
  const s2 = store.createTicket({ title: 'Replay yesterday’s equity fills into the journal', status: 'todo', type: 'task', area: 'backend', complexity: 'S', assignee: 'junior', reporter: 'principal-be', source: 'agent', parent_key: tasks[1] });
  store.updateTicket(s2.key, { after_key: s1.key });
  // A feature the team split before grooming existed (no plan), whose order lives only in its text: the Next step card,
  // one-tap gates and the Inbox's grouped question are built for this shape.
  const audit = store.createTicket({ title: 'Fill audit', description: 'Prove fills match the broker before any journal ships.', status: 'in_progress', type: 'feature', priority: 'P1', area: 'backend', assignee: 'manager' });
  const v = store.createTicket({ title: 'Verify fills on the production box', status: 'needs_human', type: 'task', area: 'infra', complexity: 'S', assignee: 'sre', parent_key: audit.key, description: 'Count yesterday\'s fills in the production database.' });
  store.updateTicket(v.key, { resume_status: 'todo', progress_msg: 'needs production access' }); store.addComment(v.key, 'sre', '❓ **Question for the owner:** I have no production access. Can you run the count, or grant read access?');
  const c = store.createTicket({ title: 'Audit contract and DDL', status: 'needs_human', type: 'task', area: 'db', complexity: 'S', assignee: 'dba', parent_key: audit.key, description: `Draft the audit table. Gated on ${v.key} reporting nonzero rows.` });
  store.updateTicket(c.key, { resume_status: 'todo' }); store.addComment(c.key, 'dba', `❓ **Question for the owner:** Should I wait for ${v.key}, or draft the DDL now?`);
  store.createTicket({ title: 'Backfill the audit table', status: 'todo', type: 'task', area: 'backend', complexity: 'S', assignee: 'junior', parent_key: audit.key, description: `Blocked by ${c.key}; replay the last week.` });
}
// Delegation (#9) fixtures: what Morgan would answer (shadow), one question Morgan left to the owner, and one Morgan
// answered for the owner ("Decided for you"). Records only: no decision run, no model call.
{
  const delegation = await import('../src/delegation.js');
  const asked = (prefix) => {
    const t = store.listTickets().find((x) => x.title.startsWith(prefix));
    const q = store.listComments(t.key).find((c) => c.body.startsWith('❓'));
    return store.updateTicket(t.key, { hold_kind: 'question', hold_seat: q.author, hold_ref: String(q.id) });
  };
  const record = (t, extra) => {
    const c = delegation.candidates().find((x) => x.ticket.key === t.key);
    return store.createDelegation({ kind: 'question', decision_id: c.decision_id, ticket_key: t.key, version: c.version, policy_version: 'demo', delegation_version: delegation.version(),
      mode: 'shadow', seat: 'manager', asker: t.hold_seat, allowed: ['answer', 'escalate'], brief: { you_decide: `Answer ${agentByIdName(t.hold_seat)}`, gate: { headline: 'Ready for you.' } },
      provenance: { decided_for: 'owner', by: 'manager', deterministic: false }, decided_at: store.now(), ended_at: store.now(), ...extra }).row;
  };
  record(asked('Normalize equity fills'), { status: 'shadow', action: 'answer', text: 'Skip odd lots, as the options journal does: the playbook says one journal contract.', why: 'docs/journal.md defines one row per round-lot fill; the options journal skips odd lots.' });
  const v = asked('Verify fills on the production box');
  const e = record(v, { status: 'shadow' });
  store.updateDelegation(e.id, { status: 'escalated', action: 'escalate', why: 'it needs production access, which only you can grant', recommendation: `Grant ${agentByIdName('sre')} read access for this ticket.` });
  // Its own ticket, so the other fixtures (and the tests that read them) keep their questions.
  const own = store.createTicket({ title: 'Rename the retry helper', status: 'needs_human', type: 'task', area: 'backend', complexity: 'S', assignee: 'junior', reporter: 'owner', description: 'Give the shared retry helper a clearer name.' });
  store.updateTicket(own.key, { resume_status: 'todo', risk: 'low' }); store.addComment(own.key, 'junior', '❓ **Question for the owner:** Is `retry_call` used outside utils/net.py?');
  const d = asked('Rename the retry helper');
  const done = record(d, { status: 'applied', mode: 'em', action: 'answer', text: 'Only in utils/net.py and its tests: rename it there and in tests/test_net.py.', why: 'A repository search finds retry_call in utils/net.py:40 and tests/test_net.py only; the playbook says keep renames in one change.' });
  const c = store.addComment(d.key, 'manager', `💬 **Morgan answered Riley for you**\n\n${done.text}\n\n_Decided for the owner by Morgan under the delegation policy (engineers' questions → Morgan). The owner can override or reopen this in the Inbox._`);
  store.updateDelegation(done.id, { comment_id: c.id });
  store.updateTicket(d.key, { status: 'todo', resume_status: null });
  // Long copy, for narrow screens: a long ticket title and a long answer must still fold into two lines.
  const long = store.createTicket({ title: 'Normalize the broker fill timestamps across every venue adapter, the nightly reconciliation job and the audit export', status: 'needs_human', type: 'task', area: 'backend', complexity: 'S', assignee: 'senior-be', reporter: 'owner', description: 'Fills from three venues carry local timestamps; the audit export assumes UTC.' });
  store.updateTicket(long.key, { resume_status: 'todo', risk: 'low' }); store.addComment(long.key, 'senior-be', '❓ **Question for the owner:** Which module converts venue timestamps today, and is it already used by the reconciliation job?');
  const l = asked('Normalize the broker fill timestamps');
  const lr = record(l, { status: 'applied', mode: 'em', action: 'answer', text: 'adapters/timefmt.py converts venue-local timestamps to UTC in to_utc(), and the nightly reconciliation job already calls it through recon/load.py, so the audit export should call to_utc() too instead of adding a second converter with its own daylight-saving rules.', why: 'adapters/timefmt.py:12 defines to_utc(); recon/load.py:88 calls it; the playbook says reuse the existing helper.' });
  const lc = store.addComment(l.key, 'manager', `💬 **Morgan answered Jordan for you**\n\n${lr.text}\n\n_Decided for the owner by Morgan under the delegation policy (engineers' questions → Morgan). The owner can override or reopen this in the Inbox._`);
  store.updateDelegation(lr.id, { comment_id: lc.id });
  store.updateTicket(l.key, { status: 'todo', resume_status: null });
}
function agentByIdName(id) { return String((team.agentById[id] || {}).name || id).split(/\s+/)[0]; }
store.logEvent({ kind: 'system', text: 'Isolated demo: all execution seats disabled. No production state or credentials are used.' });
console.log(`Preview fixture: ${tmp}`);
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// Explicit demo council: no model calls; useful for validating the owner decision UX.
const council = await import('../src/council.js');
const ticket = store.listTickets().find((t) => t.status === 'proposed');
const sample = council.create(ticket.key, { question: 'Demo: assess durable provider routing and safe review boundaries.', members: [{ model: 'codex/default', lens: 'architecture' }, { model: 'claude/sonnet', lens: 'reliability' }], synthesizer: 'codex/default' });
const report = { verdict: 'changes', recommendation: 'Demo recommendation: freeze the review brief, reserve each call, and preserve dissent before the owner makes a design decision.', findings: [{ severity: 'medium', evidence: 'Demo acceptance contract: a changed candidate invalidates an earlier report.', issue: 'A stale report could guide a changed implementation.', test: 'Change the candidate SHA and verify approval is disabled.' }], alternatives: ['Use one reviewer for routine small work.'], dissent: ['A second reviewer may cost more without finding additional defects.'], conditions: ['Run independent QA on the exact implementation commit.'] };
for (const m of sample.members) store.updateCouncilMember(m.id, { status: 'complete', result: JSON.stringify(report), ended_at: store.now() });
store.updateCouncil(sample.id, { status: 'complete', result: JSON.stringify(report), ended_at: store.now() });

if (process.env.SIGMADESK_REVIEW_DEMO === '1') {
  const reviews = await import('../src/product-review.js');
  const demo = store.listTickets().find(t=>t.area==='frontend' && t.status==='todo');
  const r = reviews.start(demo.key);
  for (const m of [...r.members.filter(m=>m.stage==='review'),r.members.find(m=>m.agent_id==='product-design'),r.members.at(-1)]) reviews.complete(demo.key,'plan',r.revision,m.agent_id,{model:'codex/demo',report:{
    verdict:m.agent_id==='product-design'?'concern':'support',recommendation:m.agent_id==='product-design'?'Keep the message draft visible when new updates arrive.':'Build a small preview and measure task completion.',
    users:['Owner reviewing work on a phone'],benefits:['Less searching for the current status'],drawbacks:['More controls on a small screen'],alternatives:['Keep the existing expanded log'],evidence:['Demo acceptance criteria and fixture state'],conditions:m.agent_id==='product-design'?['Verify draft preservation at 390px']:[],architecture:'Reuse the task sheet and event stream.',rollout:'Preview, limited rollout, then general use; revert on draft loss.',success_metric:'Reviewers can find the latest update and retain their reply draft.'}});
}

// Presence demo (SIGMADESK_PRESENCE_DEMO=1): fixture runs so the ticket's "who is writing" strip has real rows to read.
// The two runs on the composer ticket post a fresh step every 15 s while the preview lives (so they stay "writing");
// a third seat's run started 8 minutes ago and never posted (stalled). Nothing executes; no model is called.
if (process.env.SIGMADESK_PRESENCE_DEMO === '1') {
  const byTitle = (s) => store.listTickets().find((t) => t.title.startsWith(s));
  const composer = byTitle('Improve the mobile navigation'), sre = byTitle('Add a clear SRE source-health summary');
  store.updateTicket(composer.key, { status: 'qa', progress_msg: 'waiting for QA' });
  const live = (agent_id, ticket_key, kind) => {
    const run = store.createRun({ agent_id, ticket_key, kind, token: `demo-${agent_id}`, model: 'demo:fixture' });
    store.updateAgent(agent_id, { status: 'working', current_ticket: ticket_key, current_run: run.id, current_kind: kind });
    return run;
  };
  const quinn = live('senior-fe', composer.key, 'respond'), sage = live('principal-fe', composer.key, 'review');
  const stuck = live('junior', sre.key, 'implement');
  store.updateRun(stuck.id, { started_at: new Date(Date.now() - 8 * 60_000).toISOString() });
  store.logEvent({ run_id: quinn.id, agent_id: 'senior-fe', ticket_key: composer.key, kind: 'plan', text: '✓ Read the review notes\n▸ Keep the draft through live updates\n· Re-run the phone checks' });
  const steps = [
    ['senior-fe', quinn, 'tool', 'Reading ui/src/ticket/TicketSheet.tsx'], ['principal-fe', sage, 'tool', 'Reading ui/src/components/desk/Panel.tsx'],
    ['senior-fe', quinn, 'tool', 'Editing ui/src/ticket/parts.tsx'], ['principal-fe', sage, 'action', 'Drafting the review'],
    ['senior-fe', quinn, 'tool', '$ npm test'], ['principal-fe', sage, 'tool', 'Searching for “onTyping” in ui/src'],
  ];
  let i = 0;
  const step = () => { for (const k of [0, 1]) { const [agent_id, run, kind, text] = steps[(i + k) % steps.length]; store.logEvent({ run_id: run.id, agent_id, ticket_key: composer.key, kind, text }); } i += 2; };
  step(); setInterval(step, 15_000).unref();
}

// Mentions demo (SIGMADESK_MENTIONS_DEMO=1): Rowan and Devon are switched on (the desk stays paused, so nothing runs),
// and one ticket carries an owner message that tagged three seats, one delivery in each finished state.
if (process.env.SIGMADESK_MENTIONS_DEMO === '1') {
  const overrides = JSON.parse(store.getSettings().team);
  for (const id of ['principal-be', 'sre']) overrides[id] = { ...overrides[id], enabled: true };
  store.setSetting('team', JSON.stringify(overrides)); team.applyTeamOverrides(overrides);
  const t = store.createTicket({ title: 'Retry fix for the NYSE TICK feed', status: 'todo', assignee: 'senior-be', priority: 'P1', area: 'backend', complexity: 'M', reporter: 'owner',
    description: 'The tick feed drops after a reconnect. Make the retry cover NYSE TICK.' });
  const c = store.addComment(t.key, 'owner', '@Rowan @Devon @Quinn does the retry fix also cover NYSE TICK?');
  store.addParticipants(t.key, ['principal-be', 'sre', 'senior-fe'], 'owner');
  const reply = store.addComment(t.key, 'principal-be', 'Yes: the guard lives in the shared fetcher, so NYSE TICK is covered. A test for it is worth adding.');
  const r = store.createMention({ ticket_key: t.key, comment_id: c.id, seat_id: 'principal-be' });
  store.updateMention(r.id, { status: 'replied', reply_comment_id: reply.id, attempts: 1, ended_at: store.now() });
  const f = store.createMention({ ticket_key: t.key, comment_id: c.id, seat_id: 'sre' });
  store.updateMention(f.id, { status: 'failed', reason: 'Devon ended without an answer; tried 3 times', attempts: 3, ended_at: store.now() });
  store.createMention({ ticket_key: t.key, comment_id: c.id, seat_id: 'senior-fe', status: 'blocked', reason: 'Quinn is switched off (Settings → Team), so nobody would read this. Switch Quinn on, or tag someone else.' });
}

// Team demo (SIGMADESK_TEAM_DEMO=1): a busy desk for the Team overview and its Wall mode. Most seats are switched on (the
// desk stays paused, so the scheduler starts nothing); fixture runs post steps every 15 s (working), one went quiet, one
// stalled; hand-off events (QA, review, slices, a tag, a verify, an access grant) are logged as the desk logs them, and a
// new one arrives every 20 s. No model is called.
if (process.env.SIGMADESK_TEAM_DEMO === '1') {
  store.setSetting('paused', 'true');
  const overrides = JSON.parse(store.getSettings().team);
  for (const id of Object.keys(overrides)) overrides[id] = { ...overrides[id], enabled: !['support', 'quant-research'].includes(id) };
  store.setSetting('team', JSON.stringify(overrides)); team.applyTeamOverrides(overrides);
  const db = store.handle();
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const backdate = (ev, ms) => { db.prepare('UPDATE events SET ts=? WHERE id=?').run(ago(ms), ev.id); return ev; };
  const byTitle = (s) => store.listTickets().find((t) => t.title.startsWith(s));
  const T = {
    composer: byTitle('Improve the mobile navigation'), fallback: byTitle('Verify provider fallback'), contracts: byTitle('Preserve review contracts'),
    sre: byTitle('Add a clear SRE source-health summary'), compare: byTitle('Compare task-specific models'), queued: byTitle('Expose why a queued ticket'),
    verify: byTitle('Verify fills on the production box'), audit: byTitle('Audit contract and DDL'), normalize: byTitle('Normalize equity fills'), replay: byTitle('Replay yesterday'),
  };
  // Release facts: one change merged this week, a production check reported, and an open backend defect.
  const merged = store.createTicket({ title: 'Show fills per strategy on the dashboard', status: 'done', assignee: 'senior-fe', priority: 'P2', area: 'frontend', complexity: 'S', reporter: 'owner' });
  store.updateTicket(merged.key, { pr_url: 'https://github.com/test/fixture/pull/12', done_at: ago(26 * 3600_000) });
  store.createTicket({ title: 'Partial fills double-count fees', status: 'todo', type: 'bug', assignee: 'senior-be', priority: 'P1', area: 'backend', complexity: 'S', reporter: 'sre' });
  // Live runs.
  const live = (agent_id, ticket_key, kind, startedMs) => {
    const run = store.createRun({ agent_id, ticket_key, kind, token: `demo-${agent_id}`, model: 'demo:fixture' });
    store.updateRun(run.id, { started_at: ago(startedMs), cost_usd: 0.05 });
    store.updateAgent(agent_id, { status: 'working', current_ticket: ticket_key, current_run: run.id, current_kind: kind });
    return run;
  };
  store.updateTicket(T.composer.key, { status: 'review', assignee: 'senior-fe' });
  const R = {
    sfe: live('senior-fe', T.queued.key, 'implement', 14 * 60_000), pfe: live('principal-fe', T.composer.key, 'review', 6 * 60_000),
    sbe: live('senior-be', T.contracts.key, 'respond', 11 * 60_000), qa: live('qa', T.fallback.key, 'qa', 7 * 60_000),
    em: live('manager', T.compare.key, 'groom', 5 * 60_000), dba: live('dba', T.audit.key, 'implement', 9 * 60_000),
    jr: live('junior', T.sre.key, 'implement', 8 * 60_000), sre: live('sre', T.verify.key, 'verify', 6 * 60_000), pm: live('pm', null, 'research', 3 * 60_000),
  };
  const step = (who, run, key, kind, text, ms) => backdate(store.logEvent({ run_id: run.id, agent_id: who, ticket_key: key, kind, text }), ms);
  step('dba', R.dba, T.audit.key, 'tool', 'Editing migrations/0042_fill_audit.sql', 90_000); // quiet: last step 90 s ago
  step('sre', R.sre, T.verify.key, 'tool', '$ desk probe db.count fills --since yesterday', 2 * 60_000);
  // Hand-offs in the last 15 minutes, worded exactly as the desk words them.
  const at = (agent_id, ticket_key, kind, text, ms, run_id = null) => backdate(store.logEvent({ agent_id, ticket_key, kind, text, run_id }), ms);
  at('manager', T.queued.key, 'action', `groomed ${T.queued.key} → S/frontend, staffed Senior Frontend Engineer`, 14.5 * 60_000);
  at('senior-fe', T.queued.key, 'pickup', `Senior Frontend Engineer picked up ${T.queued.key}`, 14 * 60_000);
  at('principal-be', T.normalize.key, 'action', `sliced ${T.normalize.key} (M) for Senior Backend Engineer`, 12 * 60_000);
  at('principal-be', T.replay.key, 'action', `sliced ${T.replay.key} (S) for Junior Engineer after ${T.normalize.key}`, 11.5 * 60_000);
  at('senior-be', T.fallback.key, 'action', `submitted ${T.fallback.key} for QA (4be91c2)`, 8 * 60_000);
  at('qa', T.fallback.key, 'pickup', `QA picked up ${T.fallback.key}`, 7 * 60_000);
  at('senior-fe', T.composer.key, 'action', `submitted ${T.composer.key} for QA (a17c0de)`, 9 * 60_000);
  at('principal-fe', T.composer.key, 'pickup', `Principal Frontend Engineer is reviewing ${T.composer.key} at a17c0de (frontend reviewer)`, 6 * 60_000);
  at('sre', T.verify.key, 'pickup', `verifying in production: ${T.verify.title}`, 6 * 60_000);
  at('sre', T.verify.key, 'run', 'Site Reliability Engineer started mention on opus (high)', 4.5 * 60_000);
  at('manager', null, 'action', 'Morgan gave Devon production read access for 1 hour to use the read-only probes — counting yesterday\'s fills', 3.5 * 60_000);
  at('sre', T.verify.key, 'action', "answered the owner's tag: yes — 1,284 fills yesterday, matching the broker", 2.5 * 60_000);
  at('sre', T.verify.key, 'action', 'verified in production: yesterday\'s fill count matches the broker', 2 * 60_000);
  at('manager', T.compare.key, 'pickup', `Engineering Manager is grooming ${T.compare.key}`, 5 * 60_000);
  // Live: working seats post a step every 15 s; a fresh hand-off arrives every 20 s.
  const steps = [['senior-fe', R.sfe, T.queued.key, 'tool', 'Editing ui/src/pages/Work.tsx'], ['principal-fe', R.pfe, T.composer.key, 'action', 'Drafting the review'],
    ['senior-be', R.sbe, T.contracts.key, 'tool', '$ npm test -- reviews'], ['qa', R.qa, T.fallback.key, 'tool', '$ node --test test/usage.test.js'],
    ['manager', R.em, T.compare.key, 'plan', '✓ Read the proposal\n▸ Size the comparison\n· Staff it'], ['pm', R.pm, null, 'say', 'Comparing three desks’ review flows']];
  const tick = () => { for (const [who, run, key, kind, text] of steps) store.logEvent({ run_id: run.id, agent_id: who, ticket_key: key, kind, text }); };
  tick(); setInterval(tick, 15_000).unref();
  const handoffs = [
    () => ['qa', T.fallback.key, 'pickup', `QA picked up ${T.fallback.key}`],
    () => ['principal-be', T.replay.key, 'action', `sliced ${T.replay.key} (S) for Junior Engineer`],
    () => ['principal-fe', T.composer.key, 'pickup', `Principal Frontend Engineer is reviewing ${T.composer.key} at a17c0de (frontend reviewer)`],
    () => ['sre', T.verify.key, 'action', "answered the owner's tag: the counts match"],
  ];
  let h = 0;
  setInterval(() => { const [a, k, kind, text] = handoffs[h++ % handoffs.length](); store.logEvent({ agent_id: a, ticket_key: k, kind, text }); }, 20_000).unref();
}

// Decision demo (SIGMADESK_DECISION_DEMO=1): merge decisions with real-shaped evidence for the decision snapshot (#6).
// The facts the desk reads from git and GitHub in the background (which workflows a merge starts, the CI rollup) are
// seeded exactly as the desk caches them, each pinned to a commit; one merge carries CI read for an OLDER commit (stale)
// and edits its own workflow file without the approved commit's version having been read (consequence unknown). A merged ticket is ready for "Verify in production" (read access on, the SRE
// on, a timed grant running). Nothing runs: the desk stays paused and no model or GitHub call is made.
if (process.env.SIGMADESK_DECISION_DEMO === '1') {
  store.setSetting('paused', 'true');
  const overrides = JSON.parse(store.getSettings().team);
  for (const id of ['manager', 'sre', 'senior-be', 'senior-fe', 'principal-be', 'qa']) overrides[id] = { ...overrides[id], enabled: true };
  store.setSetting('team', JSON.stringify(overrides)); team.applyTeamOverrides(overrides);
  store.setSetting('ops_enabled', 'true'); // GitHub sync stays off: the preview never calls GitHub
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const decisionMod = await import('../src/decision.js');
  store.kvSet('train:base', '9c41e07d2b5a6f18'); // the base the desk last observed (what CI below was read against)
  const H1 = 'a17c0de9b14f2e7d', H2 = '5e2d9f01c77ab3e4', OLD = '4be91c2aa83f1d02';
  const merge = (t, { head, risk, diffRisk, files, deploy, ci, approvedMin, qaMin, since: waited }) => {
    store.updateTicket(t.key, { status: 'ready_for_human', pr_url: `https://github.com/test/fixture/pull/${t.id + 10}`, branch: `sigmadesk/${t.key.toLowerCase()}`, head_sha: head, qa_sha: head,
      risk, diff_risk: diffRisk, review_stage: 'approved', approved_at: ago(approvedMin) });
    const qa = store.createRun({ agent_id: 'qa', ticket_key: t.key, kind: 'qa', token: null, model: 'demo:fixture' });
    store.updateRun(qa.id, { status: 'done', started_at: ago(qaMin + 6), ended_at: ago(qaMin) });
    for (const [seat, role, min] of [['manager', 'context', approvedMin + 8], ['principal-be', 'independent', approvedMin]]) {
      const r = store.createPrReview({ ticket_key: t.key, seat, role, sha: head });
      store.updatePrReview(r.id, { verdict: 'approve', published_comment_id: `c${r.id}`, body: 'Approved: the contract is preserved and covered by tests.' });
      store.handle().prepare('UPDATE pr_reviews SET updated_at=? WHERE id=?').run(ago(min), r.id);
    }
    store.kvSet(`diff-files:${t.key}`, JSON.stringify(files));
    store.kvSet(`decision:deploy:${t.key}`, JSON.stringify({ head, base: store.kvGet('train:base') || null, cfg: decisionMod.classificationVersion(), ci_key: decisionMod.checksPolicyVersion(), files, at: ago(2), ...deploy }));
    store.kvSet(`decision:ci:${t.key}`, JSON.stringify({ at: ago(ci.min), sha: ci.sha, state: 'OPEN', base: 'main', base_sha: store.kvGet('train:base') || null, checks: ci.checks, mergeable: 'MERGEABLE', rollup: [{ name: 'test', conclusion: 'SUCCESS' }] }));
    const since = JSON.parse(store.kvGet('inbox:since') || '{}'); since[`${t.key}:merge`] = ago(waited); store.kvSet('inbox:since', JSON.stringify(since));
    store.kvSet('inbox:since:seeded', store.now());
    return t;
  };
  const contracts = store.listTickets().find((t) => t.title.startsWith('Preserve review contracts'));
  merge(contracts, { head: H1, risk: 'high', diffRisk: 'high', approvedMin: 41, qaMin: 64, since: 190,
    files: ['alpaca_trader/app/oms/exit_monitor.py', 'alpaca_trader/tests/test_exit_monitor.py'],
    deploy: { state: 'deploys', workflows_at: 'base', workflows: [{ file: '.github/workflows/deploy-mac-mini.yml', name: 'Deploy to Mac mini', reason: 'runs on push to main' }], reason: 'it redeploys via Deploy to Mac mini' },
    ci: { min: 4, sha: H1, checks: 'passing' } });
  store.addComment(contracts.key, 'senior-be', '🚀 Submitted: review contracts survive a model switch; the exit monitor keeps its thresholds.');
  const next = store.createTicket({ title: 'Switch reviewers to the new model', status: 'todo', assignee: 'senior-be', priority: 'P2', area: 'backend', complexity: 'S', reporter: 'owner', source: 'human' });
  store.updateTicket(next.key, { after_key: contracts.key });
  const docs = store.createTicket({ title: 'Publish the runbook site from the docs folder', status: 'todo', assignee: 'senior-fe', priority: 'P2', area: 'frontend', complexity: 'S', reporter: 'owner', source: 'human' });
  merge(docs, { head: H2, risk: null, diffRisk: 'low', approvedMin: 18, qaMin: 30, since: 35,
    files: ['docs/runbook.md', '.github/workflows/docs-site.yml'],
    deploy: { state: 'deploys', workflows: [{ file: '.github/workflows/docs-site.yml', name: 'Docs site', reason: 'runs on push to main' }], reason: 'it redeploys via Docs site' },
    ci: { min: 52, sha: OLD, checks: 'passing' } });
  // A merged ticket ("Verify in production" files a linked task) with a running timed grant for the SRE.
  const shipped = store.listTickets().find((t) => t.status === 'done');
  store.updateTicket(shipped.key, { pr_url: 'https://github.com/test/fixture/pull/9', done_at: ago(26 * 60) });
  const access = await import('../src/access.js');
  access.ownerGrant({ seat: 'sre', probes: ['*'], minutes: 45, ticket_key: null, standing: false, reason: 'Preview: checking the fill counts' });
  store.addParticipants(contracts.key, ['sre'], 'owner'); // the SRE's timed grant shows in that ticket's autonomy line
}
