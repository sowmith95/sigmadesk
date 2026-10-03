// The daemon and CLI seats do not depend on desktop accessibility or an unlocked screen.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import * as store from './db.js';

let assertion = null;
let error = null;
export function start() {
  if (!config.server.preventIdleSleep || process.platform !== 'darwin') return;
  if (!fs.existsSync('/usr/bin/caffeinate')) { error = 'caffeinate unavailable'; return; }
  assertion = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  assertion.on('error', (err) => { error = err.message; assertion = null; });
  assertion.on('exit', () => { assertion = null; });
  store.logEvent({ kind: 'system', text: 'Background execution enabled; idle system sleep inhibited while the desk runs. Screen locking remains available.' });
}
export function status() {
  return { screen_lock_supported: true, idle_sleep_inhibited: !!assertion?.pid, error,
    desktop_reviews: 'Desktop model selection requires an unlocked session. API reviews and CLI seats run in the background.',
    limits: 'Closing the lid, forced sleep, shutdown, network loss, and provider limits can interrupt work; restart recovery preserves the queue.' };
}
