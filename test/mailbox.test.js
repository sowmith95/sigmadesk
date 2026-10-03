import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-mailbox-'));
const cfg = path.join(tmp, 'config.json'); fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' } }));
process.env.SIGMADESK_CONFIG = cfg;

test('file desk transport creates its reply directory and retries I/O without executing an action twice', async () => {
  const { config } = await import('../src/config.js'); config.root = tmp;
  const store = await import('../src/db.js'); store.openDb(':memory:');
  const runner = await import('../src/runner.js'); const dispatch = await import('../src/dispatch.js'); const team = await import('../src/team.js');
  const server = await import('../src/server.js');
  const cwd = path.join(tmp, 'clone'); fs.mkdirSync(cwd);
  const t = store.createTicket({ title: 'Mailbox transport', status: 'todo', assignee: 'senior-be' });
  const cli = path.join(tmp, 'fixture.mjs'); fs.writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdin.resume(); setTimeout(()=>{console.log(JSON.stringify({type:"turn.completed",usage:{}}));},500);\n'); fs.chmodSync(cli, 0o755);
  config.engines.codex.bin = cli; team.applyTeamOverrides({ 'senior-be': { engine: 'codex', model: '' } }); dispatch.setAvailability([{ id: 'codex', available: true }]);
  const task = runner.startRun({ agentId: 'senior-be', kind: 'implement', cwd, prompt: 'fixture', ticketKey: t.key });
  const [runId, dir] = runner.openMailboxes()[0]; const token = store.getRun(runId).token;
  const req = (id, body) => fs.writeFileSync(path.join(dir, `req-${id}.json`), JSON.stringify({ token, cmd: 'comment', body: { body } }));
  req('1111111111111111', 'first'); server.pollMailboxes(); await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(path.join(dir, 'res-1111111111111111.json'))); assert.equal(store.listComments(t.key).length, 1); assert.ok(!fs.existsSync(path.join(dir, 'req-1111111111111111.json')));
  // A blocked private directory must leave the request and cache the completed outcome.
  fs.rmSync(path.join(tmp, 'run'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'run'), 'blocked');
  req('2222222222222222', 'second'); server.pollMailboxes(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.listComments(t.key).length, 2); assert.ok(fs.existsSync(path.join(dir, 'req-2222222222222222.json')));
  server.pollMailboxes(); assert.equal(store.listComments(t.key).length, 2);
  fs.unlinkSync(path.join(tmp, 'run')); server.pollMailboxes();
  assert.ok(fs.existsSync(path.join(dir, 'res-2222222222222222.json'))); assert.equal(store.listComments(t.key).length, 2);
  await task; fs.rmSync(tmp, { recursive: true, force: true });
});
