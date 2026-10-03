#!/usr/bin/env node
// `npm run doctor` — checks that this machine can run a desk before you open it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { config, validateConfig } from './config.js';
import { detectEngines } from './engines/index.js';

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { console.log(`  ✖ ${m}`); process.exitCode = 1; };
const warn = (m) => console.log(`  ! ${m}`);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();

console.log(`SigmaDesk doctor — config: ${fs.existsSync(config.configFile) ? config.configFile : '(defaults only — copy sigmadesk.config.example.json)'}`);
const problems = validateConfig();
problems.length ? problems.forEach(bad) : ok(`project "${config.project.name}" → ${config.project.repoPath}`);

const [maj, min] = process.versions.node.split('.').map(Number);
maj > 22 || (maj === 22 && min >= 13) ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} — need ≥ 22.13 (node:sqlite)`);

const engines = await detectEngines();
for (const e of engines) e.available ? ok(`${e.label}: ${e.version}`) : warn(`${e.label} unavailable`);
if (!engines.some((e) => e.available)) bad('No runnable engine');
try { run('git', ['--version']); ok('git'); } catch { bad('git missing'); }

if (config.github.sync) {
  try { run(config.bins.gh, ['auth', 'status']); ok(`gh authenticated · repo ${config.project.githubRepo || '(unknown)'}`); } catch { bad('gh not authenticated (gh auth login) — or set github.sync=false'); }
} else warn('GitHub sync disabled');

if (config.sandbox.enabled) {
  if (process.platform === 'darwin') ok('sandbox: macOS Seatbelt (built in)');
  else {
    try { run('which', ['bwrap']); ok('sandbox: bubblewrap found'); } catch { bad('sandbox needs bubblewrap + socat on Linux (apt install bubblewrap socat), or set sandbox.enabled=false (NOT recommended)'); }
  }
} else warn('sandbox DISABLED — agents run with your full user permissions');

if (config.server.hosts.some((h) => h !== '127.0.0.1' && h !== 'localhost') && !config.server.ownerToken) {
  warn('UI is reachable beyond loopback without server.ownerToken — fine on a private tailnet, risky on a LAN');
}
if (config.watch.enabled) {
  for (const s of config.watch.sources) {
    if (s.type === 'loki') {
      try { const r = await fetch(new URL('/ready', s.url), { signal: AbortSignal.timeout(4000) }); r.ok ? ok(`watch: loki ${s.url}`) : bad(`watch: loki ${s.url} → HTTP ${r.status}`); } catch (e) { bad(`watch: loki ${s.url} unreachable (${e.message})`); }
    } else if (s.type === 'docker') {
      try { run('docker', ['ps', '--format', '{{.Names}}']); ok(`watch: docker (${(s.containers || []).join(', ')})`); } catch { bad('watch: docker not reachable'); }
    } else if (s.type === 'file') {
      fs.existsSync(s.path) ? ok(`watch: file ${s.path}`) : bad(`watch: file ${s.path} not found`);
    }
  }
} else warn('watch desk disabled (no on-call SRE)');

console.log(process.exitCode ? '\nFix the ✖ items, then `npm start`.' : '\nReady. `npm start`, open the UI, press "Open desk".');
