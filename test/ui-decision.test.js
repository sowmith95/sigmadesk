// The decision snapshot on screen (sowmith95/sigmadesk#6), against the isolated preview desk with its decision fixture
// (SIGMADESK_DECISION_DEMO): Inbox cards and the Decision sheet lead with what you decide and what approving does, the
// gate in order and evidence freshness; quick asks report what really happened; "Verify in production" on a merged
// ticket files one linked task and never reopens it. Phone (390×844) and desktop (1440×900). Skipped without Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
let preview, browser;
before(async () => { if (skip) return; preview = await startPreview({ SIGMADESK_DECISION_DEMO: '1' }); browser = await launch(); });
after(async () => { await browser?.close(); await preview?.stop(); });
const state = () => fetch(`${preview.url}/api/state`).then((r) => r.json());

for (const [w, h] of [[390, 844], [1440, 900]]) {
  test(`${w}px: Inbox and Decision sheet lead with the server's brief: consequence, gate order, freshness; no blanket production copy`, { skip, timeout: 60_000 }, async () => {
    const { page, errors } = await openPage(browser, preview.url, { width: w, height: h });
    const snap = await state();
    const contracts = snap.tickets.find((t) => t.title.startsWith('Preserve review contracts'));
    const docs = snap.tickets.find((t) => t.title.startsWith('Publish the runbook site'));
    const line = page.locator(`article[data-ticket="${contracts.key}"] [data-brief-line="merge"]`);
    await line.waitFor();
    assert.match(await line.innerText(), /starts Deploy to Mac mini → redeploys alpaca-trader/);
    assert.match(await page.locator(`article[data-ticket="${docs.key}"] [data-brief-line="merge"]`).innerText(), /CI was read for 4be91c2, not the current commit/);
    assert.doesNotMatch(await page.locator('main').innerText(), /deploys production/i);
    if (w <= 400) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll on a phone');

    await page.locator(`article[data-ticket="${contracts.key}"] h3 button`).click();
    const lead = page.locator('[data-panel] [data-decision-lead="merge"]');
    await lead.waitFor();
    assert.equal(await lead.locator('[data-you-decide]').innerText(), 'Merge Review contracts into main');
    assert.match(await lead.locator('[data-wait]').innerText(), /waiting 3 h/);
    assert.match(await lead.locator('[data-releases]').innerText(), /Unblocks Switch reviewers/);
    assert.deepEqual(await lead.locator('[data-gate-item]').evaluateAll((n) => n.map((x) => x.getAttribute('data-gate-item'))), ['qa', 'reviews', 'ci', 'deploy_window', 'policy']);
    assert.equal(await lead.locator('[data-gate-item="policy"]').getAttribute('data-state'), 'yours');
    assert.equal(await lead.locator('[data-evidence="ci"]').getAttribute('data-state'), 'current');
    assert.match(await lead.locator('[data-human]').innerText(), /Watching the deploy/);
    assert.doesNotMatch(await page.locator('[data-panel]').innerText(), /deploys production/i);
    if (w <= 400) assert.equal(await page.evaluate(() => { const p = document.querySelector('[data-panel]'); return !p || p.scrollWidth <= p.clientWidth + 1; }), true, 'the sheet fits a phone');

    // The other merge: CI read for an older commit is stale, and an unmapped workflow has no target.
    await page.keyboard.press('Escape'); await page.waitForSelector('[data-panel]', { state: 'detached' });
    await page.locator(`article[data-ticket="${docs.key}"] h3 button`).click();
    const lead2 = page.locator('[data-panel] [data-decision-lead="merge"]');
    await lead2.waitFor();
    assert.equal(await lead2.locator('[data-evidence="ci"]').getAttribute('data-state'), 'stale');
    assert.equal(await lead2.locator('[data-gate-item="ci"]').getAttribute('data-state'), 'blocked');
    assert.match(await lead2.innerText(), /Deployment target unknown/);
    assert.match(await lead2.innerText(), /edits 1 workflow file \(docs-site\.yml\)/);
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('quick asks: the desk answers first, a routed ask reports its delivery; Verify in production on a merged ticket files one linked task and never reopens it', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  const snap = await state();
  const contracts = snap.tickets.find((t) => t.title.startsWith('Preserve review contracts'));
  await page.evaluate((k) => { location.hash = `#/inbox/${k}`; }, contracts.key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.click('[data-quick-ask="remaining"]');
  await page.waitForSelector('[data-remaining]');
  assert.equal(await page.locator('[data-step="merge"]').getAttribute('data-state'), 'now');
  assert.equal(await page.locator('[data-step="qa"]').getAttribute('data-state'), 'done');
  await page.click('[data-quick-ask="blocks"]');
  await page.locator('[data-quick-answer="blocks"] [data-quick-run]').click();
  const res = page.locator('[data-quick-result]');
  await res.waitFor();
  assert.match(await res.innerText(), /^Sent to \w+; the answer lands in this thread\.|^Not delivered: /);
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-panel]', { state: 'detached' });

  const shipped = (await state()).tickets.find((t) => t.status === 'done' && t.pr_url);
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, shipped.key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.click('[data-quick-ask="verify"]');
  await page.locator('[data-quick-answer="verify"] [data-quick-run]').click();
  await page.waitForSelector('[data-quick-result="ok"]');
  const filed = await page.locator('[data-quick-result]').innerText();
  assert.match(filed, new RegExp(`Filed [A-Z]+-\\d+: .* ${shipped.key} stays merged`));
  await page.locator('[data-quick-answer="verify"] [data-quick-run]').click();
  await page.waitForFunction(() => /Already filed/.test(document.querySelector('[data-quick-result]')?.textContent || ''));
  const after = await state();
  assert.equal(after.tickets.find((t) => t.key === shipped.key).status, 'done', 'the merged ticket keeps its state');
  assert.equal(after.tickets.filter((t) => t.title.startsWith('Verify in production:')).length, 1, 'one linked task');
  assert.deepEqual(errors, []);
  await page.close();
});

for (const [w, h] of [[390, 844], [1440, 900]]) {
  test(`${w}px: Settings → Autonomy shows mode and readiness per action; only existing write paths are switches; the ticket line opens Who acts`, { skip, timeout: 60_000 }, async () => {
    const { page, errors } = await openPage(browser, preview.url, { width: w, height: h });
    await page.evaluate(() => { location.hash = '#/settings'; });
    const m = page.locator('[data-autonomy-matrix]');
    await m.waitFor();
    assert.deepEqual(await m.locator('[data-action]').evaluateAll((n) => n.map((x) => x.getAttribute('data-action'))), ['groom', 'implement', 'merge_low', 'merge_high', 'deploy_timing', 'prod_read', 'tag_access', 'publish']);
    const row = (id) => m.locator(`[data-action="${id}"]`);
    assert.equal(await row('merge_low').locator('[data-mode]').getAttribute('data-mode'), 'autonomous');
    assert.equal(await row('merge_low').getAttribute('data-ready'), 'blocked', 'the halted preview desk blocks it without changing its mode');
    assert.equal(await row('merge_high').locator('[data-mode]').getAttribute('data-mode'), 'assisted');
    assert.equal(await row('prod_read').locator('[data-mode]').getAttribute('data-mode'), 'assisted');
    assert.equal(await m.locator('[data-control]').evaluateAll((n) => n.map((x) => x.getAttribute('data-control')).join(',')), 'ops_enabled,ownerMentionAutoGrant,open_draft_prs');
    assert.match(await row('merge_low').locator('[data-readonly]').innerText(), /Read-only here.*review\.autoMerge\.enabled/);
    assert.equal(await m.locator('[data-not-representable]').count(), 2);
    if (w <= 400) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    const snap = await state();
    const k = snap.tickets.find((t) => t.title.startsWith('Preserve review contracts')).key;
    await page.evaluate((key) => { location.hash = `#/inbox/${key}`; }, k);
    const line = page.locator('[data-autonomy-line]');
    await line.waitFor();
    assert.match(await line.innerText(), /^Merge needs you \(risk high\) · prod read expires \d/);
    await line.click();
    await page.waitForSelector('[data-ticket-autonomy]');
    assert.equal(await page.getByRole('button', { name: 'Hold the merge' }).count(), 1, 'the existing hold control sits with it');
    assert.deepEqual(errors, []);
    await page.close();
  });
}
