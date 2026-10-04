// The Projects home: scan a repository read-only, recommend a team, create the project, and see its desk online.
// Background services are never installed here (SIGMADESK_HUB_NO_SERVICES); the test starts the desk itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { findChromium, launch } from '../scripts/ui-browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-hub-')));
const kids = new Set();
after(() => { for (const c of kids) { try { c.kill('SIGKILL'); } catch { /* gone */ } } fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
const run = (args, env) => { const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(c); c.on('exit', () => kids.delete(c)); c.stdout.resume(); c.stderr.resume(); return c; };
const wait = async (url, ok = (r) => r.ok) => { for (let i = 0; i < 160; i++) { try { const r = await fetch(url); if (ok(r)) return r; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`${url} never came up`); };

function fixture() {
  const r = path.join(tmp, 'shop'); fs.mkdirSync(path.join(r, 'src'), { recursive: true }); fs.mkdirSync(path.join(r, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'vitest run' }, dependencies: { react: '19', stripe: '15', express: '5' } }));
  fs.writeFileSync(path.join(r, 'src', 'App.tsx'), 'export const App = () => null;');
  fs.writeFileSync(path.join(r, 'src', 'server.js'), 'export {};');
  fs.writeFileSync(path.join(r, '.github', 'workflows', 'ci.yml'), 'name: CI\non:\n  pull_request:\n    branches: [main]\njobs: {}\n');
  fs.writeFileSync(path.join(r, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\non:\n  push:\n    branches: [main]\njobs: {}\n');
  execFileSync('git', ['init', '-q', '-b', 'main', r]); execFileSync('git', ['-C', r, 'add', '.']);
  execFileSync('git', ['-C', r, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']);
  return r;
}

test('scan, recommend, create and open: a new project gets a desk with the team the owner approved', { timeout: 180_000 }, async () => {
  const repo = fixture();
  const app = path.join(tmp, 'app');
  const [hubPort, classicPort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(tmp, 'classic.json'), JSON.stringify({ project: { name: 'Classic', repoPath: repo }, server: { port: classicPort }, github: { sync: false } }));
  const env = { SIGMADESK_APP_ROOT: app, SIGMADESK_HUB_PORT: String(hubPort), SIGMADESK_CONFIG: path.join(tmp, 'classic.json'), SIGMADESK_HUB_NO_SERVICES: '1', SIGMADESK_HOME: '' };
  run([path.join(ROOT, 'src/hub/server.js')], env);
  const base = `http://127.0.0.1:${hubPort}`;
  await wait(`${base}/api/hub/state`);
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const st0 = await (await fetch(`${base}/api/hub/state`)).json();
  assert.deepEqual(st0.projects.map((p) => [p.id, p.summary.online]), [['classic', false]]);

  const scan = (await post('/api/hub/scan', { repoPath: repo })).body;
  assert.ok(scan.stack.includes('React') && scan.stack.includes('Payments'), JSON.stringify(scan.stack));
  assert.deepEqual(scan.ci.pullRequestWorkflows, ['CI']); assert.deepEqual(scan.ci.deployWorkflows, ['Deploy']);
  assert.deepEqual(scan.tests.map((t) => t.command), ['npm test']);
  const answers = { summary: 'An online shop for handmade mugs.', audience: 'Small-batch buyers on phones', neverBreak: ['money'], authority: 'prs', budgetUsd: 12,
    quietHours: { enabled: true, label: 'Sale hours', start: '10:00', end: '14:00', days: [6] } };
  const rec = (await post('/api/hub/recommend', { scan, answers })).body;
  const on = rec.advisors.filter((a) => a.on).map((a) => a.id);
  assert.ok(on.includes('product-design') && on.includes('security') && on.includes('devops'), on.join());
  assert.ok(rec.advisors.find((a) => a.id === 'security').evidence.some((e) => /stripe/.test(e)), 'every suggestion carries its evidence');
  assert.deepEqual(rec.gaps, []);
  assert.equal((await post('/api/hub/projects', { repoPath: repo, name: 'Mug Shop', answers, scan, team: { version: 1, advisors: [], core: { qa: { enabled: false } } } })).status, 400, 'an invalid team is refused');
  const made = await post('/api/hub/projects', { repoPath: repo, name: 'Mug Shop', answers, scan, team: { version: 1, advisors: ['security', 'product-design'], core: { sre: { enabled: false } } } });
  assert.equal(made.status, 201); assert.equal(made.body.id, 'mug-shop'); assert.equal(made.body.started, false);

  const home = path.join(app, 'projects', 'mug-shop');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.bootstrap.teamConfirmed, true); assert.equal(cfg.limits.dailyBudgetUsd, 12);
  assert.equal(cfg.limits.busyWindow.label, 'Sale hours'); assert.equal(cfg.github.openDraftPrs, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'team.json'), 'utf8')).advisors, ['security', 'product-design']);
  assert.match(fs.readFileSync(path.join(home, 'playbook.md'), 'utf8'), /handmade mugs[\s\S]*npm test[\s\S]*Money and payments/);

  run([path.join(ROOT, 'src/server.js')], { SIGMADESK_HOME: home, SIGMADESK_APP_ROOT: app, SIGMADESK_CONFIG: '', SIGMADESK_PORT: String(made.body.port) });
  await wait(`http://127.0.0.1:${made.body.port}/api/summary`);
  const st = await (await fetch(`${base}/api/hub/state`)).json();
  const shop = st.projects.find((p) => p.id === 'mug-shop');
  assert.equal(shop.summary.online, true); assert.equal(shop.summary.project, 'Mug Shop');
  assert.equal(shop.summary.team_confirmed, true, 'the wizard approval is recorded'); assert.equal(shop.summary.paused, true, 'it starts paused');
  const desk = await (await fetch(`http://127.0.0.1:${made.body.port}/api/state`)).json();
  assert.ok(desk.agents.some((a) => a.id === 'security') && !desk.agents.some((a) => a.id === 'trading-advisor'));
  assert.equal(desk.agents.find((a) => a.id === 'sre').enabled, false);

  if (!findChromium()) return;
  const browser = await launch();
  try {
    for (const w of [390, 1280]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
      const page = await ctx.newPage(); const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base);
      await page.waitForSelector(`[data-project="mug-shop"]`);
      const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} ${Math.round(e.getBoundingClientRect().right)}`));
      assert.deepEqual(wide, [], `home fits ${w}px`);
      await page.getByRole('button', { name: /Add a project/ }).first().click();
      await page.getByLabel('Repository folder').fill(repo);
      await page.getByLabel('Project name').fill(`Mug Shop ${w}`);
      await page.getByRole('button', { name: /Scan repository/ }).click();
      await page.getByRole('heading', { name: 'What we found' }).waitFor();
      await page.getByRole('button', { name: /^Next/ }).click();
      await page.getByLabel('What does it do?').fill('An online shop for mugs.');
      await page.getByRole('button', { name: 'Logins and permissions' }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `goals step fits ${w}px`);
      await page.getByRole('button', { name: /Recommend a team/ }).click();
      await page.waitForSelector('[data-seat="security"]');
      assert.match(await page.locator('[data-seat="security"]').textContent(), /Because:/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `wizard fits ${w}px`);
      await page.getByRole('button', { name: /^Next/ }).click();
      await page.waitForSelector('text=What happens when you create it');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally { await browser.close(); }
});
