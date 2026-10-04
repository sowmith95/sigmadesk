// Run card: what an agent is doing on a ticket, in five honest parts. Pure (no DOM) so it is unit-tested.
//   Plan     — milestones from the latest `plan` event ("2 of 4")
//   Now      — the latest humanized step; an unresolved error replaces it
//   Evidence — QA verdict, tests, PR, files; each marked verified (QA / GitHub) or claimed (the engineer said so)
//   Result   — the last finished run and who acts next
//   Cost     — this run against its reserved cap
// Never a percentage bar: agent-estimated percentages are stripped, not painted.

const STALE_MS = 3 * 60_000;
const PLAN_MARK = { '✓': 'done', '▸': 'now', '·': 'todo' };

/** "45% · reading code" → "Reading code". */
export function humanizeStep(text) {
  let s = String(text || '').replace(/^\s*\d{1,3}\s*%\s*[·:-]?\s*/, '').trim();
  s = s.replace(/^\$\s+/, '').replace(/\s+/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Parse a plan event: lines prefixed ✓ (done) ▸ (in progress) · (pending). Unmarked lines count as pending. */
export function parsePlan(text) {
  const items = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([✓▸·]|\[x\]|\[ \]|-)\s*(.*)$/i);
    const mark = m?.[1] || '';
    const state = PLAN_MARK[mark] || (/^\[x\]$/i.test(mark) ? 'done' : 'todo');
    return { state, text: (m ? m[2] : l).trim() };
  }).filter((i) => i.text);
  if (!items.length) return null;
  return { done: items.filter((i) => i.state === 'done').length, total: items.length, items };
}

/**
 * One plain sentence for an error event. Tool output ("Exit code 1 … Would reformat: a.py …") is summarized;
 * the raw text stays under Execution details.
 */
export function humanizeError(text) {
  const raw = String(text || '');
  const t = raw.replace(/\s+/g, ' ');
  const n = (re) => Number((t.match(re) || [])[1]);
  if (/would reformat/i.test(t)) {
    const files = n(/(\d+) files? would be reformatted/i) || (t.match(/would reformat:/gi) || []).length;
    return `Formatting check failed — ${files} file${files === 1 ? '' : 's'} need${files === 1 ? 's' : ''} formatting`;
  }
  if (/\bFound (\d+) errors?\b/i.test(t)) { const k = n(/Found (\d+) errors?/i); return `Lint check failed — ${k} problem${k === 1 ? '' : 's'}`; }
  if (/\b(\d+) failed\b/i.test(t) && /passed|failed|pytest|tests?/i.test(t)) { const k = n(/(\d+) failed/i); return `Tests failed — ${k} failing`; }
  if (/error TS\d+/i.test(t)) return 'Type check failed';
  if (/No such file or directory/i.test(t)) return 'A command referenced a path that does not exist';
  if (/command not found/i.test(t)) return 'A command is not installed in the workspace';
  if (/timed? ?out/i.test(t)) return 'A command timed out';
  if (/listen EPERM|WebSocket server error.*operation not permitted/i.test(t)) return 'Local preview could not start inside the sandbox';
  if (/permission denied/i.test(t)) return 'A command was denied permission';
  const code = t.match(/^Exit(?: code)?\s+(\d+)\b/i);
  if (code) return `A command exited with code ${code[1]}`;
  return firstLine(raw, 140);
}
/** A non-zero exit from a tool the agent ran: ordinary during work, not a run failure. */
export const isToolExit = (text) => /^\s*Exit(?: code)?\s+\d+\b/i.test(String(text || ''));
const FAILED = new Set(['error', 'failed', 'killed', 'timeout', 'budget']);

const firstLine = (s, n = 180) => {
  const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const ts = (e) => Date.parse(e?.ts || e?.started_at || 0) || 0;
const byId = (a, b) => (a.id || 0) - (b.id || 0) || ts(a) - ts(b);
const stripMd = (s) => String(s || '').replace(/\*\*|`/g, '');

/** Which agent acts next, in plain words. */
export function nextActor(ticket, agents = []) {
  const nm = (id) => agents.find((a) => a.id === id)?.name || null;
  switch (ticket?.status) {
    case 'triage': return 'Support triages it';
    case 'proposed': return 'The manager scopes it';
    case 'todo': return ticket.assignee ? `${nm(ticket.assignee) || 'The engineer'} picks it up` : 'Waiting for a seat';
    case 'in_progress': return `${nm(ticket.assignee) || 'The engineer'} keeps building`;
    case 'qa': return `${nm('qa') || 'QA'} tests it`;
    case 'review': return 'The requester confirms intent';
    case 'needs_human': case 'ready_for_human': return 'You';
    case 'done': return 'Nobody — shipped';
    case 'wontdo': return 'Nobody — closed';
    default: return null;
  }
}

/** Evidence the owner can weigh. source: verified (QA or GitHub said it) | claimed (the engineer said it) | pending. */
export function deriveEvidence({ ticket = {}, comments = [], events = [] } = {}) {
  const out = [];
  const qa = [...comments].filter((c) => c.author === 'qa' && /^(✅|❌)\s*\*\*QA (passed|failed)/.test(c.body || '')).sort(byId).at(-1);
  const head = String(ticket.head_sha || '');
  const sameCommit = (sha) => !sha || !head || head.startsWith(sha) || sha.startsWith(head);
  if (qa) {
    const pass = qa.body.startsWith('✅');
    const sha = qa.body.match(/at `([0-9a-f]{7,40})`/)?.[1];
    const round = qa.body.match(/\(round (\d+)\)/)?.[1];
    const current = sameCommit(sha);
    out.push({ kind: 'qa', label: `QA ${pass ? 'passed' : 'failed'}${current ? '' : ' on an earlier commit'}`, detail: pass ? (sha ? `at ${sha.slice(0, 8)}` : '') : round ? `round ${round}` : '',
      source: current ? 'verified' : 'earlier', tone: current ? (pass ? 'good' : 'bad') : 'neutral' });
    const tests = stripMd(qa.body).match(/(\d[\d,]*)\s+(?:tests?\s+)?passed/i);
    if (tests) out.push({ kind: 'tests', label: `${tests[1]} tests passed`, detail: current ? 'run by QA' : 'earlier commit', source: current ? 'verified' : 'earlier', tone: current ? 'good' : 'neutral' });
    if (!current && !['done', 'wontdo'].includes(ticket.status)) out.unshift({ kind: 'qa-current', label: 'QA pending for the latest commit', detail: head ? `at ${head.slice(0, 8)}` : '', source: 'pending', tone: 'neutral' });
  } else if (!['done', 'wontdo'].includes(ticket.status)) {
    out.push({ kind: 'qa', label: 'QA pending', detail: '', source: 'pending', tone: 'neutral' });
  }
  if (!out.some((e) => e.kind === 'tests' && e.source === 'verified')) {
    const claims = [...events.filter((e) => ['say', 'action'].includes(e.kind) && e.agent_id !== 'qa'), ...comments.filter((c) => c.author !== 'qa' && c.author !== 'owner')]
      .map((x) => stripMd(x.text ?? x.body)).reverse();
    for (const text of claims) {
      const m = text.match(/(\d[\d,]*)\s+(?:tests?\s+)?passed/i);
      if (m) { out.push({ kind: 'tests', label: `${m[1]} tests passed`, detail: 'engineer reported', source: 'claimed', tone: 'neutral' }); break; }
    }
  }
  const accepted = [...comments].filter((c) => /^🤝\s*\*\*Accepted by/.test(c.body || '')).sort(byId).at(-1);
  if (accepted) out.push({ kind: 'acceptance', label: stripMd(accepted.body.split('\n')[0]).replace(/^🤝\s*/, ''), detail: '', source: 'verified', tone: 'good' });
  if (ticket.pr_url) {
    const n = ticket.pr_url.match(/\/pull\/(\d+)/)?.[1];
    out.push({ kind: 'pr', label: n ? `Draft PR #${n}` : 'Draft PR', detail: 'on GitHub', source: 'verified', tone: 'neutral', url: ticket.pr_url });
  }
  const submit = [...comments].filter((c) => /^🚀/.test(c.body || '') || /^Implementation note/i.test(c.body || '')).sort(byId).at(-1);
  const subSha = submit?.body.match(/at `([0-9a-f]{7,40})`/)?.[1] || submit?.body.match(/commit ([0-9a-f]{7,40})/)?.[1];
  const files = new Set();
  for (const m of String(submit?.body || '').matchAll(/[\w.-]+(?:\/[\w.-]+)+\.(?:py|tsx?|jsx?|mjs|css|html|md|sql|ya?ml|json|sh|toml)\b/g)) files.add(m[0]);
  if (files.size) out.push({ kind: 'files', label: `${files.size} file${files.size > 1 ? 's' : ''} changed${sameCommit(subSha) ? '' : ' (earlier commit)'}`, detail: [...files].map((f) => f.split('/').pop()).slice(0, 3).join(', '), source: sameCommit(subSha) ? 'claimed' : 'earlier', tone: 'neutral', files: [...files] });
  return out;
}

/**
 * Build the run card for one ticket.
 * input: { ticket, events (any order; filtered to the ticket), runs, agents, comments, now }
 */
export function runCard({ ticket, events = [], runs = [], agents = [], comments = [], now = Date.now() } = {}) {
  if (!ticket) return null;
  const tEvents = events.filter((e) => e.ticket_key === ticket.key).sort(byId);
  const worker = agents.find((a) => a.current_ticket === ticket.key && a.status === 'working') || null;
  const tRuns = runs.filter((r) => r.ticket_key === ticket.key).sort((a, b) => b.id - a.id);
  // The current run: the seat's live run, else the ticket's active run, else the newest run we know of (from runs or events).
  const newestEventRun = Math.max(0, ...tEvents.map((e) => e.run_id || 0));
  const runId = worker?.current_run || ticket.active_run || Math.max(tRuns[0]?.id || 0, newestEventRun) || null;
  const run = runs.find((r) => r.id === runId) || (runId ? { id: runId, ticket_key: ticket.key, status: worker ? 'running' : 'unknown' } : null);
  const live = Boolean(worker) || run?.status === 'running';
  // Strictly this run: an earlier run's plan, steps or errors never describe the current one.
  const evs = run ? tEvents.filter((e) => e.run_id === run.id) : [];

  const planEv = [...evs].reverse().find((e) => e.kind === 'plan');
  const plan = planEv ? parsePlan(planEv.text) : null;

  const actions = evs.filter((e) => e.kind === 'action' && !/^commented:/i.test(e.text || ''));
  const lastAction = actions.at(-1);
  const lastErr = evs.filter((e) => e.kind === 'error').at(-1);
  // Recovery is explicit: a later step or a finished run. Narration ("fixing the import") does not clear a failure.
  const recovered = lastErr && evs.some((e) => e.id > lastErr.id && ['action', 'done'].includes(e.kind));
  const failedRun = run && FAILED.has(run.status);
  let nowLine = null;
  let issue = null;
  if (failedRun) nowLine = { text: lastErr ? humanizeError(lastErr.text) : `Run ended: ${run.status}`, error: true, at: lastErr?.ts || run.ended_at };
  else if (lastErr && !recovered && !isToolExit(lastErr.text)) nowLine = { text: humanizeError(lastErr.text), error: true, at: lastErr.ts };
  else {
    if (lastErr && !recovered) issue = { text: humanizeError(lastErr.text), at: lastErr.ts }; // ordinary tool exit: a note, not a red error
    if (lastAction) nowLine = { text: humanizeStep(lastAction.text), error: false, at: lastAction.ts };
    else if (live) nowLine = { text: `Starting ${run?.kind || 'work'}`, error: false, at: run?.started_at };
  }

  const newest = evs.at(-1);
  const sinceMs = newest ? now - ts(newest) : run?.started_at ? now - ts(run) : 0;
  const stale = live && sinceMs > STALE_MS ? { minutes: Math.round(sinceMs / 60_000), severe: sinceMs > 15 * 60_000 } : null;

  const says = evs.filter((e) => e.kind === 'say');
  const tools = evs.filter((e) => e.kind === 'tool');
  const done = tEvents.filter((e) => e.kind === 'done').at(-1);
  const lastSay = done ? tEvents.filter((e) => e.kind === 'say' && e.id < done.id && (!done.run_id || e.run_id === done.run_id)).at(-1) : null;
  const result = done && !live ? { text: firstLine(done.text), summary: lastSay ? firstLine(lastSay.text, 280) : '', next: nextActor(ticket, agents), at: done.ts } : null;

  const cost = run && run.reserve_usd != null ? {
    spent: Number(run.cost_usd) || 0, reserve: Number(run.reserve_usd) || 0, estimated: Boolean(run.cost_estimated), running: run.status === 'running',
    label: run.status === 'running' ? `$${(Number(run.reserve_usd) || 0).toFixed(2)} reserved` : `$${(Number(run.cost_usd) || 0).toFixed(2)}${run.cost_estimated ? ' est.' : ''} of $${(Number(run.reserve_usd) || 0).toFixed(2)} cap`,
  } : null;

  return {
    key: ticket.key, live, worker: worker?.id || null, run: run ? { id: run.id, kind: run.kind, model: run.model, status: run.status, started_at: run.started_at } : null,
    plan, now: nowLine, issue, stale,
    evidence: deriveEvidence({ ticket, comments, events: evs }),
    result, cost,
    says: says.slice(-2), sayCount: says.length, allSays: says,
    tools, toolCount: tools.length,
    elapsedMin: run?.started_at ? Math.max(0, Math.round(((run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at)) / 60_000)) : null,
  };
}
