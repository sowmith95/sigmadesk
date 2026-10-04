import * as productReview from './product-review.js';
// PR console: every PR the desk opened, with live GitHub state, and the owner's actions on them
// (approve, ready, merge, close, reviewers, tags). Agents never reach this module: it is called only from owner
// routes on the TCP listener. Merging the base branch may deploy production, so merges are guarded.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as store from './db.js';
import * as refresh from './refresh.js';

const pexec = promisify(execFile);
const repo = () => config.project.githubRepo;
const SYSTEM_LABEL = (name) => name === config.github.label || /^(status|agent):/.test(name) || name === 'owner-approved';
export const TAG_PREFIX = 'tag:';

async function gh(args) {
  const { stdout } = await pexec(config.bins.gh, args, { cwd: config.project.repoPath, timeout: 90_000, maxBuffer: 32 << 20 });
  return stdout.trim();
}
function fail(msg, status = 409) { throw Object.assign(new Error(msg), { status }); }

const FIELDS = ['number', 'title', 'state', 'isDraft', 'url', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
  'headRefName', 'labels', 'reviewDecision', 'reviewRequests', 'latestReviews', 'mergeable', 'statusCheckRollup',
  'additions', 'deletions', 'changedFiles', 'headRefOid', 'baseRefName'].join(',');

export function checksState(rollup = []) {
  if (!rollup.length) return 'none';
  const v = rollup.map((c) => c.conclusion || c.state || c.status);
  if (v.some((x) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(x))) return 'failing';
  if (v.some((x) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', ''].includes(x) || x == null)) return 'pending';
  return 'passing';
}

// Desk PRs carry "[KEY] title" and a SigmaDesk footer; that is how we find them, including ones later detached
// from a ticket (rework clears pr_url).
let cache = { at: 0, rows: [] };
export async function listPrs({ refresh = false } = {}) {
  if (!refresh && Date.now() - cache.at < 30_000) return cache.rows;
  const raw = JSON.parse(await gh(['pr', 'list', '-R', repo(), '--state', 'all', '--limit', '200', '--search', 'SigmaDesk in:body', '--json', FIELDS]));
  const tickets = Object.fromEntries(store.listTickets().map((t) => [t.key, t]));
  const rows = raw.map((p) => {
    const key = p.title.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1] || null;
    const t = key ? tickets[key] : null;
    const labels = (p.labels || []).map((l) => l.name);
    const ownerApproved = labels.includes('owner-approved') || (p.latestReviews || []).some((r) => r.state === 'APPROVED');
    return {
      number: p.number, url: p.url, title: p.title.replace(/^\[[^\]]+\]\s*/, ''), key, ticket_status: t?.status || null,
      seat: t?.assignee || null, requester: t?.reporter || null, epic: t?.parent_key || null, area: t?.area || null, complexity: t?.complexity || null,
      state: p.state, draft: p.isDraft, merged_at: p.mergedAt, closed_at: p.closedAt, created_at: p.createdAt, updated_at: p.updatedAt,
      author: p.author?.login, branch: p.headRefName, mergeable: p.mergeable, review: p.reviewDecision || null, owner_approved: ownerApproved,
      reviewers: (p.reviewRequests || []).map((r) => r.login || r.name || r.slug).filter(Boolean),
      reviews: (p.latestReviews || []).map((r) => ({ who: r.author?.login, state: r.state })),
      checks: checksState(p.statusCheckRollup || []), additions: p.additions, deletions: p.deletions, files: p.changedFiles,
      tags: labels.filter((l) => l.startsWith(TAG_PREFIX)).map((l) => l.slice(TAG_PREFIX.length)),
      labels: labels.filter((l) => !SYSTEM_LABEL(l) && !l.startsWith(TAG_PREFIX)),
    };
  });
  cache = { at: Date.now(), rows };
  return rows;
}

async function pr(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) fail('bad PR number', 400);
  const p = JSON.parse(await gh(['pr', 'view', String(n), '-R', repo(), '--json', `${FIELDS},body`]));
  if (!/SigmaDesk/.test(p.body || '')) fail('not a SigmaDesk PR', 403); // the console only acts on the desk's own PRs
  return p;
}
const bust = () => { cache.at = 0; };
export async function assertRefreshable(number, ticket) {
  const p = await pr(number);
  if (p.state !== 'OPEN' || p.headRefName !== ticket.branch) fail('Refresh requires this ticket’s open PR branch');
  if (p.baseRefName !== config.project.baseBranch) fail('Merge the predecessor first: this stacked PR targets a different base');
}
const note = (p, text) => {
  const key = p.title.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1];
  if (key && store.getTicket(key)) store.addComment(key, 'owner', text);
  store.logEvent({ kind: 'github', agent_id: 'owner', ticket_key: key || null, text: text.replace(/\*\*/g, '').slice(0, 200) });
};

/** Approve on GitHub. GitHub refuses self-approval (desk PRs are opened with the owner's account), so fall back to
 * an approval comment + the `owner-approved` label, and say which one happened. */
export async function approve(number, message = '') {
  const p = await pr(number);
  if (p.state !== 'OPEN') fail(`PR #${p.number} is ${p.state.toLowerCase()}`);
  let mode = 'review';
  try {
    await gh(['pr', 'review', String(p.number), '-R', repo(), '--approve', '--body', message || 'Approved by the owner via SigmaDesk.']);
  } catch (err) {
    if (!/own pull request|Can not approve/i.test(String(err.stderr || err.message))) throw err;
    mode = 'label';
    await gh(['label', 'create', 'owner-approved', '--color', '0e8a16', '--description', 'Approved by the owner in SigmaDesk', '--force', '-R', repo()]);
    await gh(['pr', 'edit', String(p.number), '-R', repo(), '--add-label', 'owner-approved']);
    await gh(['pr', 'comment', String(p.number), '-R', repo(), '--body', `✅ **Approved by the owner** (via SigmaDesk).${message ? `\n\n${message}` : ''}\n\n_GitHub does not allow approving your own PR, so this approval is recorded as a comment and the \`owner-approved\` label._`]);
  }
  note(p, `👍 **Approved on GitHub** (#${p.number}, ${mode === 'review' ? 'review approval' : 'comment + owner-approved label — GitHub blocks self-approval'})`);
  bust();
  return { number: p.number, mode };
}

export async function ready(number) {
  const p = await pr(number);
  if (!p.isDraft) return { number: p.number, already: true };
  await gh(['pr', 'ready', String(p.number), '-R', repo()]);
  note(p, `📤 Marked #${p.number} ready for review.`);
  bust();
  return { number: p.number };
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const OVERRIDE_PHRASE = 'merge during market hours';

/** Preconditions for merging, pure so they are testable. */
export function mergeBlockers(p, { inBusyWindow = false, override = '' } = {}) {
  const out = [];
  if (p.state !== 'OPEN') out.push(`PR is ${String(p.state).toLowerCase()}`);
  if (p.mergeable === 'CONFLICTING') out.push('it conflicts with the base branch — rebase first');
  const checks = checksState(p.statusCheckRollup || []);
  if (checks === 'failing') out.push('CI is failing');
  if (checks === 'pending') out.push('CI is still running');
  if (inBusyWindow && String(override).trim().toLowerCase() !== OVERRIDE_PHRASE) {
    out.push(`merging ${config.project.baseBranch} deploys production and the desk is inside its busy window (market hours) — type "${OVERRIDE_PHRASE}" to override`);
  }
  return out;
}

export async function merge(number, { method = 'squash', override = '', inBusyWindow = false } = {}) {
  if (!MERGE_METHODS.includes(method)) fail(`method must be ${MERGE_METHODS.join('|')}`, 400);
  const p = await pr(number);
  const blockers = mergeBlockers(p, { inBusyWindow, override });
  const key = p.title.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1];
  if (key) {
    const ticket = store.getTicket(key);
    const plan = ticket && productReview.current(ticket.parent_key || key);
    if (plan || productReview.current(key, 'feedback')) {
      const feedback = productReview.current(key, 'feedback');
      if (productReview.blocks(ticket) || !feedback || feedback.stale || feedback.status !== 'approved' || ticket.head_sha !== p.headRefOid) blockers.push('product/design or user feedback approval is missing or stale for this commit');
    }
  }
  if (key && refresh.current(key)) {
    if (p.baseRefName !== config.project.baseBranch) blockers.push('PR base changed since refreshed QA');
    // GraphQL baseRefOid may describe the PR's original base. Read the live branch ref.
    const base = JSON.parse(await gh(['api', `repos/${repo()}/git/ref/heads/${config.project.baseBranch}`])).object.sha;
    blockers.push(...refresh.validationBlockers(key, p.headRefOid, base));
    if (refresh.current(key).status !== 'published') blockers.push('the rebased branch has not been published after QA');
  }
  if (blockers.length) fail(`Not merged: ${blockers.join('; ')}.`);
  if (p.isDraft) await gh(['pr', 'ready', String(p.number), '-R', repo()]);
  // --match-head-commit: GitHub merges exactly the commit whose checks we just read, or refuses if it moved.
  await gh(['pr', 'merge', String(p.number), '-R', repo(), `--${method}`, '--delete-branch', '--match-head-commit', p.headRefOid]);
  note(p, `🔀 **Merged #${p.number}** (${method}) from SigmaDesk${inBusyWindow ? ' — market-hours override' : ''}.`);
  bust();
  return { number: p.number, method };
}

export async function close(number, comment = '') {
  const p = await pr(number);
  if (p.state !== 'OPEN') fail(`PR #${p.number} is already ${p.state.toLowerCase()}`);
  await gh(['pr', 'close', String(p.number), '-R', repo(), ...(comment ? ['--comment', comment] : [])]);
  note(p, `🚫 Closed #${p.number} from SigmaDesk${comment ? `: ${comment}` : ''}.`);
  bust();
  return { number: p.number };
}

export async function addReviewer(number, login) {
  if (!/^[A-Za-z0-9-]{1,39}(\/[A-Za-z0-9._-]+)?$/.test(String(login))) fail('reviewer must be a GitHub login or org/team', 400);
  const p = await pr(number);
  await gh(['pr', 'edit', String(p.number), '-R', repo(), '--add-reviewer', login]);
  note(p, `👥 Requested a review from @${login} on #${p.number}.`);
  bust();
  return { number: p.number, reviewer: login };
}

export async function setTags(number, { add = [], remove = [] } = {}) {
  const clean = (xs) => [...new Set(xs.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9 ._-]{0,40}$/.test(x)))];
  const a = clean(add); const r = clean(remove);
  if (!a.length && !r.length) fail('no valid tags', 400);
  const p = await pr(number);
  for (const t of a) await gh(['label', 'create', `${TAG_PREFIX}${t}`, '--color', 'bfdadc', '--description', 'SigmaDesk tag', '--force', '-R', repo()]);
  await gh(['pr', 'edit', String(p.number), '-R', repo(), ...a.flatMap((t) => ['--add-label', `${TAG_PREFIX}${t}`]), ...r.flatMap((t) => ['--remove-label', `${TAG_PREFIX}${t}`])]);
  bust();
  return { number: p.number, added: a, removed: r };
}
