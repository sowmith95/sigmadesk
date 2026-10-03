// PR reconciliation: one GraphQL round-trip per cycle for every PR the desk opened, turned into desk transitions.
// Polling is the source of truth; the optional webhook listener only asks for an immediate cycle (payloads are never
// trusted, so a forged or replayed webhook can at most cause an extra poll).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as store from './db.js';

const pexec = promisify(execFile);
const enabled = () => store.getSettings().github_sync === 'true' && Boolean(config.project.githubRepo);
const [OWNER, REPO] = (config.project.githubRepo || '/').split('/');
const TERMINAL = new Set(['done', 'wontdo']);
const seen = (k) => store.kvGet(`prsync:${k}`) === '1';
const mark = (k) => store.kvSet(`prsync:${k}`, '1');

const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
const trusted = (login) => (config.github.trustedAuthors || []).includes(login);
// Comments the desk itself wrote (issue mirrors, PR bodies) must never loop back in as owner input.
const isDeskText = (body) => /SigmaDesk|<!-- sigmadesk:/.test(String(body || ''));

export function trackedTickets() {
  return store.listTickets().filter((t) => t.pr_url && !TERMINAL.has(t.status) && prNumber(t.pr_url));
}

export function buildQuery(numbers) {
  const fields = `number state isDraft merged mergedAt closedAt headRefOid mergeable reviewDecision url
    reviews(last: 20) { nodes { id state body submittedAt author { login } comments(first: 30) { nodes { body path line } } } }
    comments(last: 30) { nodes { id body createdAt author { login } } }
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 40) { nodes {
      ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }`;
  return `query { repository(owner: ${JSON.stringify(OWNER)}, name: ${JSON.stringify(REPO)}) {
    ${numbers.map((n) => `pr${n}: pullRequest(number: ${Number(n)}) { ${fields} }`).join('\n')} } }`;
}

async function fetchPrs(numbers) {
  const { stdout } = await pexec(config.bins.gh, ['api', 'graphql', '-f', `query=${buildQuery(numbers)}`],
    { cwd: config.project.repoPath, timeout: 60_000, maxBuffer: 16 << 20 });
  const repo = JSON.parse(stdout).data?.repository || {};
  return Object.values(repo).filter(Boolean);
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * Decide transitions for one PR snapshot. Pure apart from the seen() ledger, so it is unit-testable.
 * Returns a list of actions: {type: merged|closed|changes|approved|comment|checks_failed|conflict}.
 */
export function planActions(t, pr) {
  const out = [];
  if (pr.merged || pr.state === 'MERGED') return [{ type: 'merged', at: pr.mergedAt }];
  if (pr.state === 'CLOSED') return [{ type: 'closed', at: pr.closedAt }];
  for (const r of pr.reviews?.nodes || []) {
    if (!trusted(r.author?.login) || seen(`review:${r.id}`)) continue;
    if (r.state === 'CHANGES_REQUESTED') {
      const inline = (r.comments?.nodes || []).map((c, i) => `${i + 1}. ${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`).join('\n');
      out.push({ type: 'changes', key: `review:${r.id}`, id: r.id, who: r.author.login, text: [r.body, inline].filter(Boolean).join('\n\n') || '(no comment)' });
    } else if (r.state === 'APPROVED') {
      out.push({ type: 'approved', key: `review:${r.id}`, id: r.id, who: r.author.login, text: r.body || '' });
    } else if (r.state === 'COMMENTED' && (r.body || r.comments?.nodes?.length) && !isDeskText(r.body)) {
      const inline = (r.comments?.nodes || []).map((c) => `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`).join('\n');
      out.push({ type: 'comment', key: `review:${r.id}`, id: r.id, who: r.author.login, text: [r.body, inline].filter(Boolean).join('\n') });
    }
  }
  for (const c of pr.comments?.nodes || []) {
    if (!trusted(c.author?.login) || seen(`comment:${c.id}`) || isDeskText(c.body)) continue;
    out.push({ type: 'comment', key: `comment:${c.id}`, id: c.id, who: c.author.login, text: c.body });
  }
  const commit = pr.commits?.nodes?.[0]?.commit;
  const ctx = commit?.statusCheckRollup?.contexts?.nodes || [];
  const failed = ctx.filter((c) => FAILED.has(c.conclusion || c.state)).map((c) => c.name || c.context);
  if (failed.length && commit && !seen(`checks:${commit.oid}`)) out.push({ type: 'checks_failed', key: `checks:${commit.oid}`, id: commit.oid, names: failed.join(', ') });
  if (pr.mergeable === 'CONFLICTING' && !seen(`conflict:${pr.headRefOid}`)) out.push({ type: 'conflict', key: `conflict:${pr.headRefOid}`, id: pr.headRefOid });
  return out;
}

// "Landed elsewhere": main already contains exactly what this PR changes (e.g. a stacked slice merged first).
// Checked in the desk-owned publisher repo; never in an agent clone.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external='];
export async function landedElsewhere(t) {
  const pub = path.join(config.root, 'data', 'publisher.git');
  const ref = `refs/sigmadesk/${t.key}`;
  const git = (args) => pexec('git', [...SAFE, '-C', pub, ...args], { timeout: 120_000, maxBuffer: 16 << 20 });
  try {
    await git(['rev-parse', '--verify', ref]);
    const { stdout: url } = await pexec('git', ['-C', config.project.repoPath, 'remote', 'get-url', 'origin']);
    await git(['fetch', '-q', '--no-tags', url.trim(), `+refs/heads/${config.project.baseBranch}:refs/sigmadesk/main-now`]);
    const { stdout: names } = await git(['diff', '--no-ext-diff', '--name-only', `refs/sigmadesk/main-now...${ref}`]);
    const files = names.split('\n').filter(Boolean);
    if (!files.length) return true; // nothing left to merge
    await git(['diff', '--no-ext-diff', '--quiet', 'refs/sigmadesk/main-now', ref, '--', ...files]);
    return true; // exit 0: main has identical content for every file this PR touches
  } catch {
    return false;
  }
}

/** One reconcile cycle. `act` holds the scheduler callbacks that perform transitions. */
let running = null;
export function reconcile(act) {
  if (!enabled()) return Promise.resolve(null);
  if (running) return running; // coalesce bursts (webhook + timer)
  running = (async () => {
    const tickets = trackedTickets();
    if (!tickets.length) return 0;
    const byNumber = new Map(tickets.map((t) => [prNumber(t.pr_url), t]));
    let prs;
    try {
      prs = await fetchPrs([...byNumber.keys()]);
    } catch (err) {
      store.logEvent({ kind: 'github', agent_id: 'github', text: `PR sync failed: ${String(err.stderr || err.message).slice(0, 200)}` });
      return null;
    }
    store.kvSet('prsync:last_ok', store.now());
    let n = 0;
    for (const pr of prs) {
      const t = store.getTicket(byNumber.get(pr.number)?.key);
      if (!t || TERMINAL.has(t.status)) continue;
      for (const a of planActions(t, pr)) {
        n += 1;
        try {
          if (a.key) mark(a.key); // at-most-once: a crash mid-action never replays it
          await act[a.type]?.(t, a, pr);
        } catch (err) {
          store.logEvent({ kind: 'error', ticket_key: t.key, agent_id: 'github', text: `PR sync ${a.type} failed: ${err.message}` });
        }
        if (['merged', 'closed', 'changes', 'checks_failed'].includes(a.type)) break; // ticket moved; re-evaluate next cycle
      }
      const fresh = store.getTicket(t.key);
      if (pr.state === 'OPEN' && fresh.status === 'ready_for_human' && act.landed && (await landedElsewhere(fresh))) {
        n += 1;
        await act.landed(fresh, pr);
      }
    }
    return n;
  })().finally(() => { running = null; });
  return running;
}

// ---------------- settings (defaults live here; override under "github" in sigmadesk.config.json) ----------------
// github.prPollSeconds (default 60) and github.webhook = { port, host, path, secret }. The webhook runs on its OWN
// port (never the owner UI); expose only this listener publicly, e.g.
//   tailscale funnel --bg --set-path /github/webhook http://127.0.0.1:<port>/github/webhook
export const pollSeconds = () => Number(config.github.prPollSeconds) || 60;
const webhookConfig = () => ({ port: 0, host: '127.0.0.1', path: '/github/webhook', secret: '', ...(config.github.webhook || {}) });

// ---------------- optional webhook listener (its own port; never the owner UI) ----------------
export function verifySignature(secret, raw, header) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const WEBHOOK_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment',
  'check_suite', 'check_run', 'status', 'ping']);

export function startWebhook(onPoke) {
  const w = webhookConfig();
  if (!w.port) return null;
  if (!w.secret) {
    console.error('github.webhook.port is set but github.webhook.secret is empty — webhook listener NOT started');
    return null;
  }
  let timer = null;
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== (w.path || '/github/webhook')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(w.secret, raw, req.headers['x-hub-signature-256'])) { res.writeHead(401).end(); return; }
      const event = String(req.headers['x-github-event'] || '');
      res.writeHead(202).end();
      if (!WEBHOOK_EVENTS.has(event) || event === 'ping') return;
      clearTimeout(timer);
      timer = setTimeout(() => onPoke(event), 3000); // debounce bursts (review + comments + checks)
    });
  });
  srv.on('error', (err) => console.error(`webhook listener: ${err.message}`));
  srv.listen(w.port, w.host || '127.0.0.1', () => console.log(`GitHub webhook listener on http://${w.host || '127.0.0.1'}:${w.port}${w.path || '/github/webhook'}`));
  return srv;
}

export async function closePr(pr, comment) {
  await pexec(config.bins.gh, ['pr', 'close', String(pr.number), '-R', config.project.githubRepo, '--comment', comment],
    { cwd: config.project.repoPath, timeout: 60_000 });
}

// Stacked work: if the approved commit contains another open desk PR's unmerged commits, the new PR should target
// that PR's branch (so it shows only its own changes) instead of duplicating them against the base branch.
export async function stackBaseFor(t) {
  if (!t?.head_sha) return null;
  const pub = path.join(config.root, 'data', 'publisher.git');
  const git = (args) => pexec('git', [...SAFE, '-C', pub, ...args], { timeout: 60_000 });
  const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
  const candidates = store.listTickets().filter((u) => u.key !== t.key && u.head_sha && u.branch && u.pr_url && !TERMINAL.has(u.status));
  for (const u of candidates) {
    if (!(await isAncestor(u.head_sha, t.head_sha))) continue;
    if (await isAncestor(u.head_sha, 'refs/sigmadesk/base')) continue; // already merged into base
    return { key: u.key, branch: u.branch, pr: prNumber(u.pr_url) };
  }
  return null;
}
