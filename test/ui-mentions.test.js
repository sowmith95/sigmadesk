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

const api = (method, p, b) => fetch(preview.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json());
const inView = (page, loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; });

test('seeded deliveries read like messaging, and "@ro" still filters inline in the always-visible bar', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const seeded = page.locator('[data-deliveries]').first();
  await seeded.waitFor();
  assert.equal(await seeded.locator('[data-delivery="principal-be"] >> text=Replied').count(), 1);
  assert.equal(await seeded.locator('[data-delivery="sre"][data-state="failed"] >> text=Retry').count(), 1);
  assert.match(await seeded.locator('[data-delivery="senior-fe"]').innerText(), /Blocked[\s\S]*Quinn is switched off/);
  assert.ok(await page.locator('[data-mention-chip="principal-be"]').count() >= 1, 'tags in the message are name chips');
  await shot(page, 'mobile-delivery-states');
  // No extra tap: the field is on screen and typing "@ro" filters; Enter picks; Escape closes only the list.
  const msg = page.locator('#message');
  assert.ok(await inView(page, msg), 'the message field is visible without any tap');
  await msg.click(); await msg.press('@'); await msg.press('r'); await msg.press('o');
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await list.waitFor();
  assert.equal(await list.getByRole('option').first().getAttribute('data-seat'), 'principal-be');
  assert.match(await list.getByRole('option').first().innerText(), /Rowan[\s\S]*Principal Backend Engineer[\s\S]*free/);
  await msg.press('Enter');
  assert.equal(await msg.inputValue(), '@Rowan ');
  await msg.press('@'); await list.waitFor();
  await msg.press('Escape'); await list.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-panel]').count(), 1, 'Escape closed the list, not the panel');
  assert.deepEqual(await page.locator('[data-tag-line] [data-mention-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mention-chip'))), ['principal-be']);
  await msg.fill('');
  assert.deepEqual(errors, []);
  await page.close();
});

for (const [w, h] of [[390, 844], [375, 667]]) {
  test(`phone ${w}×${h}: the people sheet lists everyone, tags four with an access choice each, and a person sheet grants and revokes`, { skip, timeout: 120_000 }, async () => {
    const t = await api('POST', '/api/tickets', { title: `Tagging fixture ${w}`, description: 'x', type: 'task' });
    const { page, errors } = await openPage(browser, preview.url, { width: w, height: h });
    await page.evaluate((k) => { location.hash = `#/work/${k}`; }, t.key);
    await page.waitForSelector('[data-panel]');
    await page.getByRole('tab', { name: 'Conversation' }).click();
    const msg = page.locator('#message'), send = page.locator('[data-send]');
    assert.ok(await inView(page, msg) && await inView(page, send), 'the bar and Send are on screen with no extra tap');
    // The sheet: a dialog with every seat, reachable by scrolling, with a sticky "Tag N people".
    await page.getByRole('button', { name: 'Tag people' }).click();
    const sheet = page.getByRole('dialog', { name: 'Tag people' });
    await sheet.waitFor();
    const seats = (await api('GET', '/api/state')).agents.length;
    assert.equal(await sheet.locator('[data-pick-seat]').count(), seats, 'every seat is listed');
    const last = sheet.locator('[data-pick-seat]').last();
    await last.scrollIntoViewIfNeeded();
    assert.ok(await inView(page, last), 'the last seat is reachable by scrolling');
    for (const s of ['principal-be', 'sre', 'dba', 'qa']) await sheet.locator(`[data-pick-seat="${s}"] input[type=checkbox]`).check();
    // Access per person: Casey can get it for this reply (switch on by default); Devon approves access, so it is yours.
    const toggle = sheet.locator('[data-access-toggle="dba"]');
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'on by default where the policy allows it');
    assert.match(await sheet.locator('[data-access-why="sre"]').innerText(), /Devon approves access[\s\S]*Ask me in Inbox/);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const apply = sheet.locator('[data-apply-tags]');
    assert.equal(await apply.innerText(), 'Tag 4 people');
    assert.ok(await inView(page, apply), 'the Tag button stays on screen');
    await shot(page, `sheet-${w}`);
    await apply.click();
    await sheet.waitFor({ state: 'detached' });
    // Chips wrap; Send stays visible; the choice survives reopening the sheet.
    const chips = page.locator('[data-tag-line] [data-mention-chip]');
    assert.deepEqual(await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-mention-chip'))), ['principal-be', 'sre', 'dba', 'qa']);
    assert.ok(new Set(await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).size > 1, 'chips wrap onto a second line');
    assert.ok(await inView(page, send), 'Send is visible with four chips');
    // An on-screen keyboard (simulated: the visual viewport loses its bottom 300 px): the sheet sits above it.
    await page.evaluate(() => { const vv = Object.assign(new EventTarget(), { height: innerHeight - 300, offsetTop: 0, width: innerWidth }); Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true }); });
    await page.getByRole('button', { name: 'Tag people' }).click();
    await sheet.waitFor();
    assert.equal(await sheet.locator('[data-access-toggle="dba"]').getAttribute('aria-checked'), 'false', 'the access choice is kept');
    const box = await sheet.boundingBox(), applyBox = await apply.boundingBox();
    assert.ok(Math.abs(box.y + box.height - (h - 300)) < 2 && applyBox.y + applyBox.height <= h - 300, 'sheet and its Tag button end above the keyboard');
    await shot(page, `sheet-keyboard-${w}`);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-panel]').count(), 1, 'Escape closed the sheet, not the panel');
    // A chip comes off with its ×.
    await page.getByRole('button', { name: 'Remove Taylor' }).click();
    assert.equal(await chips.count(), 3);
    await msg.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await msg.pressSequentially('does the retry cover NYSE TICK?');
    assert.equal(await msg.inputValue(), '@Rowan @Devon @Casey does the retry cover NYSE TICK?');
    assert.ok(await inView(page, send), 'Send is visible while typing');
    await shot(page, `bar-${w}`);
    await page.getByRole('button', { name: 'Send to Rowan, Devon and Casey' }).click();
    await page.locator('[data-deliveries] [data-delivery="dba"]').waitFor();
    // The choice reached the server: Casey's delivery gives no automatic access, Rowan's may.
    const d = await api('GET', `/api/tickets/${t.key}`);
    const access = Object.fromEntries(d.mentions.map((m) => [m.seat_id, m.prod_access]));
    assert.deepEqual(access, { 'principal-be': 1, sre: 1, dba: 0 });
    // The person sheet: tap Rowan's portrait, give an hour, see the countdown, revoke, then tag in chat.
    await page.locator('[data-person="principal-be"]').waitFor();
    await page.locator('[data-person="principal-be"]').click();
    const person = page.getByRole('dialog', { name: 'Rowan' });
    await person.waitFor();
    await person.locator('[data-give="hour"]').click();
    const grant = person.locator('[data-grant]');
    await grant.waitFor();
    assert.match(await grant.innerText(), /Active · (59:\d\d|1h 00m) left/);
    await shot(page, `person-${w}`);
    await grant.getByRole('button', { name: 'Revoke access' }).click();
    await person.locator('[data-no-access]').waitFor();
    assert.equal((await api('GET', '/api/access')).grants.filter((g) => g.seat === 'principal-be').length, 0, 'revoked on the server');
    await person.getByRole('button', { name: 'Tag Rowan in chat' }).click();
    await person.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#message')?.value.includes('@Rowan'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow on a phone');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('desktop: "Add people" adds participants, and Retry sends a blocked tag again once possible', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  await page.evaluate((k) => { location.hash = `#/work/${k}`; }, key);
  await page.waitForSelector('[data-panel]');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.locator('[data-add-seat="qa"]').click();
  await page.waitForFunction(() => document.querySelector('[data-participants] [role="group"]')?.getAttribute('aria-label')?.includes('Taylor'));
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
