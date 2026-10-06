// Presence in the ticket conversation, against the isolated preview desk with its presence fixture (fixture runs that
// post a step every 15 s, and one run that never posted). Skipped when no Chromium is cached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
let preview, browser, tickets;
before(async () => {
  if (skip) return;
  preview = await startPreview({ SIGMADESK_PRESENCE_DEMO: '1' }); browser = await launch();
  tickets = (await (await fetch(`${preview.url}/api/state`)).json()).tickets;
});
after(async () => { await browser?.close(); await preview?.stop(); });
const byTitle = (s) => tickets.find((t) => t.title.startsWith(s)).key;

test('the conversation shows who is writing, who is next and the owner draft; a chip opens the live run', { skip, timeout: 60_000 }, async () => {
  const key = byTitle('Improve the mobile navigation');
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.evaluate((k) => localStorage.setItem('sd2.drafts', JSON.stringify({ [`${k}:msg`]: 'half a thought' })), key);
  await page.reload(); await page.waitForSelector('[role="group"][aria-label="Desk status"]'); // drafts load at start
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const writing = page.locator('[data-presence-state="writing"]');
  await writing.waitFor();
  assert.match(await writing.innerText(), /^(Sage and Quinn|Quinn and Sage) are writing…/);
  assert.equal(await page.locator('[data-presence-state="next"]').innerText(), 'Taylor is next · desk paused');
  assert.equal(await page.locator('[data-presence] [aria-live="polite"]').count(), 1, 'one polite live region');
  // The owner's draft is in the always-visible message bar, so the strip shows no separate draft chip for it.
  assert.equal(await page.locator('#message').inputValue(), 'half a thought');
  assert.equal(await page.locator('[data-presence-state="draft"]').count(), 0);
  // Presence is a Conversation thing; a seat's chip jumps to its live run.
  await writing.click();
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), 'Live run');
  assert.equal(await page.locator('[data-presence]').count(), 0, 'no strip outside the Conversation');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow on a phone');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a run that never posted is stalled, not writing, and its board card has no typing dots', { skip, timeout: 60_000 }, async () => {
  const key = byTitle('Add a clear SRE source-health summary'), live = byTitle('Improve the mobile navigation');
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  await page.evaluate(() => { location.hash = '#/work'; });
  await page.waitForSelector(`[data-writing="${live}"]`);
  assert.equal(await page.locator(`[data-writing="${key}"]`).count(), 0);
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const stalled = page.locator('[data-presence-state="stalled"]');
  await stalled.waitFor();
  assert.match(await stalled.innerText(), /^Riley · no update for (8|9) min$/);
  assert.equal(await page.locator('[data-presence-state="writing"]').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
