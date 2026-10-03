// The watch desk: a deterministic log watcher (no LLM) that fingerprints errors, and only wakes the SRE seat
// when a NEW signature crosses a threshold. Sources: Loki, docker logs, or plain files.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as store from './db.js';

const pexec = promisify(execFile);
const W = () => config.watch;
const errorRe = () => new RegExp(W().errorPattern, W().errorPatternCaseInsensitive ? 'im' : 'm');
const ignoreRes = () => (W().ignorePatterns || []).map((p) => new RegExp(p, 'i'));

// ---------------- fingerprinting ----------------
const TS_PREFIX = /^\s*(\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?\]?|\d{2}:\d{2}:\d{2}[.,]?\d*)\s*/;
export function normalize(line) {
  let s = String(line).replace(TS_PREFIX, '');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/\bO:[A-Z]+\d{6}[CP]\d{8}\b/g, '<option>')
    .replace(/(["'])(?:(?!\1).){0,200}\1/g, '<str>')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 240);
}
export function signatureOf(source, line) {
  const norm = normalize(line);
  return { norm, sig: crypto.createHash('sha1').update(`${source}|${norm}`).digest('hex').slice(0, 12) };
}

// ---------------- sources ----------------
const cursors = new Map(); // source key -> cursor
const sourceHealth = new Map(); // source key -> { ok, error, lastPoll, lines }

async function readLoki(src, key) {
  const firstLook = Math.max(W().intervalSeconds * 1000, (W().backfillHours || 0) * 3600_000);
  const since = cursors.get(key) || BigInt(Date.now() - firstLook) * 1_000_000n;
  const url = new URL('/loki/api/v1/query_range', src.url);
  url.searchParams.set('query', src.query);
  url.searchParams.set('start', String(since + 1n));
  url.searchParams.set('end', String(BigInt(Date.now()) * 1_000_000n));
  url.searchParams.set('limit', '2000');
  url.searchParams.set('direction', 'forward');
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`loki HTTP ${res.status}`);
  const j = await res.json();
  const out = [];
  let max = since;
  for (const stream of j.data?.result || []) {
    const label = stream.stream?.[src.labelKey || 'container'] || stream.stream?.job || 'loki';
    for (const [ns, line] of stream.values) {
      const t = BigInt(ns);
      if (t > max) max = t;
      out.push({ label, line, ts: new Date(Number(t / 1_000_000n)).toISOString() });
    }
  }
  cursors.set(key, max);
  return out;
}

async function readDocker(src, key) {
  const since = cursors.get(key) || new Date(Date.now() - W().intervalSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const out = [];
  for (const c of src.containers || []) {
    const { stdout, stderr } = await pexec('docker', ['logs', '--since', since, '--until', now, c], { maxBuffer: 32 << 20, timeout: 30_000 });
    for (const line of `${stdout}\n${stderr}`.split('\n')) if (line.trim()) out.push({ label: c, line, ts: now });
  }
  cursors.set(key, now);
  return out;
}

async function readFile(src, key) {
  const st = fs.statSync(src.path);
  let pos = cursors.get(key) ?? st.size; // start at the end: only new lines
  if (st.size < pos) pos = 0; // rotated
  if (st.size === pos) { cursors.set(key, pos); return []; }
  const fd = fs.openSync(src.path, 'r');
  const len = Math.min(st.size - pos, 8 << 20);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  fs.closeSync(fd);
  cursors.set(key, pos + len);
  const now = new Date().toISOString();
  return buf.toString('utf8').split('\n').filter((l) => l.trim()).map((line) => ({ label: src.label || src.path, line, ts: now }));
}

export async function lokiContext(src, label, isoTs, lines = 60) {
  if (src?.type !== 'loki') return [];
  const t = BigInt(Date.parse(isoTs)) * 1_000_000n;
  const url = new URL('/loki/api/v1/query_range', src.url);
  url.searchParams.set('query', `{${src.labelKey || 'container'}="${label.replace(/"/g, '')}"}`);
  url.searchParams.set('start', String(t - 20_000_000_000n));
  url.searchParams.set('end', String(t + 5_000_000_000n));
  url.searchParams.set('limit', String(lines));
  url.searchParams.set('direction', 'backward');
  try {
    const j = await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json();
    return (j.data?.result || []).flatMap((s) => s.values).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, l]) => l);
  } catch { return []; }
}

// ---------------- tick ----------------
const recent = new Map(); // sig -> [timestamps ms] within window

function bump(sig, at) {
  const win = W().windowMinutes * 60_000;
  const arr = (recent.get(sig) || []).filter((t) => at - t < win);
  arr.push(at);
  recent.set(sig, arr);
  return arr.length;
}
export const windowCount = (sig) => (recent.get(sig) || []).filter((t) => Date.now() - t < W().windowMinutes * 60_000).length;

export async function pollOnce() {
  const errRe = errorRe();
  const ign = ignoreRes();
  const touched = new Set();
  for (const [i, src] of (W().sources || []).entries()) {
    const key = `${i}:${src.type}`;
    const health = { ok: true, error: null, lastPoll: store.now(), lines: 0, type: src.type, project: src.project || config.project.name };
    try {
      const lines = src.type === 'loki' ? await readLoki(src, key) : src.type === 'docker' ? await readDocker(src, key) : await readFile(src, key);
      health.lines = lines.length;
      for (const { label, line, ts } of lines) {
        if (!errRe.test(line) || ign.some((r) => r.test(line))) continue;
        const { norm, sig } = signatureOf(label, line);
        store.recordIncident({ signature: sig, normalized: norm, source_index: i, label, project: src.project || config.project.name, line: store.redact(line).slice(0, 1500), ts });
        bump(sig, Date.parse(ts) || Date.now());
        touched.add(sig);
      }
    } catch (err) {
      health.ok = false;
      health.error = String(err.message).slice(0, 200);
    }
    sourceHealth.set(key, health);
  }
  return touched;
}

export const health = () => [...sourceHealth.values()];

// Decide what deserves attention. Returns { investigate: [incident], page: {incidents}|null, regressions: [incident], foreign: [incident] }
export function triageIncidents() {
  const w = W();
  const fresh = store.listIncidents({ status: 'watching' })
    .filter((inc) => inc.note === 'owner asked for investigation' || windowCount(inc.signature) >= w.newSignatureMinCount
      || (w.chronicMinCount && inc.count >= w.chronicMinCount)
      || (w.criticalPattern && new RegExp(w.criticalPattern, 'i').test(inc.normalized)));
  const regressions = store.listIncidents({ status: 'resolved' })
    .filter((inc) => inc.resolved_at && Date.parse(inc.last_seen) > Date.parse(inc.resolved_at) + w.regressionGraceMinutes * 60_000);
  const foreign = fresh.filter((i) => i.project !== config.project.name);
  const mine = fresh.filter((i) => i.project === config.project.name);
  if (mine.length >= w.stormSignatures) return { investigate: [], page: mine, regressions, foreign };
  return { investigate: mine, page: null, regressions, foreign };
}
