#!/usr/bin/env node
// SigmaDesk projects (phase 1 CLI; the onboarding wizard uses the same module):
//   npm run project -- create <repo path> [--name "My App"] [--id my-app] [--port 8801]
//   npm run project -- list
//   npm run project -- paths <id>
//   npm run project -- install <id>      (background service: launchd on macOS, systemd user unit on Linux)
//   npm run project -- uninstall <id>
// Projects live in the per-user application folder (see src/app-paths.js); this checkout holds only code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appRoot, deskPaths } from '../src/app-paths.js';
import { createProject, listProjects, getProject, updateProject } from '../src/projects.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]; else pos.push(rest[i]); }
const need = (p, what) => { if (!p) { console.error(`missing ${what}`); process.exit(2); } return p; };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function serviceFiles(p) {
  const paths = deskPaths({ home: p.home, legacyRoot: p.home, env: {}, port: p.port });
  const node = process.execPath;
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), SIGMADESK_HOME: p.home, SIGMADESK_PORT: String(p.port) };
  const log = path.join(paths.logDir, 'sigmadesk.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- SigmaDesk project ${xml(p.id)} (written by scripts/project.mjs). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(p.service)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>--disable-warning=ExperimentalWarning</string><string>${xml(path.join(ROOT, 'src', 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `\n    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  const q = (v) => `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
  const unit = `[Unit]
Description=SigmaDesk (${p.id})
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
ExecStart=${node} --disable-warning=ExperimentalWarning ${path.join(ROOT, 'src', 'server.js')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
  return { plist, unit, log, logDir: paths.logDir };
}

switch (cmd) {
  case 'create': {
    const p = createProject({ repoPath: need(pos[0], 'repo path'), name: flags.name, id: flags.id, port: flags.port });
    console.log(`Created project ${p.id} (${p.name}) for ${p.repoPath}\n  home: ${p.home}\n  workspaces: ${p.paths.workspaceRoot}\n  desk: http://127.0.0.1:${p.port} once installed\nNext: review ${path.join(p.home, 'config.json')} and playbook.md, then: npm run project -- install ${p.id}`);
    break;
  }
  case 'list': {
    const ps = listProjects();
    if (!ps.length) console.log(`No projects yet in ${appRoot()}. Create one: npm run project -- create <repo path>`);
    for (const p of ps) console.log(`${p.id.padEnd(24)} ${String(p.port).padEnd(6)} ${p.state.padEnd(10)} ${p.repoPath}`);
    break;
  }
  case 'paths': {
    const p = getProject(need(pos[0], 'project id')) || (console.error('no such project'), process.exit(1));
    console.log(JSON.stringify(deskPaths({ home: p.home, legacyRoot: p.home, env: {}, port: p.port }), null, 2));
    break;
  }
  case 'install': {
    const p = getProject(need(pos[0], 'project id')) || (console.error('no such project'), process.exit(1));
    const s = serviceFiles(p);
    fs.mkdirSync(s.logDir, { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${p.service}.plist`);
      fs.writeFileSync(file, s.plist, { mode: 0o600 });
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${p.service}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
      console.log(`Installed ${file}\n  logs: ${s.log}\n  desk: http://127.0.0.1:${p.port}`);
    } else if (process.platform === 'linux') {
      const file = path.join(os.homedir(), '.config', 'systemd', 'user', `sigmadesk-${p.id}.service`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, s.unit, { mode: 0o600 });
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', `sigmadesk-${p.id}.service`]);
      console.log(`Installed ${file}\n  logs: journalctl --user -u sigmadesk-${p.id}\n  desk: http://127.0.0.1:${p.port}`);
    } else { console.error('unsupported OS'); process.exit(1); }
    updateProject(p.id, { state: 'installed', installed_at: new Date().toISOString() });
    break;
  }
  case 'uninstall': {
    const p = getProject(need(pos[0], 'project id')) || (console.error('no such project'), process.exit(1));
    if (process.platform === 'darwin') {
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${p.service}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
      fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${p.service}.plist`), { force: true });
    } else if (process.platform === 'linux') {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', `sigmadesk-${p.id}.service`], { stdio: 'ignore' }); } catch { /* not installed */ }
    }
    updateProject(p.id, { state: 'created' });
    console.log(`Stopped and removed the ${p.id} service. Its data stays in ${p.home}.`);
    break;
  }
  default:
    console.log('usage: npm run project -- create <repo path> [--name N] [--id ID] [--port P] | list | paths <id> | install <id> | uninstall <id>');
    process.exit(cmd ? 2 : 0);
}
