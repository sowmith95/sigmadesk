import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { agentById } from './team.js';
import * as store from './db.js';
import { removeWorkspace } from './runner.js';

const pexec = promisify(execFile);
const enabled = () => store.getSettings().github_sync === 'true' && Boolean(config.project.githubRepo);
const LABEL = config.github.label;

// All gh calls go through one serial queue: no bursts against the API, ordered side effects.
let queue = Promise.resolve();
function enqueue(label, fn, ticketKey) {
  const p = queue.then(async () => {
    try { return await fn(); } catch (err) {
      store.logEvent({ kind: 'github', ticket_key: ticketKey, agent_id: 'github', text: `${label} failed: ${String(err.stderr || err.message).slice(0, 300)}` });
      return null;
    }
  });
  queue = p.catch(() => {});
  return p;
}

async function gh(args, opts = {}) {
  const { stdout } = await pexec(config.bins.gh, args, { cwd: config.project.repoPath, timeout: 60_000, maxBuffer: 8 << 20, ...opts });
  return stdout.trim();
}

const STATUS_LABELS = {
  todo: 'status:todo', in_progress: 'status:in-progress', qa: 'status:qa', ready_for_human: 'status:ready-for-review',
  needs_human: 'status:needs-human', done: 'status:done', wontdo: 'status:wontdo', proposed: 'status:proposed', triage: 'status:triage',
};
const ROLE_LABEL = (agentId) => (agentId ? `agent:${agentId}` : null);

export async function ensureLabels() {
  if (!enabled()) return;
  const labels = [[LABEL, '5319e7', 'Managed by the SigmaDesk AI engineering desk'],
    ...Object.values(STATUS_LABELS).map((l) => [l, 'ededed', 'SigmaDesk status']),
    ...Object.keys(agentById).map((id) => [`agent:${id}`, 'c5def5', `Assigned to ${agentById[id].role}`])];
  for (const [name, color, desc] of labels) {
    await enqueue('label', () => gh(['label', 'create', name, '--color', color, '--description', desc, '--force', '-R', config.project.githubRepo]));
  }
}

// A parent's issue carries a checklist of its tasks, ticked as they merge.
function checklist(t) {
  const kids = store.childrenOf(t.key);
  return kids.length ? `\n\n### Tasks\n${kids.map((k) => `- [${k.status === 'done' ? 'x' : ' '}] ${k.issue_number ? `#${k.issue_number} ` : ''}[${k.key}] ${k.title}${k.status === 'wontdo' ? ' (not doing)' : ''}`).join('\n')}` : '';
}
function issueBody(t) {
  return `${t.description}${checklist(t)}\n\n<!-- sigmadesk:${t.key} -->\n---\n_SigmaDesk ticket **${t.key}** · area: ${t.area || '-'} · complexity: ${t.complexity || '-'} · priority: ${t.priority} · assignee: ${t.assignee ? agentById[t.assignee]?.role || t.assignee : '-'}_\n_Worked by the SigmaDesk AI engineering desk. Discuss and decide on the desk; this issue mirrors it._`;
}
const MANAGED_START = '<!-- sigmadesk:managed -->', MANAGED_END = '<!-- /sigmadesk:managed -->';
/**
 * Keep a feature's issue body current (plan and task checklist). An issue the desk opened is rewritten whole; an issue a
 * person wrote (imported) keeps their text and gets a marked desk block, replaced in place on later updates.
 */
export function updateIssueBody(ticketKey) {
  if (!enabled()) return null;
  return enqueue('update issue', async () => {
    const t = store.getTicket(ticketKey);
    if (!t?.issue_number) return;
    const current = JSON.parse(await gh(['issue', 'view', String(t.issue_number), '-R', config.project.githubRepo, '--json', 'body'])).body || '';
    let body;
    if (current.includes(`<!-- sigmadesk:${t.key} -->`)) body = issueBody(t);
    else {
      const block = `${MANAGED_START}\n---\n_SigmaDesk keeps this section current. Discuss and decide on the desk._\n\n${t.description}${checklist(t)}\n${MANAGED_END}`;
      const a = current.indexOf(MANAGED_START), b = current.indexOf(MANAGED_END);
      body = a >= 0 && b > a ? `${current.slice(0, a)}${block}${current.slice(b + MANAGED_END.length)}` : `${current}\n\n${block}`;
    }
    if (body.trim() === current.trim()) return;
    await gh(['issue', 'edit', String(t.issue_number), '-R', config.project.githubRepo, '--body', store.sanitizeForGithub(body)]);
  }, ticketKey);
}

export function createIssue(ticketKey) {
  if (!enabled()) return null;
  return enqueue('create issue', async () => {
    const t = store.getTicket(ticketKey);
    if (!t || t.issue_number) return t?.issue_number;
    // Crash-safe dedupe: an earlier attempt may have created the issue before we recorded it.
    // Identity is a hidden body marker (titles can be edited by people).
    const existing = JSON.parse(await gh(['issue', 'list', '-R', config.project.githubRepo, '--state', 'all', '--search', `"sigmadesk:${t.key}" in:body`, '--json', 'number,body', '--limit', '5']))
      .find((i) => (i.body || '').includes(`<!-- sigmadesk:${t.key} -->`));
    if (existing) { store.updateTicket(t.key, { issue_number: existing.number }); return existing.number; }
    const labels = [LABEL, STATUS_LABELS[t.status], ROLE_LABEL(t.assignee)].filter(Boolean);
    const url = await gh(['issue', 'create', '-R', config.project.githubRepo, '--title', `[${t.key}] ${t.title}`, '--body', store.sanitizeForGithub(issueBody(t)), ...labels.flatMap((l) => ['--label', l])]);
    const num = Number(url.match(/\/issues\/(\d+)/)?.[1]);
    if (num) {
      store.updateTicket(t.key, { issue_number: num });
      store.logEvent({ kind: 'github', ticket_key: t.key, agent_id: 'github', text: `opened issue #${num}` });
    }
    return num;
  }, ticketKey);
}

export function syncIssueState(ticketKey) {
  if (!enabled()) return null;
  return enqueue('sync labels', async () => {
    const t = store.getTicket(ticketKey);
    if (!t?.issue_number) return;
    const remove = Object.values(STATUS_LABELS).filter((l) => l !== STATUS_LABELS[t.status]);
    const removeRoles = Object.keys(agentById).filter((id) => id !== t.assignee).map(ROLE_LABEL);
    const args = ['issue', 'edit', String(t.issue_number), '-R', config.project.githubRepo, '--add-label', [STATUS_LABELS[t.status], ROLE_LABEL(t.assignee)].filter(Boolean).join(','),
      '--remove-label', [...remove, ...removeRoles].join(',')];
    await gh(args);
    if (t.status === 'wontdo') await gh(['issue', 'close', String(t.issue_number), '-R', config.project.githubRepo, '--reason', 'not planned']);
  }, ticketKey);
}

export function flushComments() {
  if (!enabled()) return null;
  return enqueue('comments', async () => {
    for (const c of store.unsyncedComments()) {
      const who = agentById[c.author] ? `${agentById[c.author].name} · ${agentById[c.author].role}` : c.author;
      store.markCommentSynced(c.id); // at-most-once: a crash mid-post loses one mirror comment instead of duplicating it
      await gh(['issue', 'comment', String(c.issue_number), '-R', config.project.githubRepo, '--body', store.sanitizeForGithub(`**${who}** · SigmaDesk ${c.ticket_key}\n\n${c.body}`)]);
    }
  });
}

// Two-reviewer PR conversation: a durable outbox. A row is marked sent only after GitHub returned the comment id.
// Each body carries a hidden marker, so a retry after a crash between "posted" and "recorded" adopts the existing
// comment instead of posting a duplicate.
export const OUTBOX_MAX_ATTEMPTS = 8;
export const outboxMarker = (marker) => `<!-- sigmadesk-review:${marker} -->`;
export function flushOutbox() {
  if (!enabled()) return Promise.resolve(0);
  return enqueue('PR review comments', async () => {
    let sent = 0;
    for (const o of store.pendingOutbox()) {
      const n = Number(String(o.pr_url).match(/\/pull\/(\d+)/)?.[1]);
      if (!n) continue;
      const marker = outboxMarker(o.marker);
      const path = `repos/${config.project.githubRepo}/issues/${n}/comments`;
      try {
        let id = '';
        if (o.attempts > 0) {
          const found = await gh(['api', path, '--paginate', '--jq', `.[] | select(.body | contains(${JSON.stringify(marker)})) | .id`]);
          id = found.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
        }
        if (!id) {
          store.updateOutbox(o.id, { attempts: o.attempts + 1 });
          id = (await gh(['api', '-X', 'POST', path, '-f', `body=${store.sanitizeForGithub(o.body)}\n\n${marker}`, '--jq', '.id'])).trim();
        }
        if (!id) throw new Error('GitHub returned no comment id');
        store.transaction(() => {
          store.updateOutbox(o.id, { status: 'sent', gh_comment_id: id, sent_at: store.now(), last_error: null, next_attempt_at: null });
          if (o.review_id) store.updatePrReview(o.review_id, { published_comment_id: id });
        });
        sent += 1;
      } catch (err) {
        const why = String(err.stderr || err.message).slice(0, 300);
        // Every failed try counts, including the duplicate-lookup step, so a broken lookup also backs off and escalates.
        const tries = Math.max(store.listOutbox(o.ticket_key).find((x) => x.id === o.id)?.attempts || 0, o.attempts + 1);
        store.updateOutbox(o.id, { attempts: tries });
        if (tries >= OUTBOX_MAX_ATTEMPTS) {
          store.updateOutbox(o.id, { status: 'dead', last_error: why });
          store.addComment(o.ticket_key, 'system', `🚨 A review comment could not be posted to the PR after ${tries} tries (${why.slice(0, 160)}). Merging stays blocked until it is on the PR; reply here to retry, or merge with an override reason.`);
          store.logEvent({ kind: 'error', ticket_key: o.ticket_key, agent_id: 'github', text: `PR comment gave up after ${tries} tries: ${why.slice(0, 200)}` });
        } else {
          const waitMin = Math.min(60, 2 ** Math.max(0, tries - 1));
          store.updateOutbox(o.id, { status: 'failed', last_error: why, next_attempt_at: new Date(Date.now() + waitMin * 60_000).toISOString() });
          store.logEvent({ kind: 'github', ticket_key: o.ticket_key, agent_id: 'github', text: `PR comment not posted yet (retry in ${waitMin} min): ${why.slice(0, 200)}` });
        }
      }
    }
    return sent;
  });
}

export function openDraftPr(ticketKey, summary, { base = config.project.baseBranch } = {}) {
  return enqueue('open PR', async () => {
    const t = store.getTicket(ticketKey);
    if (!t?.branch || t.pr_url) return t?.pr_url;
    const open = JSON.parse(await gh(['pr', 'list', '-R', config.project.githubRepo, '--head', t.branch, '--state', 'all', '--json', 'url', '--limit', '1']));
    if (open[0]?.url) { store.updateTicket(t.key, { pr_url: open[0].url }); return open[0].url; }
    const body = `${summary}\n\n${t.issue_number ? `Closes #${t.issue_number}\n\n` : ''}---\nBuilt by **${agentById[t.assignee]?.name || 'SigmaDesk'} (${agentById[t.assignee]?.role || 'engineer'})**, independently checked by QA at \`${String(t.head_sha || '').slice(0, 10)}\`. ${Number(config.review.required) > 0 ? 'Two desk reviewers review it next; their comments appear below.' : 'Needs human review before merge.'}\n\n_Opened by [SigmaDesk](https://github.com/${config.project.githubOwner})._`;
    const draft = store.getSettings().draft_prs === 'true';
    const url = await gh(['pr', 'create', '-R', config.project.githubRepo, ...(draft ? ['--draft'] : []), '--base', base, '--head', t.branch, '--title', `[${t.key}] ${t.title}`, '--body', store.sanitizeForGithub(body)]);
    store.updateTicket(t.key, { pr_url: url.split('\n').pop() });
    store.logEvent({ kind: 'github', ticket_key: t.key, agent_id: 'github', text: `opened ${draft ? 'draft ' : ''}PR ${url}` });
    return url;
  }, ticketKey);
}

// Import trusted-author issues carrying the desk label; detect merged/closed PRs.
export function poll(onNewIssue) {
  if (!enabled()) return null;
  return enqueue('poll', async () => {
    const known = new Set(store.listTickets().map((t) => t.issue_number).filter(Boolean));
    const issues = JSON.parse(await gh(['issue', 'list', '-R', config.project.githubRepo, '--label', LABEL, '--state', 'open', '--limit', '50', '--json', 'number,title,body,author']));
    for (const i of issues) {
      if (known.has(i.number) || /^\[[A-Z]+-\d+\]/.test(i.title)) continue;
      if (!config.github.trustedAuthors.includes(i.author?.login)) continue; // only trusted authors feed the desk (prompt-injection guard)
      onNewIssue(i);
    }
    // PR state (merges, closes, reviews, checks) is reconciled by prsync.js every minute.
  });
}
