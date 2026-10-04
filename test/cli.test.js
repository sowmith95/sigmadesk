import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('subcommand help exits without reading silent stdin or writing a desk request', async () => {
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-help-'));
  try {
    for (const args of [['submit', '--help'], ['qa', 'pass', '-h'], ['needs-human', '--help']]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/desk', import.meta.url)), ...args], {
          env: { ...process.env, DESK_RUN_TOKEN: 'fixture-token', DESK_MAILBOX: mailbox },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = ''; let error = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { error += chunk; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error('help waited for stdin or a response')); }, 1000);
        child.on('error', (e) => { clearTimeout(timeout); reject(e); });
        child.on('close', (code) => { clearTimeout(timeout); resolve({ code, output, error }); });
        // Leave stdin open and silent, as a running engineer would.
      });
      assert.equal(result.code, 0, result.error);
      assert.match(result.output, /^usage:/);
      assert.deepEqual(fs.readdirSync(mailbox), [], 'help must never reach the desk transport');
    }
  } finally { fs.rmSync(mailbox, { recursive: true, force: true }); }
});

test('desk review/respond parse verdicts, findings files and finding answers into the request body', async () => {
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-review-cli-'));
  const findings = path.join(mailbox, 'findings.json');
  fs.writeFileSync(findings, '[{"file":"a.py","line":3,"problem":"p","blocking":true}]');
  const call = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/desk', import.meta.url)), ...args], {
      cwd: mailbox, env: { ...process.env, DESK_RUN_TOKEN: 'fixture-token', DESK_MAILBOX: mailbox }, stdio: ['ignore', 'pipe', 'pipe'] });
    const poll = setInterval(() => {
      const req = fs.readdirSync(mailbox).find((f) => /^req-.*\.json$/.test(f));
      if (!req) return;
      clearInterval(poll);
      const body = JSON.parse(fs.readFileSync(path.join(mailbox, req), 'utf8'));
      fs.unlinkSync(path.join(mailbox, req));
      fs.writeFileSync(path.join(mailbox, req.replace('req-', 'res-')), JSON.stringify({ ok: true, output: 'ok' }));
      child.on('close', () => resolve(body));
    }, 20);
    setTimeout(() => { clearInterval(poll); child.kill(); reject(new Error('no request')); }, 5000);
  });
  try {
    const r = await call(['review', 'changes', '--code', 'abc', '--findings', '@findings.json', 'Two', 'issues']);
    assert.equal(r.cmd, 'review');
    assert.deepEqual({ verdict: r.body.verdict, code: r.body.code, body: r.body.body }, { verdict: 'changes', code: 'abc', body: 'Two issues' });
    assert.equal(JSON.parse(r.body.findings)[0].file, 'a.py');
    const a = await call(['respond', 'pushback', '--finding', 'R1-1', 'Out', 'of', 'scope']);
    assert.deepEqual({ cmd: a.cmd, action: a.body.action, finding: a.body.finding, body: a.body.body }, { cmd: 'respond', action: 'pushback', finding: 'R1-1', body: 'Out of scope' });
  } finally { fs.rmSync(mailbox, { recursive: true, force: true }); }
});
