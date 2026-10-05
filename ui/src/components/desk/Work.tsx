// Pieces about work in flight, shared by Inbox, Work, the ticket panel and the command palette.
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { runCard } from '../../../../public/runcard.js';
import { humanReason } from '../../../../public/attention.js';
import { safeGithubUrl } from '../../../../public/prs-model.js';
import { S, api, agentMap, openTicket, openSheet, prFor, setOpen, openFeature, loadSnapshot } from '@/store.js';
import { mergeEvents } from '@/lib/sync.js';
import { clean, money, mins, hhmm, prNumber } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { AsyncButton } from './AsyncButton';
import { Named, Tag, SeatAvatar, type Tone } from './Bits';
import { cn } from '@/lib/utils';
import type { BoardItem, Ticket, Comment } from '@/types';

export const STAGE_LABEL: Record<string, string> = { triage: 'Intake', proposed: 'Proposed', todo: 'To do', in_progress: 'Building', qa: 'QA', review: 'Acceptance', needs_human: 'Needs you', ready_for_human: 'Ready for review', done: 'Shipped', wontdo: 'Closed' };
export const KIND_LABEL: Record<string, string> = { product: 'Product review', question: 'Question', guard: 'Publish guard', merge: 'Ready to merge', publish: 'Ready to publish', design: 'Design decision', council: 'Council verdict', page: 'Production errors', research: 'Research proposal', plan: 'Feature plan', owner_task: 'Your task', epic_review: 'Epic review',
  deploy: 'Deploy check', conflict: 'Conflict', setup: 'Setup', refresh: 'Branch', stuck: 'Stuck' };
export const BUCKET_LABEL: Record<string, string> = { needs_you: 'Needs you', blocked: 'Blocked', working: 'Working', queued: 'Queued', shipped: 'Shipped', closed: 'Closed', epic: 'Epic' };
export const BUCKET_TONE: Record<string, Tone> = { needs_you: 'needs', blocked: 'blocked', shipped: 'shipped' };
export const firstName = (id?: string | null) => ((id && agentMap()[id]?.name) || '').split(/\s+/)[0] || 'The engineer';
export const reasonText = (r?: string) => humanReason(clean(r), S.tickets);

/** <details> whose open state survives live re-renders and remounts. */
export function Disclose({ id, summary, children, defaultOpen = false, className }: { id: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, set] = useState<boolean>(S.open[id] ?? defaultOpen);
  return (
    <details open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; set(o); setOpen(id, o); }} className={cn('group', className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 font-medium text-muted-foreground hover:text-foreground max-md:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />{summary}
      </summary>
      <div className="grid gap-2 pt-1">{children}</div>
    </details>
  );
}

/** Long text: the first ~n characters, then "Show all". */
export function Clamp({ id, text, n = 300 }: { id: string; text: string; n?: number }) {
  const [open, set] = useState<boolean>(!!S.open[id]);
  if (text.length <= n + 40 || open) return <p className="whitespace-pre-line [overflow-wrap:anywhere]"><Named text={text} /></p>;
  return <p className="whitespace-pre-line [overflow-wrap:anywhere]"><Named text={`${text.slice(0, n).replace(/\s+\S*$/, '')}…`} />{' '}
    <button type="button" className="text-primary hover:underline" onClick={() => { set(true); setOpen(id, true); }}>Show all</button></p>;
}

export function cardFor(t: Ticket, comments?: Comment[]) {
  const d = S.detail;
  const events = d && d.key === t.key && d.data ? mergeEvents(S.events, d.data.events) : S.events;
  return runCard({ ticket: t, events, runs: S.runs, agents: S.agents, comments: comments || [] });
}
type Card = ReturnType<typeof runCard>;

export function NowLine({ card, compact = false }: { card: Card | null; compact?: boolean }) {
  if (!card) return null;
  const text = compact && card.now && card.now.text.length > 110 ? `${card.now.text.slice(0, 109)}…` : card.now?.text;
  const [provider, ...model] = String(card.run?.model || '').split(':');
  const bits = compact ? [card.plan ? `Plan ${card.plan.done} of ${card.plan.total}` : null, card.elapsedMin != null && card.live ? `${mins(card.elapsedMin)} elapsed` : null,
    card.cost ? (card.cost.running ? `${money(card.cost.reserve)} cap reserved` : card.cost.label) : null].filter(Boolean) : [];
  return (
    <div className="grid gap-1">
      {card.now && <p className={cn('[overflow-wrap:anywhere]', card.now.error && 'text-blocked')} title={card.now.text}>{card.now.error && <b>Failed: </b>}<Named text={text} /></p>}
      {card.issue && <p className="text-sm text-muted-foreground"><span className="text-foreground">Last check: </span>{card.issue.text}</p>}
      {card.stale && <p className={cn('text-sm', card.stale.severe ? 'text-blocked' : 'text-needs')}>No update for {card.stale.minutes} min</p>}
      {compact && card.live && card.run?.model && <p className="text-[13px] text-muted-foreground">Running on {({ codex: 'Codex', claude: 'Claude', perplexity: 'Perplexity' } as Record<string, string>)[provider] || provider}{model.length ? `, ${model.join(':')}` : ''}</p>}
      {bits.length > 0 && <p className="font-mono text-[13px] text-muted-foreground">{bits.join('  ·  ')}</p>}
    </div>
  );
}

export function EvidenceList({ ev }: { ev?: Array<{ label: string; detail?: string; url?: string; tone?: string; source: string; kind?: string }> }) {
  if (!ev?.length) return <p className="text-muted-foreground">No evidence posted yet.</p>;
  const src: Record<string, string> = { verified: 'Verified', claimed: 'Engineer says', pending: 'Pending', earlier: 'Earlier commit' };
  return (
    <ul className="grid gap-1.5">
      {ev.map((e, i) => {
        const href = e.url ? safeGithubUrl(e.url) : null;
        return <li key={i} className="flex items-baseline justify-between gap-3 max-md:flex-wrap">
          <span className={cn('min-w-0 [overflow-wrap:anywhere]', e.tone === 'good' && 'text-shipped', e.tone === 'bad' && 'text-blocked')}>{href ? <a className="text-primary hover:underline" href={href} target="_blank" rel="noopener noreferrer">{e.label}</a> : e.label}{e.detail && <span className="text-sm text-muted-foreground"> {e.detail}</span>}</span>
          <span className={cn('shrink-0 text-[13px] text-muted-foreground', e.source === 'verified' && 'text-shipped')}>{src[e.source] || e.source}</span></li>;
      })}
    </ul>
  );
}

export function CiTag({ t }: { t: Ticket }) {
  const pr = prFor(t);
  if (!pr) return <Tag>{S.prsLoading ? 'CI loading' : 'CI unknown'}</Tag>;
  const tone = ({ passing: 'shipped', failing: 'blocked', pending: 'needs' } as Record<string, Tone>)[pr.checks] || 'neutral';
  return <><Tag tone={tone}>CI {pr.checks === 'none' ? 'not run' : pr.checks}</Tag>{pr.mergeable === 'CONFLICTING' && <Tag tone="blocked">Conflicts</Tag>}</>;
}

export const prReviewsOf = (t: Ticket, d?: Record<string, unknown> | null) => (d?.pr_reviews || (d?.ticket as Ticket | undefined)?.pr_reviews || t?.pr_reviews || null) as unknown;
const VERDICT = (v?: string): [string, string, Tone] => (/approv|pass|lgtm/i.test(v || '') ? ['✓', 'approved', 'shipped'] : /chang|fail|reject|request|block/i.test(v || '') ? ['✎', 'changes requested', 'needs'] : ['…', 'pending', 'neutral']);
type Reviewer = { seat?: string; name?: string; role?: string; context?: string; verdict?: string; state?: string; status?: string; sha?: string; round?: number; findings?: unknown };
/** Why reviewers who are "pending" are not reviewing yet (they review a pull request, and only while the ticket is in review). */
export function reviewHold(t?: Ticket | null): string | null {
  if (!t || t.status === 'review') return null;
  if (t.status === 'needs_human' && /publish guard/i.test(String(t.progress_msg || ''))) return 'They start after you approve publication: they review the pull request, which opens only once the branch is pushed.';
  if (t.status === 'needs_human') return 'They continue after you answer: the ticket is waiting for you.';
  return null;
}
export function Reviews({ raw, compact = false, t }: { raw: unknown; compact?: boolean; t?: Ticket | null }) {
  let rv: unknown = raw;
  if (typeof rv === 'string') { try { rv = JSON.parse(rv); } catch { return null; } }
  if (!rv || typeof rv !== 'object') return null;
  const o = rv as { reviewers?: Reviewer[]; reviews?: Reviewer[]; round?: number; auto_merge?: unknown; auto_merge_status?: string };
  const list: Reviewer[] = Array.isArray(rv) ? rv : Array.isArray(o.reviewers) ? o.reviewers : Array.isArray(o.reviews) ? o.reviews : [];
  if (!list.length) return null;
  const amap = agentMap();
  const who = (x: Reviewer) => (x.seat && amap[x.seat]?.name) || x.name || x.seat || 'Reviewer';
  const round = o.round ?? (Math.max(0, ...list.map((x) => Number(x.round) || 0)) || null);
  const findings = list.flatMap((x) => (Array.isArray(x.findings) ? x.findings.map((f: unknown) => ({ f, by: who(x) })) : []));
  const people = list.map((x, i) => {
    const hold = reviewHold(t);
    const raw2 = x.verdict || x.state || x.status;
    const [g, word0, tone] = VERDICT(raw2);
    const word = hold && /pending/i.test(word0) ? 'waiting for you' : word0;
    const label = `${who(x)}${x.role ? `, ${x.role}` : ''}: ${word}${x.sha ? ` at ${String(x.sha).slice(0, 8)}` : ''}`;
    return <span key={i} className="inline-flex items-center gap-1.5 text-sm" title={label} aria-label={label}><SeatAvatar id={x.seat} /><Tag tone={tone}>{g}</Tag>{!compact && <span>{who(x)}, {word}</span>}</span>;
  });
  if (compact) return <span className="inline-flex flex-wrap items-center gap-2">{people}</span>;
  return (
    <section aria-label="Pull request reviews" className="grid gap-2">
      <h3 className="font-semibold">Code review{round ? `, round ${round}` : ''}</h3>
      <div className="flex flex-wrap gap-3">{people}</div>
      {reviewHold(t) && <p className="text-sm text-muted-foreground">{reviewHold(t)}</p>}
      {findings.length > 0 && <Disclose id="review-findings" summary={`Findings (${findings.length})`}><ul className="grid list-disc gap-2 pl-5">{findings.map(({ f, by }, i) => {
        const x = f as { text?: string; title?: string; body?: string; issue?: string; severity?: string; response?: string };
        const text = typeof f === 'string' ? f : x.text || x.title || x.body || x.issue || JSON.stringify(f);
        return <li key={i}><p>{x.severity ? `${x.severity}: ` : ''}{clean(text)}</p><p className="text-sm text-muted-foreground">from {by}{x.response ? `; response: ${clean(x.response)}` : ''}</p></li>;
      })}</ul></Disclose>}
    </section>
  );
}

export function RunCard({ card }: { card: Card | null }) {
  if (!card) return null;
  const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className="grid gap-1 border-t py-2.5 first:border-t-0 md:grid-cols-[120px_1fr] md:gap-4"><span className="text-sm text-muted-foreground">{k}</span><div className="grid min-w-0 gap-1.5">{children}</div></div>;
  return (
    <section aria-label="Run" className="grid">
      <Row k={card.live ? 'Now' : 'Last step'}>{card.now ? <NowLine card={card} /> : <p className="text-muted-foreground">{card.live ? 'Starting' : card.result ? 'Not running' : 'Not started'}</p>}</Row>
      <Row k="Plan">{card.plan ? <><p>{card.plan.done} of {card.plan.total} milestones</p>
        <ol className="grid gap-1">{card.plan.items.map((i: { state: string; text: string }, n: number) => <li key={n} className={cn('flex gap-2', i.state === 'done' && 'text-muted-foreground', i.state === 'now' && 'font-medium')}>
          <span aria-hidden className={cn('w-4 shrink-0', i.state === 'done' ? 'text-shipped' : i.state === 'now' ? 'text-primary' : 'text-muted-foreground')}>{i.state === 'done' ? '✓' : i.state === 'now' ? '▸' : '·'}</span>
          <span className="sr-only">{i.state === 'done' ? 'Done: ' : i.state === 'now' ? 'In progress: ' : 'Pending: '}</span>{i.text}</li>)}</ol></> : <p className="text-muted-foreground">No plan posted</p>}</Row>
      <Row k="Evidence"><EvidenceList ev={card.evidence} /></Row>
      {card.result && <Row k="Result">{card.result.summary && <p><Named text={clean(card.result.summary)} /></p>}<p className="text-sm text-muted-foreground">{card.result.text}</p>{card.result.next && <p><span className="text-muted-foreground">Next: </span>{card.result.next}</p>}</Row>}
      {card.cost && <Row k="Cost"><p className="font-mono">{card.cost.label}</p>{card.run && <p className="text-sm text-muted-foreground">{card.run.kind} run on {card.run.model}{card.elapsedMin != null ? `, ${mins(card.elapsedMin)}` : ''}</p>}</Row>}
      {card.says.length > 0 && <Row k="Notes">{card.sayCount > 2 && <Disclose id={`says-${card.key}`} summary={`Earlier updates (${card.sayCount - 2})`}>{card.allSays.slice(0, -2).map((s: { text: string }, i: number) => <p key={i} className="text-muted-foreground"><Named text={clean(s.text)} /></p>)}</Disclose>}
        {card.says.map((s: { text: string }, i: number) => <p key={i} className="text-muted-foreground"><Named text={clean(s.text)} /></p>)}</Row>}
      {card.toolCount > 0 && <Disclose id={`tools-${card.key}`} summary={`Execution details (${card.toolCount} step${card.toolCount > 1 ? 's' : ''})`}>
        <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{card.tools.map((e: { ts: string; text: string }, i: number) => <div key={i}><span className="opacity-70">{hhmm(e.ts)}</span> {e.text}</div>)}</div></Disclose>}
    </section>
  );
}

/** The one primary action on a decision. Publishing confirms first; merges open the PR panel. */
export function DecisionButton({ it, label, className, size }: { it: BoardItem; label?: string; className?: string; size?: 'sm' | 'default' }) {
  const t = it.ticket!;
  const text = label || it.action;
  switch (it.kind) {
    case 'question': return <Button size={size} className={className} onClick={() => openTicket(t.key, { decision: it.id, focus: true })}>{text}</Button>;
    case 'merge': return <Button size={size} className={className} onClick={() => { const n = prNumber(t.pr_url); if (n) openSheet({ type: 'pr', number: n }); else openTicket(t.key, { decision: it.id }); }}>{text}</Button>;
    case 'page': return <Button size={size} className={className} onClick={() => openSheet({ type: 'desk' })}>{text}</Button>;
    case 'access': return <Button size={size} className={className} onClick={() => openSheet({ type: 'access' })}>{text}</Button>;
    case 'plan': return <Button size={size} className={className} onClick={() => openFeature(t.key)}>{text}</Button>;
    case 'deploy': {
      if (it.ticket) return <Button size={size} className={className} onClick={() => openTicket(it.ticket!.key, { decision: it.id })}>{text}</Button>;
      // A deploy with no desk ticket (a commit pushed to main by hand): its runs and the clear are right here.
      const lock = (it as BoardItem & { deploy?: { merge_sha?: string } }).deploy;
      const runs = S.meta.repo && lock?.merge_sha ? `https://github.com/${S.meta.repo}/commit/${lock.merge_sha}/checks` : null;
      return <span className={cn('inline-flex gap-2', className)}>
        {runs && <Button size={size} variant="secondary" asChild><a href={runs} target="_blank" rel="noopener noreferrer">See the runs</a></Button>}
        <AsyncButton size={size} confirm="Clear the deploy hold? Do this after checking the deploy runs: deploying merges continue."
          run={async () => { await api('POST', '/api/merge-train/clear-deploy', { merge_sha: lock?.merge_sha }); await loadSnapshot(); }} ok="Deploy hold cleared">Clear the hold</AsyncButton>
      </span>;
    }
    case 'conflict': case 'setup': case 'refresh': case 'stuck': return <Button size={size} className={className} onClick={() => openTicket(t.key, { decision: it.id, focus: true })}>{text}</Button>;
    case 'owner_task': case 'epic_review': return <Button size={size} className={className} onClick={() => openTicket(t.key, { decision: it.id })}>{text}</Button>;
    case 'guard': case 'publish':
      return <AsyncButton size={size} className={className}
        confirm={it.kind === 'guard' ? `Lift the publish guard on ${it.name}?\n\nThe change touches protected paths or is unusually large. Approving pushes the branch and opens a draft PR. You still merge.`
          : `Publish ${it.name}?\n\nApproving pushes the branch and opens a draft PR. Nothing merges until you merge it.`}
        run={() => api('POST', `/api/tickets/${t.key}/decision`, { decision: 'approve', message: '', expected_updated_at: t.updated_at })}
        ok={it.kind === 'guard' ? 'Guard lifted; pushing the branch and opening a draft PR' : 'Approved; opening a draft PR'}>{text}</AsyncButton>;
    default: return <Button size={size} className={className} onClick={() => openTicket(t.key, { decision: it.id })}>{text}</Button>;
  }
}

export function WorkerLine({ it, card }: { it: BoardItem; card: Card | null }) {
  const w = it.worker || card?.worker;
  return <span className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><SeatAvatar id={w} />{w ? `${agentMap()[w]?.name || ''}, ${(it.stage || 'working').toLowerCase()}` : it.stage || ''}</span>;
}
