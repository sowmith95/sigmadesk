// Secret values the desk must never publish (PR/issue comments): values from the target repo's .env files and from
// this process's environment whose names look secret. Values are kept in memory only, never logged or stored.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SECRET_NAME = /(SECRET|_KEY|KEY_ID|^KEY$|TOKEN|PASSWORD|PASSWD|_PASS$|_DSN$|^DSN$|PRIVATE|CREDENTIAL|^APCA_|^ALPACA_|^POLYGON_|^MASSIVE_|^IBKR_|WEBHOOK)/i;
const SECRET_LIKE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PIN|ACCOUNT)/i;
let cache = { at: 0, sig: '', values: [] };

function envFiles() {
  const root = config.project?.repoPath;
  if (!root) return [];
  return ['.env', '.env.local', '.env.production'].map((f) => path.join(root, f)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}
export function parseEnv(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push([m[1], v]);
  }
  return out;
}
/** Secret values (≥ 8 chars), longest first so a value containing another is replaced whole. */
export function secretValues() {
  const files = envFiles();
  const sig = files.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return f; } }).join('|') + JSON.stringify(config.project?.env || {}).length;
  if (sig === cache.sig && Date.now() - cache.at < 60_000) return cache.values;
  const vals = new Set();
  // Value-based: every value of 8+ characters in the target repo's .env files and in project.env (the env the desk
  // gives agents) is treated as secret, whatever its name; plain numbers and booleans are skipped.
  // Numeric-only values (PINs, account numbers) count too when the NAME looks secret, from 6 characters.
  const consider = (k, v) => {
    const x = String(v ?? '');
    if (/^(true|false)$/i.test(x)) return;
    if (/^\d+(\.\d+)?$/.test(x)) { if (x.length >= 6 && SECRET_LIKE.test(k)) vals.add(x); return; }
    if (x.length >= 8 || (x.length >= 6 && SECRET_LIKE.test(k))) vals.add(x);
  };
  for (const f of files) {
    try { for (const [k, v] of parseEnv(fs.readFileSync(f, 'utf8'))) consider(k, v); } catch { /* unreadable: skip */ }
  }
  for (const [k, v] of Object.entries(config.project?.env || {})) consider(k, v);
  for (const [k, v] of Object.entries(process.env)) if (SECRET_NAME.test(k) && v && (v.length >= 8 || (v.length >= 6 && SECRET_LIKE.test(k)))) vals.add(v);
  cache = { at: Date.now(), sig, values: [...vals].sort((a, b) => b.length - a.length) };
  return cache.values;
}
export function scrubValues(text, values = secretValues()) {
  let t = String(text ?? '');
  for (const v of values) if (t.includes(v)) t = t.split(v).join('[redacted]');
  return t;
}
