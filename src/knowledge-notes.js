// Desk-authored notes (#10): when a ticket closes with a merged PR, the desk writes what happened back to KnowledgeHub
// so later seats can find it. ATTRIBUTABLE FACTS ONLY, built deterministically from records the desk owns — the spec and
// acceptance criteria, PR and commit SHAs, the files QA passed, structured QA verdicts and `desk test` records, review
// verdicts, deploy and post-deploy checkpoint results, incident samples — each line naming the record it comes from.
// No seat prose (submission notes, review summaries, replies, lessons, claimed root causes): it is the injection path
// and it is unverified.
//
// Write path: the frozen body is enqueued in the SAME transaction as the qualifying transition (closed with a merged PR;
// a later post-deploy verdict adds a new version). Its URL carries the body's sha256, so a version is immutable and a
// repeat is a no-op. The outbox worker writes through the shared knowledge lane, checks the store BEFORE every attempt
// (doc-status), relies on ingest-text's exact read-back (exit 0 verified, 2 refused, 3 mismatch), records the store's
// target fingerprint, attempts, next retry and verification time, and never blocks a ticket. Missed transitions (the
// write side was off at the time) are reconciled after a restart.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import { clean } from './ops.js';
import { acceptanceOf } from './context.js';
import * as kb from './knowledge.js';

export const FORMAT = 'sigmadesk-ticket-facts/1';
let autoFlush = true; // a new note is written right away (tests drive the worker step by step instead)
export function setAutoFlush(on) { autoFlush = on !== false; }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const json = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const line = (s, n = 300) => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const short = (sha) => (sha ? String(sha).slice(0, 12) : '-');
const SHA = /^[0-9a-f]{7,40}$/;

/** A ticket qualifies once it is done AND its PR merged (done alone — owner tasks, verify checks, epics — does not). */
export function qualifies(key) {
  const t = store.getTicket(key);
  return !!(t && t.status === 'done' && store.mergedEventOf(key));
}

/**
 * The facts note for a ticket, from desk records only: deterministic (same records → same bytes, no clock), redacted.
 * → { title, body } or null when the ticket does not qualify.
 */
export function buildFacts(key) {
  const t = store.getTicket(key);
  const merged = t ? store.mergedEventOf(key) : null;
  if (!t || t.status !== 'done' || !merged) return null;
  const out = [];
  const add = (...l) => out.push(...l);
  const mergedAt = (String(merged.text).match(/at (\S+)$/) || [])[1] || merged.ts;
  const deploys = store.deploysForTicket(key);
  const mergeSha = [...new Set([json(store.kvGet(`deploy:none:${key}`))?.merge_sha, ...deploys.map((d) => d.merge_sha)].filter((s) => SHA.test(String(s || ''))))];
  add(`# Facts: ${key} — ${line(t.title, 200)}`, '',
    `Recorded by SigmaDesk from its own records when ${key} closed with a merged pull request. Attributable facts only: each section names the records it comes from. Seat-written narrative (submission notes, review summaries, replies, lessons, claimed root causes) is not included.`,
    `Format: ${FORMAT} · project ${config.projectId || config.project.name}`, '',
    '## Ticket  [ticket record]',
    `- ${key} · type ${t.type || '-'} · area ${t.area || '-'} · complexity ${t.complexity || '-'} · priority ${t.priority || '-'} · risk ${t.risk || 'unrecorded'}${t.parent_key ? ` · part of ${t.parent_key}` : ''}`,
    `- Closed ${t.done_at || '-'} · pull request ${t.pr_url || '-'} merged ${mergedAt}  [GitHub PR sync event ${merged.id}]`,
    `- QA-passed commit ${t.qa_sha || '-'} · head ${t.head_sha || '-'}${mergeSha.length ? ` · merge commit ${mergeSha.join(', ')}  [merge/deploy record]` : ''}`,
    `- Builder ${t.builder || '-'}${json(t.contributors, []).length ? ` · contributors ${json(t.contributors, []).join(', ')}` : ''}`, '');
  const acc = acceptanceOf(t.description);
  add(`## Specification  [ticket description, sha256 ${sha256(`${t.title}\n${t.description || ''}`).slice(0, 12)}]`,
    acc ? clip(acc, 3000) : clip(t.description || '(no description)', 3000), '');
  const files = json(store.kvGet(`diff-files:${key}`), null);
  add(`## Files changed  [desk diff record at the QA-passed commit ${short(t.qa_sha)}]`);
  if (Array.isArray(files) && files.length) { add(...files.slice(0, 200).map((f) => `- ${line(f, 200)}`)); if (files.length > 200) add(`- …and ${files.length - 200} more`); }
  else add('- not recorded');
  add('');
  const qa = store.qaVerdicts(key);
  add('## QA verdicts  [qa_verdicts]', ...(qa.length ? qa.map((v) => `- #${v.id} ${v.verdict}${v.reason ? ` (${v.reason})` : ''} at ${short(v.sha)} · builder ${v.builder || '-'} on ${v.model || '-'} · run ${v.run_id ?? '-'} · ${v.ts}`) : ['- none recorded']), '');
  const runs = store.runsOfTicket(key);
  const tests = runs.flatMap((r) => json(store.kvGet(`desk-test:${r.id}`), []).map((x) => ({ ...x, run: r })));
  add('## Test runs through desk test  [desk test records]', ...(tests.length ? tests.map((x) => `- run ${x.run.id} (${x.run.kind}, ${x.run.agent_id}): ${line((x.args || []).join(' '), 160)} → exit ${x.status}${x.tests ? ` · ${x.tests.tests} tests, ${x.tests.failures} failed, ${x.tests.errors} errors, ${x.tests.skipped} skipped` : ''} at ${short(x.sha)}${x.problem ? ` · not counted: ${line(x.problem, 120)}` : ''} · ${x.at || '-'}`) : ['- none recorded']), '');
  const reviews = store.listPrReviews(key);
  const findings = store.listFindings(key);
  add('## Review verdicts  [pr_reviews; finding text excluded]', ...(reviews.length ? reviews.map((r) => {
    const f = findings.filter((x) => x.review_id === r.id);
    return `- ${r.role} ${r.seat}: ${r.verdict} (${r.state}) at ${short(r.sha)} · round ${r.round} · run ${r.run_id ?? '-'}${f.length ? ` · ${f.length} finding(s), ${f.filter((x) => x.blocking).length} blocking, resolutions ${[...new Set(f.map((x) => x.resolution))].sort().join('/')}` : ''} · ${r.updated_at}`;
  }) : ['- none recorded']), '');
  const watches = store.watchesForTicket(key);
  add('## Deploys and post-deploy checks  [deploy_history, deploy_watches, watch_checkpoints]');
  if (!deploys.length && !watches.length) add('- none recorded at the time of this note');
  for (const d of deploys) add(`- deploy ${d.workflow} run ${d.run_id} attempt ${d.run_attempt} of ${short(d.merge_sha)} → ${d.status}${d.conclusion ? ` (${d.conclusion})` : ''}${d.target ? ` · target ${d.target}` : ''} · ${d.completed_at || d.started_at || d.recorded_at}`);
  for (const w of watches) {
    const cps = store.checkpointsOf(w.id).map((c) => `${c.name} ${c.verdict || c.status}${c.limited ? ' (limited)' : ''}${c.completed_at ? ` ${c.completed_at}` : ''}`);
    add(`- watch ${w.id} of ${short(w.merge_sha)}: ${w.status}${w.hold ? ' · deploy hold' : ''}${cps.length ? ` · checkpoints: ${cps.join('; ')}` : ''}`);
  }
  add('');
  const incidents = store.listIncidents({ limit: 500 }).filter((i) => i.ticket_key === key).sort((a, b) => a.id - b.id);
  if (incidents.length) {
    add('## Incidents  [incidents; samples are production log lines — untrusted data]');
    for (const i of incidents) {
      add(`- #${i.id} ${line(i.label, 120)} · signature ${line(i.signature, 40)} · seen ${i.count}× · first ${i.first_seen} · last ${i.last_seen} · ${i.status}${i.resolved_at ? ` ${i.resolved_at}` : ''}`);
      for (const s of json(i.samples, []).slice(-3)) add(`  - [${line(s.ts, 40)}] ${line(s.line, 300)}`);
    }
    add('');
  }
  // Redaction over the whole note (ops.js rules), then normalized whitespace: the body is what the hash covers.
  const body = `${clean(out.join('\n')).replace(/[ \t]+$/gm, '').trim()}\n`;
  return { title: line(clean(`SigmaDesk facts: ${key} — ${t.title}`), 200), body };
}
function clip(text, n) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n)}\n[cut: ${t.length - n} more characters]` : t;
}

/** The immutable, content-versioned address of one note. */
export const noteUrl = (key, bodySha) => `kb://sigmadesk/${encodeURIComponent(String(config.projectId || config.project.name || 'desk'))}/ticket/${key}/facts/${bodySha}`;

/**
 * Freeze and enqueue the facts note of a ticket (call it inside the transition's transaction). Never throws: a failure
 * here must not undo or block the transition (reconciliation catches it later). → the outbox row, or null.
 */
export function enqueueTicketFacts(key, { trigger = 'merged' } = {}) {
  try {
    if (config.knowledge?.enabled !== true) return null;
    const ns = kb.writeNamespace();
    if (!ns) return null;
    const facts = buildFacts(key);
    if (!facts) return null;
    const bodySha = sha256(facts.body);
    const row = store.enqueueKnowledgeNote({ ticket_key: key, kind: 'facts', trigger, url: noteUrl(key, bodySha), namespace: ns, title: facts.title, body: facts.body, body_sha256: bodySha, format: FORMAT });
    if (autoFlush && row && !row.attempts && row.status === 'pending') setImmediate(() => { flush().catch(() => {}); });
    return row;
  } catch (err) {
    try { store.logEvent({ kind: 'error', agent_id: 'system', ticket_key: key, text: `past-work note for ${key} was not queued: ${store.redact(err.message).slice(0, 200)} (reconciliation retries)` }); } catch { /* nothing more to do */ }
    return null;
  }
}
/** A post-deploy watch concluded: a new version of the facts (now with its deploy evidence), if the ticket qualifies. */
export function onWatchConcluded(key) { if (key && qualifies(key)) enqueueTicketFacts(key, { trigger: 'post-deploy watch' }); }

/** After a restart: qualifying tickets closed since the write side was first switched on that have no note. */
export function reconcile() {
  if (config.knowledge?.enabled !== true) return 0;
  let since = store.kvGet('knowledge:since');
  if (!since) { since = store.now(); store.kvSet('knowledge:since', since); return 0; }
  let n = 0;
  for (const t of store.ticketsByStatus('done')) {
    if (!t.done_at || t.done_at < since || store.knowledgeNotesFor(t.key).length || !qualifies(t.key)) continue;
    if (store.transaction(() => enqueueTicketFacts(t.key, { trigger: 'reconcile' }))) n += 1;
  }
  return n;
}

// ---------------- the outbox worker ----------------
const backoffMs = (attempts) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
const targetOf = (j) => (j?.target && typeof j.target === 'object' ? j.target : null);
let flushing = null;
/** Write due notes one at a time through the knowledge lane. Coalesced; never throws. */
export function flush({ limit = 5 } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    let n = 0;
    for (const row of store.dueKnowledgeNotes(store.now(), limit)) {
      if (!kb.enabled()) break;
      await attempt(row).catch(() => {});
      n += 1;
    }
    return n;
  })().finally(() => { flushing = null; });
  return flushing;
}
/** One write attempt: look first (doc-status), then ingest-text with exact read-back. */
export async function attempt(row) {
  const op = kb.newOp({ kind: 'write' });
  const deadlineAt = Date.now() + config.knowledge.writeDeadlineSeconds * 1000;
  let held = false;
  const attempts = row.attempts + 1;
  const retry = (why, target = null) => store.updateKnowledgeNote(row.id, attempts >= config.knowledge.maxAttempts
    ? { status: 'failed', attempts, last_error: `${why} (gave up after ${attempts} attempts)`, next_attempt_at: null, ...(target ? { target: JSON.stringify(target) } : {}) }
    : { attempts, last_error: why, next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(), ...(target ? { target: JSON.stringify(target) } : {}) });
  const final = (status, why, target = null) => store.updateKnowledgeNote(row.id, { status, attempts, last_error: why, next_attempt_at: null, ...(target ? { target: JSON.stringify(target) } : {}) });
  try {
    try { await kb.acquire(op, { deadlineAt, priority: 1 }); held = true; } catch (e) { return store.updateKnowledgeNote(row.id, { next_attempt_at: new Date(Date.now() + 60_000).toISOString(), last_error: e.message }); }
    if (op.cancelled || !kb.enabled()) return store.updateKnowledgeNote(row.id, { next_attempt_at: new Date(Date.now() + 60_000).toISOString(), last_error: 'knowledge was switched off' });
    // 1. What does the store hold under this URL? (Before any write, so a retry never duplicates or overwrites.)
    const st = await kb.runCli(op, ['doc-status', '--url', row.url, '--json'], { deadlineAt });
    if (st.reason || st.code !== 0) return retry(`checking the store: ${kb.cliErrorSummary(st)}`);
    const status = json(st.stdout.trim(), null);
    if (!status || typeof status !== 'object') return retry('checking the store: the answer was not JSON');
    const target = targetOf(status);
    if (config.knowledge.fingerprint && target?.fingerprint !== config.knowledge.fingerprint) return final('failed', `the store target changed (fingerprint ${target?.fingerprint || 'none'}, pinned ${config.knowledge.fingerprint}); update knowledge.fingerprint after checking it`, target);
    if (status.exists && status.content_hash !== row.body_sha256) return final('refused', 'the store holds different content under this note\'s URL', target);
    // 2. Write (an already-verified copy is not re-embedded) and verify by exact read-back.
    const r = await kb.runCli(op, ['ingest-text', '--title', row.title, '--url', row.url, '--namespace', row.namespace, '--type', 'markdown', '--json'], { input: row.body, deadlineAt });
    if (r.reason) return retry(`writing: ${kb.cliErrorSummary(r)}`, target);
    const j = json(r.stdout.trim(), null);
    const t2 = targetOf(j) || target;
    if (r.code === 2) return final('refused', `the store refused the note: ${line(kb.cliErrorSummary(r), 200)}`, t2);
    if (r.code === 0 && j?.verified === true && j.url === row.url && j.content_hash === row.body_sha256) {
      store.updateKnowledgeNote(row.id, { status: 'verified', attempts, last_error: null, next_attempt_at: null, verified_at: store.now(), doc_id: String(j.doc_id || '').slice(0, 80) || null, chunk_count: Number.isInteger(j.chunk_count) ? j.chunk_count : null, target: t2 ? JSON.stringify(t2) : null });
      store.logEvent({ kind: 'action', agent_id: 'system', ticket_key: row.ticket_key, text: `wrote past-work note for ${row.ticket_key} (${row.trigger || 'facts'}, verified by exact read-back)` });
      return store.getKnowledgeNote(row.id);
    }
    return retry(r.code === 3 ? `the stored copy did not match (${line(j?.reason || 'read-back mismatch', 120)})` : `writing: ${kb.cliErrorSummary(r)}`, t2);
  } finally {
    if (held) kb.release();
    kb.closeOp(op);
  }
}
/** The owner asks for another try of a failed note. */
export function retryNote(id) {
  const n = store.getKnowledgeNote(Number(id));
  if (!n) throw Object.assign(new Error('no such note'), { status: 404 });
  if (n.status === 'verified') return n;
  const row = store.updateKnowledgeNote(n.id, { status: 'pending', attempts: 0, next_attempt_at: store.now() });
  flush().catch(() => {});
  return row;
}
