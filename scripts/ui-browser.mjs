// Browser harness for the desk UI: boots the isolated preview desk (scripts/local-preview.mjs) on a free port and
// launches Chromium through playwright-core. Used by `npm run ui:shots` and test/ui-e2e.test.js. Never touches a real desk.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Newest Chromium playwright has cached on this machine, or $SIGMADESK_CHROMIUM, or null. */
export function findChromium() {
  if (process.env.SIGMADESK_CHROMIUM && fs.existsSync(process.env.SIGMADESK_CHROMIUM)) return process.env.SIGMADESK_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
  const candidates = [];
  try {
    for (const dir of fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
      const base = path.join(cache, dir);
      candidates.push(path.join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'), path.join(base, 'chrome-linux/chrome'), path.join(base, 'chrome-linux64/chrome'));
    }
  } catch { /* no cache */ }
  candidates.push('/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Start the preview desk; resolves { url, stop }. */
export async function startPreview(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts/local-preview.mjs')],
    { cwd: ROOT, env: { ...process.env, SIGMADESK_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (s) => { out += s; }); child.stderr.on('data', (s) => { out += s; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${url}/api/state`)).ok) break; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`preview failed: ${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); } };
  return { url, stop, output: () => out };
}

export async function launch() {
  const executablePath = findChromium();
  if (!executablePath) return null;
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath, headless: true });
}

/** Open a page that records console errors and uncaught exceptions. */
export async function openPage(browser, url, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('[role="group"][aria-label="Desk status"]');
  await page.waitForFunction(() => !!document.querySelector('main') && document.querySelector('main').textContent.trim() !== 'Loading…');
  return { page, errors };
}
