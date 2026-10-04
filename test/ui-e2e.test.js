// Browser interaction tests for the desk UI against the isolated preview desk. Skipped when no Chromium is cached
// (scripts/ui-browser.mjs finds playwright's cache or $SIGMADESK_CHROMIUM). They pin the behaviours a redesign can
// silently lose: drafts surviving live updates, a vanished decision, focus return, URL routing, conditional research
// saves, connector proposals, and no horizontal overflow on phones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
let preview, browser;
before(async () => { if (skip) return; preview = await startPreview(); browser = await launch(); });
after(async () => { await browser?.close(); await preview?.stop(); });
const api = (method, p, b) => fetch(preview.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

test('a reply draft survives live updates, persists, and closing returns focus to the card', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  const card = page.locator('article[data-kind="question"]').first();
  const key = await card.getAttribute('data-ticket');
  await card.locator('h3 button').click();
  const reply = page.locator('#reply');
  await reply.click(); await reply.fill('Page after five errors');
  await api('POST', `/api/tickets/${key}/reply`, { body: 'Context from the owner', mode: 'comment' });
  const other = (await api('GET', '/api/state')).body.tickets.find((t) => t.key !== key);
  await api('PATCH', `/api/tickets/${other.key}`, { priority: 'P3' });
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForSelector('text=Context from the owner');
  await page.getByRole('tab', { name: 'Decision' }).click();
  assert.equal(await reply.inputValue(), 'Page after five errors', 'switching tabs and live updates keep the draft');
  assert.match(page.url(), new RegExp(`#/inbox/${key}$`), 'the open ticket is in the URL');
  assert.match(await page.evaluate(() => localStorage.getItem('sd2.drafts')), /Page after five errors/);
  await reply.focus();
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-panel]', { state: 'detached' });
  // Focus moves back once the panel's exit and the route change settle (a frame or two after it detaches).
  await page.waitForFunction((k) => document.activeElement?.closest('[data-key]')?.getAttribute('data-key')?.split(':')[0] === k, key, { timeout: 3000 }).catch(() => {});
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key')?.split(':')[0]), key, 'focus returns to the card that opened it');
  assert.match(page.url(), /#\/inbox$/, 'closing returns to the page URL');
  await card.locator('h3 button').click();
  assert.equal(await page.locator('#reply').inputValue(), 'Page after five errors', 'reopening restores the draft');
  await page.goBack(); await page.waitForSelector('[data-panel]', { state: 'detached' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('a decision resolved elsewhere while open shows a notice instead of switching decisions', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  const card = page.locator('article[data-kind="design"]').first();
  const key = await card.getAttribute('data-ticket');
  await card.locator('h3 button').click();
  await page.waitForSelector('text=Recommendation #1');
  const r = await api('POST', `/api/tickets/${key}/decision`, { decision: 'approve', message: 'from another device', discussion_id: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await page.waitForSelector('text=That decision was resolved or changed while you were reading');
  assert.equal(await page.getByRole('button', { name: /Approve design/ }).count(), 0, 'no stale approve button');
  assert.deepEqual(errors, []);
  await page.close();
});

test('pages and tickets are addressable: deep links open the ticket, Back closes it, legacy #KEY still works', { skip, timeout: 60_000 }, async () => {
  const key = (await api('GET', '/api/state')).body.tickets.find((t) => t.status === 'todo').key;
  const { page, errors } = await openPage(browser, `${preview.url}/#/work/${key}`, { width: 1280, height: 900 });
  await page.waitForSelector('[data-panel]');
  assert.equal(await page.locator('header h1').textContent(), 'Work');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForSelector('[data-panel]', { state: 'detached' });
  assert.match(page.url(), /#\/work$/, 'a cold deep link closes to its page, not out of the app');
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Research' }).click();
  assert.match(page.url(), /#\/research$/); await page.waitForSelector('[data-program]');
  await page.goBack(); assert.equal(await page.locator('header h1').textContent(), 'Work');
  await go(page, `#${key}`); await page.waitForSelector('[data-panel]');
  assert.deepEqual(errors, []);
  await page.close();
});

test('research: add from a template, change it through the sentence, and a concurrent save is refused without losing the edit', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 1280, height: 900 });
  await go(page, '#/research');
  await page.waitForSelector('[data-program]');
  await page.getByRole('button', { name: /Quant papers/ }).click();
  await page.getByRole('button', { name: 'Add program' }).click();
  await page.waitForSelector('text=Program added');
  let saved = (await api('GET', '/api/research')).body;
  const quant = saved.programs.find((p) => p.id === 'quant-papers');
  assert.ok(quant, 'saved'); assert.deepEqual([quant.seat, quant.window, quant.intervalMinutes, quant.sources.includes('arxiv.org')], ['quant-research', 'off-market', 1440, true]);
  assert.ok(!quant.review.reviewers.includes('quant-research'), 'never their own reviewer');
  const card = page.locator('[data-program="quant-papers"]');
  await card.getByRole('button', { name: 'once a day' }).click();
  await card.getByRole('radio', { name: 'Weekly' }).click();
  await card.getByRole('button', { name: 'Save program' }).click();
  await page.waitForSelector('text=Program saved');
  saved = (await api('GET', '/api/research')).body;
  assert.equal(saved.programs.find((p) => p.id === 'quant-papers').intervalMinutes, 10080);
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('#program-name').fill('Quant papers, weekly digest');
  const others = saved.programs.map((p) => ({ ...p, maxProposals: p.id === 'quant-papers' ? 3 : p.maxProposals }));
  assert.equal((await api('PUT', '/api/research/programs', { programs: others })).status, 200);
  await card.getByRole('button', { name: 'Save program' }).click();
  await page.waitForSelector('text=changed since you opened them');
  assert.equal(await card.locator('#program-name').inputValue(), 'Quant papers, weekly digest');
  await card.getByRole('button', { name: 'Save program' }).click();
  await page.waitForSelector('text=Program saved');
  assert.equal((await api('GET', '/api/research')).body.programs.find((p) => p.id === 'quant-papers').label, 'Quant papers, weekly digest');
  assert.deepEqual(errors.filter((e) => !/status of 409/.test(e)), [], 'only the expected conflict response is logged');
  await page.close();
});

test('connectors: the guided case form proposes a connector that awaits assessment', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  await go(page, '#/research');
  await page.getByRole('button', { name: 'Propose a connector' }).click();
  await page.fill('#conn-name', 'paper-search');
  await page.fill('#conn-purpose', 'Search arXiv and Semantic Scholar');
  for (const label of ['Purpose', 'Benefit to the application', 'How it is used', 'Cost', 'Time', 'Data leaving the machine', 'Risks and fallback', 'Success measure'])
    await page.getByLabel(label, { exact: true }).fill(`${label} details`);
  await page.getByRole('button', { name: 'Discovery' }).click();
  await page.getByLabel('Expected effect').fill('proposals cite primary sources');
  await page.getByRole('button', { name: 'Propose connector' }).click();
  await page.waitForSelector('text=Connector proposed');
  const c = (await api('GET', '/api/connectors')).body.connectors.find((x) => x.name === 'paper-search');
  assert.equal(c.status, 'proposed'); assert.equal(c.proposed_by, 'owner');
  assert.match(c.case_md, /## SDLC stage improved\ndiscovery — proposals cite primary sources/);
  await page.locator('article', { hasText: 'paper-search' }).getByRole('button', { name: 'Request assessment' }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('no page scrolls sideways on a 320 px phone, and the command palette opens a ticket', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 320, height: 700 });
  for (const r of ['#/inbox', '#/work', '#/team', '#/research', '#/prs', '#/desk', '#/settings']) {
    await go(page, r); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${r} fits 320 px`);
  }
  const t = (await api('GET', '/api/state')).body.tickets.find((x) => x.status === 'todo');
  await go(page, '#/inbox');
  await page.getByRole('button', { name: 'More' }).click();
  await page.waitForSelector('[cmdk-input]');
  await page.keyboard.type(t.key);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-panel]');
  assert.match(page.url(), new RegExp(`/${t.key}$`));
  assert.deepEqual(errors, []);
  await page.close();
});

test('features: a ready plan is reviewed, a task is renamed, and approval starts the work in order', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, preview.url, { width: 390, height: 844 });
  const plans = (await api('GET', '/api/state')).body.meta.feature_plans;
  const ready = plans.find((p) => p.status === 'ready');
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Features' }).click();
  await page.locator(`[data-feature="${ready.ticket_key}"] h3 button`).click();
  assert.match(page.url(), new RegExp(`#/features/${ready.ticket_key}$`));
  await page.getByLabel('Task 3 title').fill('Daily fill-cost card');
  await page.getByLabel('Include task 1').click();
  await page.getByRole('button', { name: /Approve plan and start 2 tasks/ }).click();
  await page.waitForSelector('text=keep both or drop both');
  await page.getByLabel('Include task 1').click();
  await page.getByRole('button', { name: /Approve plan and start 3 tasks/ }).click();
  await page.waitForSelector('text=Approved; tasks created');
  const st = (await api('GET', '/api/state')).body;
  const kids = st.tickets.filter((t) => t.parent_key === ready.ticket_key).sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  assert.deepEqual(kids.map((k) => k.title).at(-1), 'Daily fill-cost card');
  assert.equal(kids[1].after_key, kids[0].key); assert.equal(kids[2].after_key, kids[1].key);
  assert.equal(st.tickets.find((t) => t.key === ready.ticket_key).status, 'in_progress');
  await page.waitForSelector(`text=You approved round ${ready.revision}`);
  await page.getByRole('button', { name: 'Daily fill-cost card' }).click();
  await page.waitForSelector('[data-panel]');
  assert.match(page.url(), new RegExp(`#/features/${ready.ticket_key}/${kids[2].key}$`), 'a task opens over its feature');
  await page.goBack(); await page.waitForSelector('[data-panel]', { state: 'detached' });
  assert.match(page.url(), new RegExp(`#/features/${ready.ticket_key}$`));
  assert.deepEqual(errors.filter((e) => !/status of 400/.test(e)), []);
  await page.close();
});

test('features: a new feature is described in a dialog and lands on its page waiting for Codex', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, `${preview.url}/#/features`, { width: 1280, height: 900 });
  await page.getByRole('button', { name: 'New feature' }).click();
  await page.getByLabel('Name').fill('Strategy P&L heatmap');
  await page.getByLabel('What should it do, and for whom?').fill('A heatmap of daily P&L by strategy for the evening review.');
  await page.getByRole('radio', { name: 'Frontend' }).click();
  await page.getByRole('button', { name: 'Create and plan with Codex' }).click();
  await page.waitForSelector('text=is waiting for Codex');
  const t = (await api('GET', '/api/state')).body.tickets.find((x) => x.title === 'Strategy P&L heatmap');
  assert.equal(t.type, 'feature'); assert.equal(t.status, 'proposed'); assert.equal(t.area, 'frontend');
  assert.match(page.url(), new RegExp(`#/features/${t.key}$`));
  assert.deepEqual(errors, []);
  await page.close();
});

test('epics and tasks link both ways: crumbs on a task, a Tasks tab on its epic, and Work grouped by epic', { skip, timeout: 90_000 }, async () => {
  const st = (await api('GET', '/api/state')).body;
  const slice = st.tickets.find((t) => t.title.startsWith('Normalize equity'));
  const sub = st.tickets.find((t) => t.key === slice.parent_key);
  const root = st.tickets.find((t) => t.key === sub.parent_key);
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox`, { width: 1280, height: 900 });
  const card = page.locator(`article[data-ticket="${slice.key}"]`);
  assert.match(await card.getByLabel(/^Part of /).textContent(), /Equity fill-cost journal.*Write fills/, 'the Inbox card names its epic');
  await card.locator('h3 button').click();
  await page.waitForSelector('[data-panel]');
  const crumbs = page.locator('[data-panel]').getByLabel(/^Part of /);
  await crumbs.getByRole('button', { name: /Write fills/ }).click();
  await page.waitForSelector(`[data-panel] [data-epic-tree="${sub.key}"]`);
  assert.equal(await page.locator('[data-panel]').getByRole('tab', { name: /Tasks/ }).getAttribute('data-state'), 'active', 'an epic opens on its tasks');
  assert.ok(await page.locator(`[data-panel] [data-task="${slice.key}"]`).count());
  assert.match(await page.locator('[data-panel] [data-epic-tree]').first().textContent(), /waits for/);
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-panel]', { state: 'detached' });
  await page.evaluate(() => { location.hash = '#/work'; });
  await page.getByRole('radio', { name: 'By epic' }).click();
  const epic = page.locator(`[data-epic="${root.key}"]`);
  await epic.waitFor();
  assert.ok(await epic.locator(`[data-task="${slice.key}"]`).count(), 'the nested slice appears inside its top-level epic');
  assert.match(await epic.textContent(), /1 of 4 tasks shipped/);
  assert.equal(await page.evaluate(() => localStorage.getItem('sd2.workGroup')), 'epic');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a stuck epic shows its next step, records a written gate in one tap, and the Inbox asks one question', { skip, timeout: 90_000 }, async () => {
  const st = (await api('GET', '/api/state')).body;
  const audit = st.tickets.find((t) => t.title === 'Fill audit');
  const [verify, contract, backfill] = ['Verify fills', 'Audit contract', 'Backfill the audit'].map((p) => st.tickets.find((t) => t.title.startsWith(p)));
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox`, { width: 390, height: 844 });
  const card = page.locator(`article[data-ticket="${verify.key}"]`);
  await card.waitFor();
  assert.equal(await card.getAttribute('data-kind'), 'question');
  assert.equal(await card.locator('[data-waiting]').getAttribute('data-waiting'), contract.key, 'the contract question folds under the one it waits on');
  assert.equal(await page.locator(`article[data-ticket="${contract.key}"]`).count(), 0);
  await go(page, `#/features/${audit.key}`);
  const next = page.locator('[data-next-step]');
  await next.waitFor();
  assert.equal(await next.getAttribute('data-next-step'), verify.key);
  assert.match(await next.textContent(), /2 tasks wait on it/);
  assert.match(await next.textContent(), /You:/, 'the owner is the one who must act');
  assert.match(await page.locator('aside[aria-label="Grooming session"]').textContent(), /Already split into 3 open tasks/);
  assert.equal(await page.getByRole('button', { name: 'Plan with Codex' }).count(), 0, 'a split feature is not offered a plan it cannot start');
  await page.locator(`[data-gate="${contract.key}>${verify.key}"]`).getByRole('button', { name: /^Make / }).click();
  await page.locator(`[data-gate="${contract.key}>${verify.key}"]`).waitFor({ state: 'detached' });
  const after = (await api('GET', '/api/state')).body.tickets;
  assert.equal(after.find((t) => t.key === contract.key).after_key, verify.key, 'the written gate is now enforced');
  assert.ok(await page.locator(`[data-gate="${backfill.key}>${contract.key}"]`).count(), 'the other gate is still offered');
  assert.ok(await page.locator(`[data-epic-review="${audit.key}"]`).count(), 'the epic can be reviewed with the manager');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits a phone');
  assert.deepEqual(errors, []);
  await page.close();
});
