// The desk's one-time sign-in link can land on a request (`next`), and only on a desk page: never another site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

test('sign-in links land on a desk page or a ticket, nothing else, without leaking the token', async (t) => {
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/local-preview.mjs'], { env: { ...process.env, SIGMADESK_PORT: String(port), SIGMADESK_PREVIEW_TOKEN: 'tok-deeplink-123' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (s) => { out += s; }); child.stderr.on('data', (s) => { out += s; });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise((r) => child.once('exit', r)); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/api/summary`)).status) break; } catch { /* booting */ } if (child.exitCode !== null) throw new Error(out); await new Promise((r) => setTimeout(r, 50)); }
  const go = (next, token = 'tok-deeplink-123') => fetch(`${url}/?token=${encodeURIComponent(token)}${next === null ? '' : `&next=${encodeURIComponent(next)}`}`, { redirect: 'manual' });
  let r = await go('#/inbox/SD-12');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/#/inbox/SD-12');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await go('#/features')).headers.get('location'), '/#/features');
  for (const bad of ['//evil.example', 'https://evil.example/#/inbox/SD-1', '#/inbox/SD-12\r\nX: y', '#/inbox/sd-12', '#/inbox/SD-12/extra', null]) {
    assert.equal((await go(bad)).headers.get('location'), '/', `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal((await go('#/inbox/SD-12', 'wrong')).status, 401);
  const summary = await fetch(`${url}/api/summary`, { headers: { 'x-sigmadesk-token': 'tok-deeplink-123' } }).then((x) => x.json());
  assert.ok(Array.isArray(summary.recent_requests));
});
