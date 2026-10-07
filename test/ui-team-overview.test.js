// Team overview and Team → Wall mode against the isolated preview desk with its team fixture (SIGMADESK_TEAM_DEMO: live,
// quiet and stalled runs, switched-off seats, logged hand-offs). Skipped when no Chromium is cached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';
import { board } from '../public/attention.js';
import { departmentsFor, departmentCounts } from '../public/departments.js';

const skip = !findChromium() && 'no Chromium available';
let preview, browser;
before(async () => { if (skip) return; preview = await startPreview({ SIGMADESK_TEAM_DEMO: '1' }); browser = await launch(); });
after(async () => { await browser?.close(); await preview?.stop(); });

test('department cards: counts agree with the Inbox, KPIs show source or unknown, honest seat chips, a pill opens the decision', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = '#/team'; });
  await page.waitForSelector('[data-team-overview] [data-department]');
  const ids = await page.locator('[data-team-overview] [data-department]').evaluateAll((n) => n.map((x) => x.getAttribute('data-department')));
  assert.deepEqual(ids, ['planning', 'backend', 'data', 'ui', 'qa', 'reliability', 'research']);
  const snap = await (await fetch(`${preview.url}/api/state`)).json();
  const B = board(snap);
  const c = departmentCounts(B, departmentsFor(snap.agents, snap.settings.team_departments));
  assert.equal(Object.values(c).reduce((s, x) => s + x.waiting.length, 0), B.counts.needs_you);
  const inbox = Number(await page.locator('nav[aria-label="Pages"] button:has-text("Inbox") span.rounded-full').first().innerText());
  assert.equal(inbox, B.counts.needs_you, 'the Inbox badge is the same total');
  for (const id of ids) {
    const pill = page.locator(`[data-waiting-pill="${id}"]`);
    assert.equal(await pill.count(), c[id].waiting.length ? 1 : 0, id);
    if (c[id].waiting.length) assert.match(await pill.innerText(), new RegExp(`^${c[id].waiting.length} waiting`));
  }
  assert.equal(await page.locator('[data-department="data"] [data-kpi][data-unknown]').count(), 2, 'unobserved telemetry says unknown');
  assert.match(await page.locator('[data-department="data"] [data-kpi]').first().innerText(), /does not observe/);
  assert.equal(await page.locator('[data-release-fact="Deployed"]').innerText().then((t) => t.split('\n')[0]), 'unknown');
  const chip = (s) => page.locator(`[data-team-overview] [data-seat-chip="${s}"]`).getAttribute('data-state');
  assert.equal(await chip('senior-fe'), 'working'); assert.equal(await chip('junior'), 'stalled'); assert.equal(await chip('dba'), 'quiet'); assert.equal(await chip('support'), 'off');
  // The planning pill opens its decision in the ticket sheet.
  await page.click('[data-waiting-pill="planning"]');
  await page.waitForSelector('[data-panel]');
  assert.match(page.url(), /#\/team\/[A-Z]+-\d+$/);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await page.close();
});

test('phones stack the department cards with no overflow and no wall link; the wall has no chrome, exceptions first, hand-off lines', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.evaluate(() => { location.hash = '#/team'; });
  await page.waitForSelector('[data-team-overview] [data-department]');
  assert.equal(await page.getByRole('link', { name: 'Wall mode' }).isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  await page.close();

  const wall = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const werr = [];
  wall.on('pageerror', (e) => werr.push(e.message));
  await wall.goto(`${preview.url}/?wall=1`);
  await wall.waitForSelector('[data-team-wall] [data-department-map] [data-department]');
  assert.equal(await wall.locator('nav[aria-label="Pages"]').count(), 0, 'no desk chrome on the wall');
  const types = await wall.locator('[data-exception]').evaluateAll((n) => n.map((x) => x.getAttribute('data-exception')));
  assert.equal(types[0], 'stalled', 'a stalled run leads the approvals');
  assert.ok(types.slice(1).every((t) => t === 'approval'));
  assert.ok(await wall.locator('[data-handoff]').count() >= 3, 'logged hand-offs between departments are drawn');
  assert.ok(await wall.locator('[data-handoff="backend>qa"]').count() === 1, 'the QA hand-off runs from Backend to QA');
  assert.match(await wall.locator('[data-observed]').innerText(), /observed \d\d:\d\d/);
  assert.deepEqual(werr, []);
  await wall.close();
});
