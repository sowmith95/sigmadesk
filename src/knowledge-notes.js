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

export const FORMAT = 'sigmadesk-ticket-facts/1'; // also written literally in the body's Format line
let autoFlush = true; // a new note is written right away (tests drive the worker step by step instead)
export function setAutoFlush(on) { autoFlush = on !== false; }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const json = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
// Every field is redacted WHOLE, then shortened (never inside a token or an open quote): a cut can never hide a secret
// from redaction by removing its tail.
// A field with credential-like text anywhere is withheld whole (never edited); others are redacted, then shortened.
const WITHHELD_FIELD = '[withheld: credential-like text]';
const line = (s, n = 300) => (kb.credentialLike(s) ? WITHHELD_FIELD : kb.safeCut(kb.scrubText(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), n));
const short = (sha) => (sha === WITHHELD_FIELD ? sha : sha ? String(sha).slice(0, 12) : '-');
// Every SOURCE field is checked before anything is formatted: a field with credential-like text becomes the withheld
// marker, whichever record it came from (area, builder, pr_url, verdict labels, test arguments, incident samples …).
const F = (v) => {
  if (typeof v === 'string' || typeof v === 'number') return kb.credentialLike(String(v)) ? WITHHELD_FIELD : v;
  if (v && typeof v === 'object') { let j = ''; try { j = JSON.stringify(v) ?? ''; } catch { return WITHHELD_FIELD; } return kb.credentialLike(j) ? WITHHELD_FIELD : v; }
  return v;
};
/**
 * The final string of one interpolated value, or null when its shape is not allowed. Allowed: string, number, boolean,
 * bigint, null/undefined (empty). Anything else — arrays, objects, Buffers, symbols, functions — is withheld, never
 * stringified into a note.
 */
function interpolated(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return null;
}
/** The one door into a facts body: every value interpolated into it (project identity, ticket and record fields,
 * values the builder derives) is checked, and a credential-like one becomes the withheld marker. */
export const V = (strings, ...vals) => strings.reduce((acc, part, i) => {
  if (i >= vals.length) return acc + part;
  const s = interpolated(vals[i]); // converted to its final string first, then checked
  return acc + part + (s === null || kb.credentialLike(s) ? WITHHELD_FIELD : s);
}, '');
const safe = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(F) : F(v)])) : F(o));
const SHA = /^[0-9a-f]{7,40}$/;

const resolvedIncidents = (key) => store.incidentsOfTicket(key).filter((i) => i.status === 'resolved');
/**
 * A ticket qualifies once it is done AND either its PR merged or closing it resolved a linked incident. Done alone —
 * owner tasks, verify checks, epic roll-ups — does not.
 */
export function qualifies(key) {
  const t = store.getTicket(key);
  return !!(t && t.status === 'done' && (store.mergedEventOf(key) || resolvedIncidents(key).length));
}

/**
 * The facts note for a ticket, from desk records only: deterministic (same records → same bytes, no clock), redacted.
 * → { title, body } or null when the ticket does not qualify.
 */
export function buildFacts(key) {
  if (!store.getTicket(key) || !qualifies(key)) return null;
  const t = safe(store.getTicket(key));
  const merged = safe(store.mergedEventOf(key));
  const out = [];
  const add = (...l) => out.push(...l);
  const mergedAt = merged ? (String(merged.text).match(/at (\S+)$/) || [])[1] || merged.ts : null;
  const deploys = store.deploysForTicket(key).map(safe);
  const mergeSha = [...new Set([F(json(store.kvGet(`deploy:none:${key}`))?.merge_sha), ...deploys.map((d) => d.merge_sha)].filter((s) => SHA.test(String(s || ''))))];
  const contributors = (json(t.contributors, []) || []).map(F);
  add(V`# Facts: ${key} — ${line(t.title, 200)}`, '',
    V`Recorded by SigmaDesk from its own records when ${key} closed ${merged ? 'with a merged pull request' : 'and its incident was resolved'}. Attributable facts only: each section names the records it comes from. Seat-written narrative (submission notes, review summaries, replies, lessons, claimed root causes) is not included.`,
    V`Format: sigmadesk-ticket-facts/1 · project ${config.projectId || config.project.name}`, '', // the literal is FORMAT
    '## Ticket  [ticket record]',
    V`- ${key} · type ${t.type || '-'} · area ${t.area || '-'} · complexity ${t.complexity || '-'} · priority ${t.priority || '-'} · risk ${t.risk || 'unrecorded'}${t.parent_key ? V` · part of ${t.parent_key}` : ''}`,
    V`- Closed ${t.done_at || '-'}${merged ? V` · pull request ${t.pr_url || '-'} merged ${mergedAt}  [GitHub PR sync event ${merged.id}]` : ' · no merged pull request'}`,
    V`- QA-passed commit ${t.qa_sha || '-'} · head ${t.head_sha || '-'}${mergeSha.length ? V` · merge commit ${mergeSha.join(', ')}  [merge/deploy record]` : ''}`,
    V`- Builder ${t.builder || '-'}${contributors.length ? V` · contributors ${contributors.join(', ')}` : ''}`, '');
  // The spec as recorded when the ticket was created — never today's description (seats append to it), never comments.
  const spec = safe(store.getTicketSpec(key));
  if (spec) {
    const acc = acceptanceOf(spec.description);
    add(V`## Specification  [ticket at creation, written by ${line(spec.reporter || 'unknown', 40)} at ${spec.created_at}, sha256 ${sha256(`${spec.title}\n${spec.description}`).slice(0, 12)}]`,
      clip(acc || spec.description || '(no description)', 3000), '');
  } else add('## Specification  [ticket at creation]', '- not recorded (the ticket predates the frozen record)', '');
  const files = (a => (Array.isArray(a) ? a.map(F) : a))(json(store.kvGet(`diff-files:${key}`), null));
  add(V`## Files changed  [desk diff record at the QA-passed commit ${short(t.qa_sha)}]`);
  if (Array.isArray(files) && files.length) { add(...files.slice(0, 200).map((f) => V`- ${line(f, 200)}`)); if (files.length > 200) add(V`- …and ${files.length - 200} more`); }
  else add('- not recorded');
  add('');
  const qa = store.qaVerdicts(key).map(safe);
  add('## QA verdicts  [qa_verdicts]', ...(qa.length ? qa.map((v) => V`- #${v.id} ${v.verdict}${v.reason ? V` (${v.reason})` : ''} at ${short(v.sha)} · builder ${v.builder || '-'} on ${v.model || '-'} · run ${v.run_id ?? '-'} · ${v.ts}`) : ['- none recorded']), '');
  const runs = store.runsOfTicket(key);
  const tests = runs.flatMap((r) => json(store.kvGet(`desk-test:${r.id}`), []).map((x) => ({ ...safe(x), tests: x.tests ? safe(x.tests) : x.tests, run: safe(r) })));
  add('## Test runs through desk test  [desk test records]', ...(tests.length ? tests.map((x) => V`- run ${x.run.id} (${x.run.kind}, ${x.run.agent_id}): ${line((x.args || []).join(' '), 160)} → exit ${x.status}${x.tests ? V` · ${x.tests.tests} tests, ${x.tests.failures} failed, ${x.tests.errors} errors, ${x.tests.skipped} skipped` : ''} at ${short(x.sha)}${x.problem ? V` · not counted: ${line(x.problem, 120)}` : ''} · ${x.at || '-'}`) : ['- none recorded']), '');
  const reviews = store.listPrReviews(key).map(safe);
  const findings = store.listFindings(key).map(safe);
  add('## Review verdicts  [pr_reviews; finding text excluded]', ...(reviews.length ? reviews.map((r) => {
    const f = findings.filter((x) => x.review_id === r.id);
    return V`- ${r.role} ${r.seat}: ${r.verdict} (${r.state}) at ${short(r.sha)} · round ${r.round} · run ${r.run_id ?? '-'}${f.length ? V` · ${f.length} finding(s), ${f.filter((x) => x.blocking).length} blocking, resolutions ${[...new Set(f.map((x) => x.resolution))].sort().join('/')}` : ''} · ${r.updated_at}`;
  }) : ['- none recorded']), '');
  const watches = store.watchesForTicket(key).map(safe);
  add('## Deploys and post-deploy checks  [deploy_history, deploy_watches, watch_checkpoints]');
  if (!deploys.length && !watches.length) add('- none recorded at the time of this note');
  for (const d of deploys) add(V`- deploy ${d.workflow} run ${d.run_id} attempt ${d.run_attempt} of ${short(d.merge_sha)} → ${d.status}${d.conclusion ? V` (${d.conclusion})` : ''}${d.target ? V` · target ${d.target}` : ''} · ${d.completed_at || d.started_at || d.recorded_at}`);
  for (const w of watches) {
    const cps = store.checkpointsOf(w.id).map(safe).map((c) => V`${c.name} ${c.verdict || c.status}${c.limited ? ' (limited)' : ''}${c.completed_at ? V` ${c.completed_at}` : ''}`);
    add(V`- watch ${w.id} of ${short(w.merge_sha)}: ${w.status}${w.hold ? ' · deploy hold' : ''}${cps.length ? V` · checkpoints: ${cps.join('; ')}` : ''}`);
  }
  add('');
  const incidents = store.incidentsOfTicket(key).map(safe);
  if (incidents.length) {
    add('## Incidents  [incidents; samples are production log lines — untrusted data]');
    for (const i of incidents) {
      add(V`- #${i.id} ${line(i.label, 120)} · signature ${line(i.signature, 40)} · seen ${i.count}× · first ${i.first_seen} · last ${i.last_seen} · ${i.status}${i.resolved_at ? V` ${i.resolved_at}` : ''}`);
      for (const s of (json(i.samples, []) || []).slice(-3).map(safe)) add(V`  - [${line(s.ts, 40)}] ${line(s.line, 300)}`);
    }
    add('');
  }
  // Redaction over the whole note (ops.js rules), then normalized whitespace: the body is what the hash covers.
  // Assembly, not a value: every piece above already came through V.
  const body = `${clean(out.join('\n')).replace(/[ \t]+$/gm, '').trim()}\n`;
  return { title: line(clean(V`SigmaDesk facts: ${key} — ${t.title}`), 200), body };
}
function clip(text, n) {
  if (kb.credentialLike(text)) return WITHHELD_FIELD;
  const t = kb.scrubText(String(text ?? '').replace(/\r\n?/g, '\n')).trim(); // redact the whole field first
  if (t.length <= n) return t;
  const at = t.lastIndexOf('\n', n);
  return `${at > 0 ? t.slice(0, at) : kb.safeCut(t, n)}\n[cut: ${t.length - (at > 0 ? at : n)} more characters]`;
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
    if (row) store.clearEnqueueFailure(key);
    return row;
  } catch (err) {
    reportEnqueueFailure(key, err);
    return null;
  }
}
/**
 * The close goes ahead without its note (on purpose); the failure is visible as an event and stays in the outbox health
 * (a durable row per ticket, every one counted) until a later attempt queues the note.
 */
function reportEnqueueFailure(key, err) {
  const why = store.redact(String(err?.message ?? err)).slice(0, 200);
  try {
    store.logEvent({ kind: 'error', agent_id: 'system', ticket_key: key, text: `past-work note for ${key} was not queued: ${why} (reconciliation retries)` });
    store.recordEnqueueFailure(key, why);
  } catch { /* nothing more to do */ }
}
// Every close, whatever path sets the ticket done, runs inside the closing transaction.
store.onTicketDone((key) => { enqueueTicketFacts(key, { trigger: store.mergedEventOf(key) ? 'merged' : 'incident resolved' }); });


/** A post-deploy watch concluded: a new version of the facts (now with its deploy evidence), if the ticket qualifies. */
export function onWatchConcluded(key) { if (key && qualifies(key)) enqueueTicketFacts(key, { trigger: 'post-deploy watch' }); }

/** After a restart: qualifying tickets closed since the write side was first switched on that have no note. */
export function reconcile() {
  if (config.knowledge?.enabled !== true) return 0;
  let since = store.kvGet('knowledge:since');
  if (!since) { since = store.now(); store.kvSet('knowledge:since', since); return 0; }
  // Candidates are chosen by the time of their qualifying transitions (a merge, an incident resolution, a deploy record,
  // a concluded watch), not by when the ticket closed; each is compared by its current fact set, so a later transition
  // while writing was off gets its new version even when an older note exists.
  // Union: qualifying closes since then (whatever the date of the merge they reference) and later evidence transitions.
  const keys = new Set([...store.ticketsByStatus('done').filter((t) => t.done_at && t.done_at >= since).map((t) => t.key), ...store.knowledgeTransitionsSince(since)]);
  let n = 0;
  for (const key of keys) {
    // Each candidate on its own: a malformed record fails that ticket (reported like any failed enqueue), not the pass.
    try {
      const facts = qualifies(key) ? buildFacts(key) : null;
      if (!facts) continue;
      // The current facts are already queued or written: any earlier "not queued" failure for this ticket is resolved.
      if (store.knowledgeNoteByUrl(noteUrl(key, sha256(facts.body)))) { store.clearEnqueueFailure(key); continue; }
      if (store.transaction(() => enqueueTicketFacts(key, { trigger: 'reconcile' }))) n += 1;
    } catch (err) { reportEnqueueFailure(key, err); }
  }
  return n;
}

// ---------------- the outbox worker ----------------
const backoffMs = (attempts) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
const targetOf = (j) => (j?.target && typeof j.target === 'object' ? j.target : null);
/**
 * Every answer must come from the same store target: the fingerprint the first verified note pinned, and the configured
 * pin when there is one. A missing fingerprint counts as a change (fail closed).
 */
export function targetProblem(target) {
  const fp = target?.fingerprint;
  if (!fp) return 'the store reported no target fingerprint';
  const pinned = store.kvGet('knowledge:target');
  if (pinned && fp !== pinned) return `the store target changed (fingerprint ${fp}; the first verified note pinned ${pinned}). Check the collection, embedding model and chunk settings`;
  if (config.knowledge.fingerprint && fp !== config.knowledge.fingerprint) return `the store target does not match knowledge.fingerprint (${fp}, configured ${config.knowledge.fingerprint})`;
  return null;
}
/** The owner checked a changed target and accepts it: the next verified note pins the new one. */
export function resetTarget() { store.kvDelete('knowledge:target'); }
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
    const drift = targetProblem(target);
    if (drift) return final('failed', drift, target);
    if (status.exists && status.content_hash !== row.body_sha256) return final('refused', 'the store holds different content under this note\'s URL', target);
    // 2. Write (an already-verified copy is not re-embedded) and verify by exact read-back.
    const r = await kb.runCli(op, ['ingest-text', '--title', row.title, '--url', row.url, '--namespace', row.namespace, '--type', 'markdown', '--json'], { input: row.body, deadlineAt });
    if (r.reason) return retry(`writing: ${kb.cliErrorSummary(r)}`, target);
    const j = json(r.stdout.trim(), null);
    const t2 = targetOf(j);
    if (r.code === 0 && (targetProblem(t2) || t2.fingerprint !== target.fingerprint)) return final('failed', targetProblem(t2) || `the store target changed during the write (${t2.fingerprint}, checked ${target.fingerprint})`, t2 || target);
    if (r.code === 2) return final('refused', `the store refused the note: ${line(kb.cliErrorSummary(r), 200)}`, t2);
    if (r.code === 0 && j?.verified === true && j.url === row.url && j.content_hash === row.body_sha256) {
      if (!store.kvGet('knowledge:target')) store.kvSet('knowledge:target', t2.fingerprint); // the first verified note pins the target
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
