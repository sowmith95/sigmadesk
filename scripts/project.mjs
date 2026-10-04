#!/usr/bin/env node
// SigmaDesk projects (phase 1 CLI; the onboarding wizard uses the same module):
//   npm run project -- create <repo path> [--name "My App"] [--id my-app] [--port 8801]
//   npm run project -- list
//   npm run project -- paths <id>
//   npm run project -- install <id>      (background service: launchd on macOS, systemd user unit on Linux)
//   npm run project -- uninstall <id>
// Projects live in the per-user application folder (see src/app-paths.js); this checkout holds only code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoot, deskPaths } from '../src/app-paths.js';
import { createProject, listProjects, getProject, updateProject } from '../src/projects.js';
import { installService, uninstallService, HUB } from '../src/service.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]; else pos.push(rest[i]); }
const need = (p, what) => { if (!p) { console.error(`missing ${what}`); process.exit(2); } return p; };
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
    const out = installService(p);
    updateProject(p.id, { state: 'installed', installed_at: new Date().toISOString() });
    console.log(`Installed ${out.file}\n  logs: ${out.log}\n  desk: http://127.0.0.1:${p.port}`);
    break;
  }
  case 'uninstall': {
    const p = getProject(need(pos[0], 'project id')) || (console.error('no such project'), process.exit(1));
    uninstallService(p);
    updateProject(p.id, { state: 'created' });
    console.log(`Stopped and removed the ${p.id} service. Its data stays in ${p.home}.`);
    break;
  }
  case 'install-hub': {
    const out = installService(HUB(Number(flags.port) || 8780));
    console.log(`Installed the Projects home\n  ${out.file}\n  logs: ${out.log}\n  open: http://127.0.0.1:${Number(flags.port) || 8780}`);
    break;
  }
  case 'uninstall-hub': uninstallService(HUB()); console.log('Stopped and removed the Projects home service.'); break;
  default:
    console.log('usage: npm run project -- create <repo path> [--name N] [--id ID] [--port P] | list | paths <id> | install <id> | uninstall <id> | install-hub [--port 8780] | uninstall-hub');
    process.exit(cmd ? 2 : 0);
}
