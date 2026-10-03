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
store.logEvent({ kind: 'system', text: 'Isolated demo: all execution seats disabled. No production state or credentials are used.' });
console.log(`Preview fixture: ${tmp}`);
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
