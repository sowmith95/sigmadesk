// Where SigmaDesk keeps things on this machine. The code (this checkout or an installed copy) holds no project data:
// each project lives in the per-user application folder, like other desktop apps.
//   macOS:   ~/Library/Application Support/SigmaDesk/{projects.json, projects/<id>/, workspaces/<id>/, repos/}
//            ~/Library/Logs/SigmaDesk/<id>/
//   Linux:   $XDG_DATA_HOME/sigmadesk (~/.local/share/sigmadesk), logs in $XDG_STATE_HOME/sigmadesk (~/.local/state)
//   Windows: %APPDATA%\SigmaDesk, logs in %LOCALAPPDATA%\SigmaDesk\Logs
// A project's home (`projects/<id>`) holds config.json, team.json, playbook.md, data/ (db, publisher) and run/ (sockets).
// Its workspaces sit beside it in `workspaces/<id>` so agents can read their clones but never any project's database.
// No SIGMADESK_HOME set: the legacy layout inside the checkout (the live desk keeps working unchanged).
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function appRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SIGMADESK_APP_ROOT) return path.resolve(env.SIGMADESK_APP_ROOT);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SigmaDesk');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SigmaDesk');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'sigmadesk');
}
export function logRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SIGMADESK_APP_ROOT) return path.join(path.resolve(env.SIGMADESK_APP_ROOT), 'logs');
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', 'SigmaDesk');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'SigmaDesk', 'Logs');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'sigmadesk');
}
export const projectHome = (id, root = appRoot()) => path.join(root, 'projects', id);

/**
 * Every writable path for one desk. `home` is a project home (or null for the legacy layout under `legacyRoot`).
 * Explicit SIGMADESK_* overrides still win, as before.
 */
export function deskPaths({ home = null, legacyRoot, env = process.env, port = 8790 } = {}) {
  const id = home ? path.basename(home) : 'legacy';
  const inApp = home && path.basename(path.dirname(home)) === 'projects';
  const base = home || legacyRoot;
  const dataDir = env.SIGMADESK_DATA || path.join(base, 'data');
  const runDir = home ? path.join(home, 'run') : path.join(legacyRoot, 'run');
  let socketPath = env.SIGMADESK_SOCKET || path.join(runDir, 'agent.sock');
  // macOS caps unix socket paths at 104 bytes and run sockets are r<runId>.sock beside this one: when too long, use a
  // short directory unique to this PROJECT (never the shared temp directory, and never keyed by port: a second copy of
  // the same project on another port must land in the same place and find the first one's lock).
  if (socketPath.length > 100) socketPath = path.join(os.tmpdir(), `sigmadesk-${crypto.createHash('sha256').update(runDir).digest('hex').slice(0, 12)}`, 'agent.sock');
  // The desk's private run directory (lock, mailbox staging). With an explicit socket (previews, tests) it is that
  // socket's directory, so such a desk never shares a lock with the checkout's desk; otherwise the project's run/.
  return {
    id, home,
    configFile: env.SIGMADESK_CONFIG || (home ? path.join(home, 'config.json') : path.join(legacyRoot, 'sigmadesk.config.json')),
    dataDir,
    dbPath: env.SIGMADESK_DB || path.join(dataDir, 'sigmadesk.db'),
    runDir: env.SIGMADESK_SOCKET ? path.dirname(env.SIGMADESK_SOCKET) : runDir,
    socketPath,
    workspaceRoot: env.SIGMADESK_WORKSPACES || (inApp ? path.join(path.dirname(path.dirname(home)), 'workspaces', id) : path.join(base, 'workspaces')),
    logDir: home ? path.join(logRoot(env), id) : dataDir,
    appRoot: inApp ? path.dirname(path.dirname(home)) : null,
  };
}
