// Opt-in real-model comparison, isolated from live tickets, publishing, tools and personal MCP servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--real')) { console.log('Usage: node scripts/evaluate-council.mjs --real [--output FILE]\nRuns 18 bounded read-only CLI calls across 3 cases. Maximum local reservation $30; Codex USD is estimated unless pricing is configured. No live tickets or external actions.'); process.exit(0); }
const outArg = process.argv.indexOf('--output');
const output = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'local', 'council-evaluation.json');
const originalConfig = process.env.SIGMADESK_CONFIG || path.join(root, 'sigmadesk.config.json');
const savedConfig = fs.existsSync(originalConfig) ? JSON.parse(fs.readFileSync(originalConfig, 'utf8')) : {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-council-eval-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'Read-only council comparison fixture\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, githubRepo: 'test/fixture', playbook: path.join(root, 'playbooks/default.md') }, bins: savedConfig.bins || {},
  engines: { codex: { bin: savedConfig.engines?.codex?.bin || '', reserveUsd: 2, models: savedConfig.engines?.codex?.models || [] } },
  limits: { dailyBudgetUsd: 30, maxConcurrent: 3, runBudgetUsd: { sonnet: 1 }, runTimeoutMin: { council_review: 3 } }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_DB = path.join(tmp, 'state.db'); process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
for (const name of ['PERPLEXITY_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','XAI_API_KEY']) delete process.env[name];
const { config } = await import('../src/config.js'); config.root = tmp; fs.symlinkSync(path.join(root, 'bin'), path.join(tmp, 'bin'));
const store = await import('../src/db.js'), council = await import('../src/council.js'), dispatch = await import('../src/dispatch.js');
store.openDb(); store.setSetting('paused', 'false'); store.setSetting('max_concurrent', '3'); store.setSetting('daily_budget_usd', '30');
await dispatch.refreshAvailability();
const initialHealth = dispatch.providerHealth();
if (initialHealth.some((p) => !p.ready)) throw new Error('Both Claude and Codex CLIs must be available for this comparison');
const evidence = [
  { id: 'A', expected: 'changes', root: /reserv|concurrent|overspend|in.flight/i, code: `Contract: concurrent workers must never collectively exceed the daily USD scheduling limit. Each active worker can consume its reserved cap. No database or provider enforces a separate daily cap.\n\nbudget.js:\n1 export function mayStart(daily, spent, activeRuns, nextCap) {\n2   const headroom = daily - spent;\n3   return headroom >= nextCap;\n4 }\n5 // daily=10, spent=0, activeRuns=[{reserve_usd:8}], nextCap=8.` },
  { id: 'B', expected: 'changes', root: /cursor|checkpoint|atomic|transaction|loss|lost|skip/i, code: `Contract: every input log entry must be durably recorded exactly once before the input cursor advances. insertIncident and saveCursor each commit immediately and can throw. Restart resumes strictly after the saved cursor.\n\nwatch.js:\n1 export function ingest(batch, nextCursor) {\n2   saveCursor(nextCursor);\n3   for (const row of batch) insertIncident(row);\n4 }\n5 // A crash may occur between any two statements.` },
  { id: 'C', expected: 'acceptable', root: null, code: `Contract: record a synchronous input batch and cursor atomically. transaction(fn) commits both tables together or rolls back both when fn throws. insertIncident uses a UNIQUE event_id and INSERT ... ON CONFLICT DO NOTHING. saveCursor upserts this source's cursor inside the current transaction. A single writer owns this source. Inputs are validated; nextCursor follows this batch. Assume these database primitives meet the stated contract. Review only the supplied ingest implementation; do not invent missing infrastructure requirements.\n\nwatch.js:\n1 export function ingest(batch, nextCursor) {\n2   transaction(() => {\n3     for (const row of batch) insertIncident(row);\n4     saveCursor(nextCursor);\n5   });\n6 }` },
];
const results = [], started = Date.now();
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), automatic_councils: false, cases: 3, models: council.models().filter((m) => m.engine), results, elapsed_ms: Date.now() - started, caveats: ['Small directional pilot, not a production quality benchmark.', 'Same models, effort and output contract per call; strategies deliberately differ in number of calls.', 'Codex USD is a conservative local estimate, not account credit consumption.', 'Explicit, redacted fixtures; no live ticket mutations or external actions.'] }, null, 2)); };
try {
  for (const item of evidence) {
    const t = store.createTicket({ title: `Review case ${item.id}`, description: item.code, status: 'needs_human', area: 'backend', complexity: 'L' });
    for (const strategy of ['single','sequential','parallel']) {
      const before = Date.now();
      const c = council.create(t.key, { strategy, question: 'Assess whether the supplied implementation meets its stated contract. Identify concrete defects with evidence and a exposing test; otherwise return acceptable with no invented findings.',
        members: strategy === 'single' ? [{ model: 'codex/default', lens: 'architecture' }] : [{ model: 'codex/default', lens: 'architecture' }, { model: 'claude/sonnet', lens: 'reliability' }], synthesizer: 'codex/default' });
      council.queue(c.id); council.pump(); console.log(`Case ${item.id} · ${strategy} started · ${c.members.length} calls`);
      const deadline = Date.now() + 12 * 60000;
      while (['queued','running'].includes(store.getCouncil(c.id).status)) {
        if (Date.now() > deadline) { council.cancel(c.id); break; }
        await new Promise((r) => setTimeout(r, 300)); council.pump();
      }
      const final = council.current(c.id), report = final.result ? JSON.parse(final.result) : null;
      const matched = final.status === 'complete' && report?.verdict === item.expected && (item.root ? item.root.test(JSON.stringify(report.findings)) && report.findings.length > 0 : report.findings.length === 0);
      const runs = final.members.map((m) => m.run).filter(Boolean);
      results.push({ case: item.id, strategy, expected: item.expected, status: final.status, matched, elapsed_ms: Date.now() - before, calls: runs.length,
        cost_usd: runs.reduce((n, r) => n + r.cost_usd, 0), estimated_calls: runs.filter((r) => r.cost_estimated).length, report,
        members: final.members.map((m) => ({ stage: m.stage, model: m.run?.model || m.model, status: m.status, error: m.error, result: m.result ? JSON.parse(m.result) : null, usage: m.run?.usage_json ? JSON.parse(m.run.usage_json) : null })) });
      save(); console.log(`Case ${item.id} · ${strategy}: ${final.status}, ${matched ? 'expected judgment' : 'unexpected/missing judgment'}, ${((Date.now() - before)/1000).toFixed(1)}s`);
    }
  }
  const summary = ['# Council evaluation', '', `Real CLI pilot: ${results.length} comparisons on two known defects and one clean control. Automatic councils remain off.`, '', '| Strategy | Expected judgments | Calls | Time | Reported + estimated USD |', '|---|---:|---:|---:|---:|'];
  for (const strategy of ['single','sequential','parallel']) {
    const rows = results.filter((r) => r.strategy === strategy);
    summary.push(`| ${strategy} | ${rows.filter((r) => r.matched).length}/${rows.length} | ${rows.reduce((n,r)=>n+r.calls,0)} | ${(rows.reduce((n,r)=>n+r.elapsed_ms,0)/1000).toFixed(1)}s | $${rows.reduce((n,r)=>n+r.cost_usd,0).toFixed(2)} |`);
  }
  summary.push('', 'This sample cannot establish a council accuracy advantage. Per-call model and effort are held consistent; calls and total cost differ by strategy. Keep councils on demand for consequential decisions. Expand blinded, independently labeled cases and compare benefit per unit of cost before adding automatic routing. Codex costs above use the local $2 reservation when provider USD is unreported; they are not subscription credit consumption.', '', `Full findings, individual judgments, token usage and failure details: ${path.basename(output)}`);
  fs.writeFileSync(output.replace(/\.json$/, '.md'), summary.join('\n') + '\n');
  console.log(`Saved ${output}`);
} finally {
  council.cancelAll(); await (await import('../src/runner.js')).shutdownAll('evaluation ended');
  fs.rmSync(tmp, { recursive: true, force: true });
}
