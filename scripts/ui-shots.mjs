#!/usr/bin/env node
// `npm run ui:shots [outDir]` — screenshots of every page and panel at phone and desktop widths against the isolated
// preview desk, plus any console/page errors. For reviewing UI changes; nothing here talks to a real desk.
import fs from 'node:fs';
import path from 'node:path';
import { startPreview, launch, openPage } from './ui-browser.mjs';

const out = path.resolve(process.argv[2] || '/tmp/sigmadesk-shots');
fs.mkdirSync(out, { recursive: true });
const preview = await startPreview({ SIGMADESK_REVIEW_DEMO: '1' });
const browser = await launch();
if (!browser) { console.error('No Chromium found (set SIGMADESK_CHROMIUM).'); await preview.stop(); process.exit(1); }
const widths = (process.env.WIDTHS || '390,1280').split(',').map(Number);
const problems = [];
try {
  for (const w of widths) {
    const { page, errors } = await openPage(browser, preview.url, { width: w, height: w < 768 ? 844 : 900 });
    const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `${w}-${name}.png`) }); };
    const go = async (route) => { await page.evaluate((r) => { location.hash = r; }, route); await page.waitForTimeout(400); };
    const panel = async (name, open) => { await open(); await page.waitForSelector('[data-panel], [role="dialog"]'); await shot(name); await page.keyboard.press('Escape'); await page.waitForSelector('[data-panel], [role="dialog"]', { state: 'detached' }); };
    await shot('inbox');
    for (const p of ['work', 'team', 'desk', 'settings', 'prs']) { await go(`#/${p}`); await shot(p); }
    await go('#/inbox');
    await panel('ticket-question', () => page.click('article[data-kind="question"] h3 button'));
    await panel('ticket-design', () => page.click('article[data-kind="design"] h3 button'));
    await page.click('article[data-kind="question"] h3 button'); await page.waitForSelector('[data-panel]');
    await page.getByRole('tab', { name: 'Conversation' }).click(); await shot('ticket-conversation');
    await page.getByRole('tab', { name: 'Details' }).click(); await shot('ticket-details'); await page.keyboard.press('Escape');
    await panel('new-ticket', () => page.getByRole('button', { name: 'New ticket' }).click());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await page.waitForSelector('[cmdk-input]'); await shot('palette'); await page.keyboard.press('Escape');
    await go('#/research'); await page.waitForSelector('[data-program]'); await shot('research');
    await page.click('[data-program] button.font-semibold'); await page.waitForSelector('[data-row="seat"]'); await shot('research-editor');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.click('button:has-text("Quant papers")'); await page.waitForSelector('[data-row="seat"]'); await shot('research-template');
    await page.evaluate(() => document.getElementById('connectors')?.scrollIntoView()); await shot('research-connectors');
    await go('#/team'); await panel('models', () => page.getByRole('button', { name: 'Models & fallback' }).first().click());
    if (errors.length) problems.push(`${w}px:\n  ${errors.join('\n  ')}`);
    await page.close();
  }
} finally { await browser.close(); await preview.stop(); }
console.log(`Screenshots in ${out}`);
if (problems.length) { console.error(`Browser errors:\n${problems.join('\n')}`); process.exit(1); }
