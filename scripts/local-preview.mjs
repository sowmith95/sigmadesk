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
fs.writeFileSync(cfg, JSON.stringify({ server: { port: Number(process.env.SIGMADESK_PORT || 8791), hosts: ['127.0.0.1'], preventIdleSleep: false, preview: true },
  project: { name: 'SigmaDesk · local preview', repoPath: repo, githubRepo: 'test/fixture', playbook: path.join(root, 'playbooks/default.md') },
  bins: { claude: cli }, engines: { codex: { bin: cli } }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false },
  watch: { enabled: true, intervalSeconds: 5, sources: [{ type: 'file', path: log, label: 'Preview service' }] }, notify: { webhookUrl: '' } }));
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
