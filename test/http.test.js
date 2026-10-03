import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

test('isolated HTTP desk: UI, live events, settings, ticket decisions and desktop reviews', async (t) => {
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/local-preview.mjs'], { env: { ...process.env, SIGMADESK_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve)); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/api/state`)).ok) { ready = true; break; } } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`Preview failed: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const request = (method, p, b) => fetch(url + p, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const state = await (await request('GET', '/api/state')).json();
  assert.equal(state.settings.paused, 'true'); assert.ok(state.meta.advisors.models.length >= 7); assert.equal(state.meta.background.screen_lock_supported, true);
  assert.ok(state.agents.every((a) => !a.enabled));
  assert.equal(state.meta.preview, true);
  assert.equal((await request('POST', '/api/providers/desktop-usage', { remaining: -1 })).status, 400);
  assert.equal((await request('POST', '/api/providers/desktop-usage', { remaining: 44985, used_month: 14.87 })).status, 200);
  const observed = await (await request('GET', '/api/state')).json();
  assert.equal(observed.meta.usage.perplexity_desktop.credits_remaining, 44985);
  assert.equal((await fetch(`${url}/api/settings`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await request('POST', '/api/settings', { key: 'max_concurrent', value: '0' })).status, 400);
  const html = await fetch(url); assert.match(html.headers.get('content-security-policy'), /default-src 'self'/); assert.match(await html.text(), /Reliability/);
  const abort = new AbortController(); const stream = await fetch(url + '/api/stream', { signal: abort.signal });
  const reader = stream.body.getReader(); await reader.read();
  const created = await request('POST', '/api/tickets', { title: 'HTTP acceptance fixture', description: 'Verify owner decisions', type: 'bug', priority: 'P1' }); assert.equal(created.status, 201);
  const ticket = await created.json();
  const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /HTTP acceptance fixture/); abort.abort();
  assert.equal((await request('PATCH', `/api/tickets/${ticket.key}`, { status: 'invalid' })).status, 400);
  await request('PATCH', `/api/tickets/${ticket.key}`, { status: 'needs_human' });
  const routed = await (await request('POST', `/api/tickets/${ticket.key}/reply`, { body: 'Discuss this design with manager and principal engineers.' })).json();
  assert.equal(routed.message_route, 'discussion'); assert.equal(routed.status, 'needs_human');
  assert.equal((await request('POST', `/api/tickets/${ticket.key}/decision`, { decision: 'correction', message: '' })).status, 400);
  await request('POST', `/api/tickets/${ticket.key}/reply`, { body: 'Use the documented contract' });
  const detail = await (await request('GET', `/api/tickets/${ticket.key}`)).json(); assert.ok(detail.comments.some((c) => c.body.includes('documented contract')));
  const review = await (await request('POST', `/api/tickets/${ticket.key}/architecture-reviews`, { reviewer: 'perplexity/glm-5.3', challenger: 'xai/grok-4.7' })).json();
  assert.equal(review.status, 'awaiting_result'); assert.equal((await request('POST', `/api/architecture-reviews/${review.id}/run`, {})).status, 409);
  const report = await (await request('POST', `/api/architecture-reviews/${review.id}/import`, { result: 'Use atomic reservations and bounded retries.' })).json(); assert.equal(report.status, 'complete');
  assert.equal((await request('POST', `/api/architecture-reviews/${review.id}/import`, { result: 'again' })).status, 409);
  assert.equal((await request('POST', '/api/control/start', {})).status, 200);
  assert.equal((await request('POST', '/api/control/stop-all', {})).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const health = await (await request('GET', '/api/health')).json(); assert.equal(health.scheduler.paused, true); assert.ok(health.scheduler.last_tick); assert.equal(health.watch.sources[0].ok, true);
});
