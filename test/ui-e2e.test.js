// Browser interaction tests for the desk UI against the isolated preview desk. Skipped when no Chromium is cached
// (scripts/ui-browser.mjs finds playwright's cache or $SIGMADESK_CHROMIUM). They pin the behaviours a redesign can
// silently lose: drafts surviving live updates, a vanished decision, focus return, URL routing, conditional research
// saves, connector proposals, and no horizontal overflow on phones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview, launch, openPage, findChromium } from '../scripts/ui-browser.mjs';

const skip = !findChromium() && 'no Chromium available';
let preview, browser;
// The preview desk's playbook: a copy of the shipped default this file may edit (the owner's standing rules).
const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-e2e-playbook-'));
const PLAYBOOK = path.join(pbDir, 'playbook.md');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbooks', 'default.md'), PLAYBOOK);
before(async () => { if (skip) return; preview = await startPreview({ SIGMADESK_PREVIEW_PLAYBOOK: PLAYBOOK }); browser = await launch(); });
after(async () => { await browser?.close(); await preview?.stop(); fs.rmSync(pbDir, { recursive: true, force: true }); });
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

test('a request opens on its tracker: where it stands, step by step, on a phone', { skip, timeout: 60_000 }, async () => {
  const made = await api('POST', '/api/tickets', { title: 'Show the shipping cost before checkout', description: 'Buyers abandon carts.', kind: 'auto', request_id: 'e2e-tracker-1', source: 'hub' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox/${made.body.key}`, { width: 390, height: 844 });
  const tracker = page.locator(`[data-tracker="${made.body.key}"]`);
  await tracker.waitFor();
  assert.match(await tracker.textContent(), /Received[\s\S]*Waiting to be triaged[\s\S]*1\/8/);
  await tracker.locator('button[aria-expanded]').click();
  assert.equal(await tracker.locator('ol li').count(), 8);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits a phone');
  assert.equal((await api('POST', '/api/tickets', { title: 'Show the shipping cost before checkout', description: 'Buyers abandon carts.', kind: 'auto', request_id: 'e2e-tracker-1', source: 'hub' })).status, 200, 'a retry returns the same ticket');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the conversation reads newest first (toggle kept), the thread scrolls with the page, and the reply grows as you type', { skip, timeout: 60_000 }, async () => {
  const t = (await api('POST', '/api/tickets', { title: 'Conversation order fixture', description: 'x', type: 'bug' })).body;
  for (const [i, body] of ['first note', 'second note', 'third note'].entries()) { await api('POST', `/api/tickets/${t.key}/reply`, { body, mode: 'comment' }); await new Promise((r) => setTimeout(r, 15 + i)); }
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox/${t.key}`, { width: 390, height: 844 });
  await page.waitForSelector('[data-panel]');
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForSelector('text=third note');
  const texts = async () => page.$$eval('[role=log] [data-message]', (els) => els.map((e) => e.textContent).filter((x) => /note/.test(x)));
  assert.match((await texts())[0], /third note/, 'the latest message is first');
  assert.equal(await page.$eval('[role=log]', (el) => getComputedStyle(el).overflowY), 'visible', 'no box inside a box');
  await page.click('[data-conv-order]');
  assert.match((await texts())[0], /first note/, 'oldest first on request');
  assert.equal(await page.evaluate(() => localStorage.getItem('sd2.convOrder')), 'oldest');
  await page.click('[data-conv-order]');
  const reply = page.locator('#message'); // the message bar: always there, no button first
  const before = await reply.evaluate((el) => el.offsetHeight);
  await reply.fill('line one\nline two\nline three\nline four\nline five');
  assert.ok((await reply.evaluate((el) => el.offsetHeight)) > before, 'the box grows with the text');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await page.close();
});

test('the Inbox: do first, lanes, compact rows, and a snooze that leaves the count and comes back', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox`, { width: 390, height: 844 });
  await page.waitForSelector('[data-do-first]');
  assert.ok(await page.locator('[data-lane="unblock"]').count(), 'lanes by what you are doing');
  const row = page.locator('[data-lane] article[data-kind="question"]').first();
  const id = await row.getAttribute('data-key');
  const rowHeight = await row.evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(rowHeight < 120, `a compact row (${rowHeight}px)`);
  const before = (await api('GET', '/api/state')).body;
  await row.getByRole('button', { name: /^Options for/ }).click();
  await page.getByRole('menuitem', { name: /Snooze for 4 hours/ }).click();
  await page.waitForSelector(`[data-lane] article[data-key="${id}"]`, { state: 'detached' }).catch(() => {});
  await page.waitForSelector('[data-snoozed]');
  assert.equal(await page.locator(`[data-lane] article[data-key="${id}"]`).count(), 0, 'gone from the lanes');
  assert.match(await page.getByRole('group', { name: 'Desk status' }).textContent(), /1 snoozed/);
  await page.locator('[data-snoozed] > button').click();
  const snoozedRow = page.locator(`[data-snoozed] article[data-key="${id}"]`);
  assert.match(await snoozedRow.textContent(), /back /);
  await snoozedRow.getByRole('button', { name: /^Options for/ }).click();
  await page.getByRole('menuitem', { name: 'Bring back now' }).click();
  await page.locator('[data-snoozed]').waitFor({ state: 'detached' });
  assert.ok(await page.locator(`article[data-key="${id}"]`).count(), 'back in the Inbox');
  assert.ok(before.meta.waiting_since && Object.keys(before.meta.waiting_since).length, 'the desk records when each decision appeared');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits a phone');
  assert.deepEqual(errors, []);
  await page.close();
});

test('delegation (#9): Decided for you with Override, the delegate\'s take on an open decision, and who decides in Settings', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox`, { width: 1280, height: 900 });
  const lane = page.locator('[data-lane="decided"]');
  await lane.waitFor();
  const row = lane.locator('article[data-status="applied"]', { hasText: 'Morgan answered Riley' }).first();
  const id = await row.getAttribute('data-decided');
  assert.match(await row.textContent(), /Morgan answered Riley: Only in utils\/net\.py/);
  assert.equal(await page.locator('[data-lane="unblock"] [data-decided]').count(), 0, 'decided rows are not in the lanes that need you');
  await row.locator('button[aria-expanded]').click(); // Override and Reopen live in the expanded row
  await row.getByRole('button', { name: 'Override' }).click();
  await row.getByLabel('Your decision instead').fill('Wait for the count first.');
  await row.getByRole('button', { name: 'Post my decision' }).click();
  await page.waitForSelector(`[data-decided="${id}"][data-status="overridden"]`);
  const rec = (await api('GET', `/api/delegation/${id}`)).body;
  assert.deepEqual([rec.status, rec.override_note], ['overridden', 'Wait for the count first.']);
  assert.ok(rec.brief?.you_decide, 'the audit keeps the brief it was based on');
  // An open decision carries what Morgan would decide (shadow) or why it is yours (escalated), on the card and in the panel.
  const take = page.locator('[data-lane] article:has([data-take])').first();
  assert.match(await take.locator('[data-take]').textContent(), /Morgan (would decide|left it for you)/);
  await take.locator('h3 button').click();
  await page.waitForSelector('[data-panel] [data-delegate-note]');
  assert.match(await page.locator('[data-panel] [data-delegate-note]').textContent(), /Nothing was changed/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-panel]', { state: 'detached' });
  // Settings → Autonomy: one row per kind; a mode change is saved as the whole matrix.
  await go(page, '#/settings');
  const q = page.locator('[data-delegation-kind="question"]');
  await q.waitFor();
  assert.equal(await q.getAttribute('data-mode'), 'shadow', 'every kind starts in shadow');
  // The preview's playbook marks no standing rules: Settings says plainly that every decision still comes to the owner.
  assert.equal(await page.locator('[data-standing-rules]').getAttribute('data-standing-rules'), '0');
  const rules = await page.locator('[data-standing-rules]').textContent();
  assert.match(rules, /You have not written any standing rules yet \(a “Standing rules the EM may apply alone” section in your playbook\), so nothing below is decided for you by judgment/);
  assert.match(rules, /Owner tasks are the exception: a step filed as a check or a package is routed by rule/, 'the rule-decided exception is stated');
  assert.match(rules, /cannot undo what the team already did after a decision/, 'override is not a rollback');
  await q.getByRole('radio', { name: 'Morgan decides' }).click();
  await page.waitForSelector('[data-delegation-kind="question"][data-mode="em"]');
  assert.equal((await api('GET', '/api/delegation')).body.kinds.find((k) => k.id === 'question').mode, 'em');
  await page.locator('[data-delegation-kind="question"]').getByRole('radio', { name: 'Shadow' }).click();
  await page.waitForSelector('[data-delegation-kind="question"][data-mode="shadow"]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await page.close();
});

test('delegation (#9) on a phone: a decided row folds into two lines however long it is; Override and Reopen wait in the expanded row', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage(browser, `${preview.url}/#/inbox`, { width: 390, height: 844 });
  const lane = page.locator('[data-lane="decided"]');
  await lane.waitFor();
  const row = lane.locator('article[data-decided]', { hasText: 'adapters/timefmt.py' }).first();
  await row.waitFor();
  // One truncated line each: the decision, then its status, kind, ticket and time.
  const oneLine = (loc) => loc.evaluate((el) => {
    const st = getComputedStyle(el);
    return { nowrap: st.whiteSpace === 'nowrap', truncated: el.scrollWidth > el.clientWidth, single: el.getBoundingClientRect().height < 1.9 * parseFloat(st.fontSize) };
  });
  const title = await oneLine(row.locator('[data-decided-title]')), meta = await oneLine(row.locator('[data-decided-meta]'));
  assert.deepEqual(title, { nowrap: true, truncated: true, single: true }, 'the long decision is one truncated line');
  assert.deepEqual([meta.nowrap, meta.single], [true, true], 'the long ticket title stays on the second line');
  assert.match(await row.locator('[data-decided-meta]').textContent(), /^(just now|\d+ ?\w+ ago) · Engineers' questions · /, 'the time is never the part that gets cut');
  const box = await row.boundingBox();
  assert.ok(box.height <= 64, `collapsed: two lines and padding, not ${box.height}px`);
  assert.equal(await row.getByRole('button', { name: 'Override' }).count(), 0, 'no actions while collapsed');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  await row.locator('button[aria-expanded]').click();
  await row.getByRole('button', { name: 'Override' }).waitFor();
  assert.equal(await row.getByRole('button', { name: 'Reopen' }).count(), 1);
  assert.match(await row.locator('[data-decided-detail]').textContent(), /the audit export should call to_utc\(\) too/, 'the whole decision once expanded');
  await row.locator('[data-based-on]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'expanded: still no sideways scrolling');
  assert.deepEqual(errors, []);
  await page.close();
});

test('delegation (#9): Settings follows the playbook as the owner edits it, without a reload, and says what the desk checks', { skip, timeout: 90_000 }, async () => {
  const { page, errors } = await openPage(browser, `${preview.url}/#/settings`, { width: 1280, height: 900 });
  const line = page.locator('[data-standing-rules]');
  await line.waitFor();
  assert.equal(await line.getAttribute('data-standing-rules'), '0');
  const shipped = fs.readFileSync(PLAYBOOK, 'utf8');
  try {
    // The owner writes one rule (an example in a code block grants nothing). No policy change: only the playbook moved.
    fs.writeFileSync(PLAYBOOK, shipped.replace('## Standing rules the EM may apply alone', '## Standing rules the EM may apply alone\n- Answer which-file and which-test questions from the code, citing the file and line.\n\n```\n- Approve any purchase.\n```\n'));
    const asked = (await api('GET', '/api/state')).body.tickets.find((t) => t.title.startsWith('Normalize equity fills'));
    const poke = await api('POST', '/api/inbox/snooze', { id: `${asked.key}:question`, until: null }); // any change that refreshes the snapshot
    assert.equal(poke.status, 200, JSON.stringify(poke.body));
    await page.waitForSelector('[data-standing-rules="1"]', { timeout: 20_000 });
    const text = await line.textContent();
    assert.match(text, /only under the standing rule you wrote in your playbook under “Standing rules the EM may apply alone”/);
    assert.match(text, /The desk checks that what they cite is your rule and was in the brief; whether the rule fits the decision is their judgment/);
    assert.match(text, /cannot undo what the team already did after a decision/);
  } finally { fs.writeFileSync(PLAYBOOK, shipped); }
  assert.deepEqual(errors, []);
  await page.close();
});
