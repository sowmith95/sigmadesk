#!/usr/bin/env node
// `npm run ui:shots [outDir]` — screenshots of every view and sheet at phone and desktop widths against the isolated
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
    const { page, errors } = await openPage(browser, preview.url, { width: w, height: w < 760 ? 844 : 900 });
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${w}-${name}.png`), fullPage: false }); };
    const sheet = async (name, open) => { await open(); await page.waitForSelector('.sheet-panel'); await shot(name); await page.keyboard.press('Escape'); await page.waitForSelector('.sheet-panel', { state: 'detached' }); };
    await shot('inbox');
    await page.click('nav.tabs button:has-text("Work")'); await shot('work');
    await page.click('nav.tabs button:has-text("Team")'); await shot('team');
    await page.click('nav.tabs button:has-text("Inbox")');
    await sheet('ticket-question', () => page.click('.dcard.kind-question .title-btn'));
    await sheet('ticket-design', () => page.click('.dcard.kind-design .title-btn'));
    await sheet('new-ticket', () => page.click('#btn-new'));
    await sheet('desk', () => page.click('.inst.desk'));
    await sheet('money', () => page.click('.inst.money'));
    await sheet('settings', () => page.click('#btn-gear'));
    await page.click('#btn-gear'); await page.click('.research-entry'); await page.waitForSelector('.program'); await shot('research');
    await page.click('.program .slot.who'); await page.waitForSelector('.editor'); await shot('research-editor');
    await page.click('.editor button:has-text("Cancel")');
    await page.click('.template:has-text("Quant papers")'); await page.waitForSelector('.editor'); await shot('research-template');
    await page.evaluate(() => document.getElementById('connectors')?.scrollIntoView()); await shot('research-connectors');
    await page.keyboard.press('Escape');
    await page.click('nav.tabs button:has-text("Team")'); await sheet('models', () => page.click('.team-model button:has-text("Edit models")'));
    await sheet('seat', () => page.click('.team-model .title-btn'));
    if (errors.length) problems.push(`${w}px:\n  ${errors.join('\n  ')}`);
    await page.close();
  }
} finally { await browser.close(); await preview.stop(); }
console.log(`Screenshots in ${out}`);
if (problems.length) { console.error(`Browser errors:\n${problems.join('\n')}`); process.exit(1); }
