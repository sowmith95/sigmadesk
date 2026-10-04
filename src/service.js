// Background services for project desks: launchd on macOS, a systemd user unit on Linux. Each service carries its
// project's home and port; values are escaped for the file format they go into.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deskPaths, logRoot } from './app-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// p: a registered project, or { id, service, port, script, env } for another SigmaDesk process (the Projects home).
export function serviceFiles(p) {
  const paths = p.script ? { logDir: path.join(logRoot(), p.id) } : deskPaths({ home: p.home, legacyRoot: p.home, env: {}, port: p.port });
  const node = process.execPath;
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), ...(p.script ? p.env || {} : { SIGMADESK_HOME: p.home, SIGMADESK_PORT: String(p.port) }) };
  const log = path.join(paths.logDir, 'sigmadesk.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- SigmaDesk project ${xml(p.id)} (written by scripts/project.mjs). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(p.service)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>--disable-warning=ExperimentalWarning</string><string>${xml(path.join(ROOT, p.script || path.join('src', 'server.js')))}</string></array>
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
ExecStart=${node} --disable-warning=ExperimentalWarning ${path.join(ROOT, p.script || path.join('src', 'server.js'))}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
  return { plist, unit, log, logDir: paths.logDir };
}


export function installService(p) {
  const s = serviceFiles(p);
  fs.mkdirSync(s.logDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${p.service}.plist`);
    fs.writeFileSync(file, s.plist, { mode: 0o600 });
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${p.service}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
    return { file, log: s.log };
  }
  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'systemd', 'user', `sigmadesk-${p.id}.service`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s.unit, { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', `sigmadesk-${p.id}.service`]);
    return { file, log: `journalctl --user -u sigmadesk-${p.id}` };
  }
  throw new Error('Background services are supported on macOS and Linux');
}
export function uninstallService(p) {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${p.service}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${p.service}.plist`), { force: true });
  } else if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', `sigmadesk-${p.id}.service`], { stdio: 'ignore' }); } catch { /* not installed */ }
  }
}

/** The Projects home as a background service (com.sigmadesk.hub). */
export const HUB = (port = 8780) => ({ id: 'hub', service: 'com.sigmadesk.hub', port, script: path.join('src', 'hub', 'server.js'), env: { SIGMADESK_HUB_PORT: String(port) } });
