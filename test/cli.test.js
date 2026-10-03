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
