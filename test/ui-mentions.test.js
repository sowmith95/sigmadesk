// @mentions in the ticket conversation, against the isolated preview desk with its mentions fixture (a paused desk:
// nothing runs; Rowan and Devon are switched on, everyone else is off). Skipped when no Chromium is cached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
const SHOTS = process.env.SIGMADESK_MENTION_SHOTS; // e.g. /tmp/sd-mentions (never inside the repository)
let preview, browser, key;
before(async () => {
  if (skip) return;
  preview = await startPreview({ SIGMADESK_MENTIONS_DEMO: '1' }); browser = await launch();
  key = (await (await fetch(`${preview.url}/api/state`)).json()).tickets.find((t) => t.title.startsWith('Retry fix for the NYSE TICK')).key;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await preview?.stop(); });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);

test('the @ picker tags people by keyboard and touch, and each recipient shows its delivery state', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  // The seeded message: one delivery in each finished state, with the reason and a Retry where it helps.
  const seeded = page.locator('[data-deliveries]').first();
  await seeded.waitFor();
  assert.equal(await seeded.locator('[data-delivery="principal-be"] >> text=Replied').count(), 1);
  assert.equal(await seeded.locator('[data-delivery="sre"][data-state="failed"] >> text=Retry').count(), 1);
  assert.match(await seeded.locator('[data-delivery="senior-fe"]').innerText(), /Blocked[\s\S]*Quinn is switched off/);
  assert.ok(await page.locator('[data-mention-chip="principal-be"]').count() >= 1, 'tags in the message are name chips');
  await shot(page, 'mobile-delivery-states');

  // Keyboard: "@ Tag someone" opens the composer with the picker; typing filters; Enter picks; Escape closes only the list.
  await page.getByRole('button', { name: '@ Tag someone' }).click();
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await list.waitFor();
  const reply = page.locator('#reply');
  await reply.press('r'); await reply.press('o');
  assert.equal(await list.getByRole('option').first().getAttribute('data-seat'), 'principal-be');
  assert.match(await list.getByRole('option').first().innerText(), /Rowan[\s\S]*Principal Backend Engineer[\s\S]*free/);
  await shot(page, 'mobile-picker');
  await reply.press('Enter');
  assert.equal(await reply.inputValue(), '@Rowan ');
  await reply.pressSequentially('and ');
  await reply.press('@');
  await list.waitFor();
  await reply.press('Escape');
  await list.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-panel]').count(), 1, 'Escape closed the picker, not the panel');
  // Touch: tap a seat in the list.
  await reply.pressSequentially('Ca');
  await list.waitFor();
  await list.locator('[data-seat="dba"]').click();
  assert.equal(await reply.inputValue(), '@Rowan and @Casey ');
  await reply.pressSequentially('does the retry fix cover NYSE TICK?');
  assert.deepEqual(await page.locator('[data-tag-line] [data-mention-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mention-chip'))), ['principal-be', 'dba']);
  await shot(page, 'mobile-composer-tags');
  await page.getByRole('button', { name: 'Send to Rowan and Casey' }).click();
  // The new message: Rowan is queued (the desk is paused), Casey is blocked with the reason.
  const fresh = page.locator('[data-deliveries]', { has: page.locator('[data-delivery="dba"]') });
  await fresh.waitFor();
  assert.equal(await fresh.locator('[data-delivery="principal-be"]').getAttribute('data-state'), 'queued');
  assert.match(await fresh.locator('[data-delivery="principal-be"]').innerText(), /Queued[\s\S]*up next/);
  assert.match(await fresh.locator('[data-delivery="dba"]').innerText(), /Blocked[\s\S]*Casey is switched off \(Settings → Team\)/);
  // Participants: the tagged seats joined the ticket (the header is full height again after sending).
  await page.waitForFunction(() => document.querySelector('[data-participants] [role="img"]')?.getAttribute('aria-label')?.includes('Casey'));
  await shot(page, 'mobile-after-send');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow on a phone');
  assert.deepEqual(errors, []);
  await page.close();
});

test('desktop: "Add people" adds participants, and Retry sends a blocked tag again once possible', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.locator('[data-add-seat="qa"]').click();
  await page.waitForFunction(() => document.querySelector('[data-participants] [role="img"]')?.getAttribute('aria-label')?.includes('Taylor'));
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  // Devon is switched on, so his failed tag can be retried: it goes back to the queue.
  const devon = page.locator('[data-delivery="sre"][data-state="failed"]').first();
  await devon.getByRole('button', { name: 'Retry' }).click();
  await page.locator('[data-delivery="sre"][data-state="queued"]').first().waitFor();
  await shot(page, 'desktop-thread');
  assert.deepEqual(errors, []);
  await page.close();
});
