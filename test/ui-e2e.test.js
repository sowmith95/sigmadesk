// Browser interaction tests for the React desk against the isolated preview desk. Skipped when no Chromium is cached
// (scripts/ui-browser.mjs finds playwright's cache or $SIGMADESK_CHROMIUM). They exercise the behaviours a rewrite can
// silently lose: drafts surviving live updates, a vanished decision, focus return, conditional research saves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
let preview, browser;
before(async () => { if (skip) return; preview = await startPreview(); browser = await launch(); });
after(async () => { await browser?.close(); await preview?.stop(); });
const api = (method, p, b) => fetch(preview.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('a reply draft survives live updates, persists, and Escape returns focus to the card', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  const card = page.locator('.dcard.kind-question').first();
  const key = (await card.locator('.key').textContent()).trim();
  await card.locator('.title-btn').click();
  const reply = page.locator('#reply');
  await reply.click(); await reply.fill('Page after five errors');
  // Live updates while typing: a comment on this ticket and an edit to another ticket.
  await api('POST', `/api/tickets/${key}/reply`, { body: 'Context from the owner', mode: 'comment' });
  const other = (await api('GET', '/api/state')).body.tickets.find((t) => t.key !== key);
  await api('PATCH', `/api/tickets/${other.key}`, { priority: 'P3' });
  await page.waitForSelector('text=Context from the owner');
  assert.equal(await reply.inputValue(), 'Page after five errors');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'reply', 'focus stays in the reply');
  assert.match(await page.evaluate(() => localStorage.getItem('sd2.drafts')), /Page after five errors/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-panel', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-key]')?.dataset.key?.split(':')[0]), key, 'focus returns to the card that opened it');
  // Reopening restores the draft.
  await card.locator('.title-btn').click();
  assert.equal(await page.locator('#reply').inputValue(), 'Page after five errors');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a decision resolved elsewhere while open shows a notice instead of switching decisions', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.locator('.dcard.kind-design .title-btn').first().click();
  await page.waitForSelector('text=Recommendation #1');
  const key = (await page.locator('.sheet-h .key').textContent()).trim();
  const r = await api('POST', `/api/tickets/${key}/decision`, { decision: 'approve', message: 'from another device', discussion_id: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await page.waitForSelector('text=That decision was resolved or changed while you were reading');
  assert.equal(await page.locator('button:has-text("Approve design")').count(), 0, 'no stale approve button');
  assert.deepEqual(errors, []);
  await page.close();
});

test('research: add a program from a template, change it with chips, and a concurrent save is refused without losing the edit', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  await page.click('#btn-gear'); await page.click('.research-entry');
  await page.waitForSelector('.program');
  await page.click('.template:has-text("Quant papers")');
  await page.click('button:has-text("Add program")');
  await page.waitForSelector('.toast:has-text("Program added")');
  let saved = (await api('GET', '/api/research')).body;
  const quant = saved.programs.find((p) => p.id === 'quant-papers');
  assert.ok(quant, 'saved'); assert.deepEqual([quant.seat, quant.window, quant.intervalMinutes, quant.sources.includes('arxiv.org')], ['quant-research', 'off-market', 1440, true]);
  assert.ok(!quant.review.reviewers.includes('quant-research'), 'never their own reviewer');
  // Edit through the sentence: tap "once a day", pick Weekly, save.
  const card = page.locator('[data-program="quant-papers"]');
  await card.locator('.slot:has-text("once a day")').click();
  await card.locator('[role="radio"]:has-text("Weekly")').click();
  await card.locator('button:has-text("Save program")').click();
  await page.waitForSelector('.toast:has-text("Program saved")');
  saved = (await api('GET', '/api/research')).body;
  assert.equal(saved.programs.find((p) => p.id === 'quant-papers').intervalMinutes, 10080);
  // Someone else saves while this editor is open: the save is refused and the typed name is kept.
  await card.locator('button:has-text("Edit")').click();
  await card.locator('#program-name').fill('Quant papers, weekly digest');
  const others = saved.programs.map((p) => ({ ...p, maxProposals: p.id === 'quant-papers' ? 3 : p.maxProposals }));
  assert.equal((await api('PUT', '/api/research/programs', { programs: others })).status, 200);
  await card.locator('button:has-text("Save program")').click();
  await page.waitForSelector('.toast.err:has-text("changed since you opened them")');
  assert.equal(await card.locator('#program-name').inputValue(), 'Quant papers, weekly digest');
  await card.locator('button:has-text("Save program")').click();
  await page.waitForSelector('.toast:has-text("Program saved")');
  assert.equal((await api('GET', '/api/research')).body.programs.find((p) => p.id === 'quant-papers').label, 'Quant papers, weekly digest');
  assert.deepEqual(errors.filter((e) => !/status of 409/.test(e)), [], 'only the expected conflict response is logged');
  await page.close();
});

test('connectors: the guided case form proposes a connector that awaits assessment', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await page.click('#btn-gear'); await page.click('.research-entry');
  await page.click('button:has-text("Propose a connector")');
  await page.fill('#conn-name', 'paper-search');
  await page.fill('#conn-purpose', 'Search arXiv and Semantic Scholar');
  const form = page.locator('.case-form');
  for (const label of ['Purpose', 'Benefit to the application', 'How it is used', 'Cost', 'Time', 'Data leaving the machine', 'Risks and fallback', 'Success measure'])
    await form.locator(`label.field:has(> span:text-is("${label}")) textarea`).fill(`${label} details`);
  await form.locator('[aria-pressed]:has-text("Discovery")').click();
  await form.locator('label.field:has(> span:text-is("Expected effect")) input').fill('proposals cite primary sources');
  await page.click('button:has-text("Propose connector")');
  await page.waitForSelector('.toast:has-text("Connector proposed")');
  const c = (await api('GET', '/api/connectors')).body.connectors.find((x) => x.name === 'paper-search');
  assert.equal(c.status, 'proposed'); assert.equal(c.proposed_by, 'owner');
  assert.match(c.case_md, /## SDLC stage improved\ndiscovery — proposals cite primary sources/);
  await page.waitForSelector('.connector:has-text("paper-search") button:has-text("Request assessment")');
  assert.deepEqual(errors, []);
  await page.close();
});
