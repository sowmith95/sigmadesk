// The Inbox: what needs you, in the order you would want to do it. "Do first" on top, then lanes by what you are doing
// (unblock the team · review to ship · your tasks · proposals), compact rows that expand for the reason, and a ⋯ menu
// to snooze, set priority or hand a task back. Order and snoozes come from public/inbox.js via the board, so the
// counters everywhere agree with what is shown.
import { useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { S, api, currentBoard, openTicket, questionFor, openFeature, loadSnapshot, loadPrs, toast } from '@/store.js';
import { clean } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tag, Empty, Section } from '@/components/desk/Bits';
import { KIND_LABEL, NowLine, cardFor, Clamp, DecisionButton, firstName, reasonText, WorkerLine } from '@/components/desk/Work';
import { Lineage } from '@/components/desk/Epic';
import { BriefLine, DecisionLead, briefOf } from '@/components/desk/DecisionBrief';
import { ProgramUpdate } from '@/components/desk/Program';
import { PackageRequestRow, type PkgRequest } from '@/components/desk/Packages';
import { DecidedLane } from '@/components/desk/Delegation';
import { LANES, reasons, snoozePresets } from '../../../public/inbox.js';
import { cn } from '@/lib/utils';
import type { Board, BoardItem } from '@/types';


export function WorkingRow({ it }: { it: BoardItem }) {
  const t = it.ticket!;
  const card = cardFor(t);
  return (
    <button type="button" data-key={it.id} onClick={() => openTicket(t.key)} className="grid w-full gap-1.5 rounded-lg border bg-card p-3 text-left hover:bg-secondary">
      <Lineage t={t} link={false} />
      <div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate">{it.name}</b>{it.stage && <Tag>{it.stage}</Tag>}</div>
      <WorkerLine it={it} card={card} />
      <NowLine card={card} compact />
    </button>
  );
}

type Row = BoardItem & { lane?: string; priority?: string; waits?: number; since?: string | null; protected?: boolean; snoozed_until?: string | null; time_hint?: string | null };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fresh = (it: BoardItem) => S.painted && !S.seen.has(it.id) && !reduced();
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const OPEN_KEY = 'sd2.inboxLanes';
const openLanes = (): Record<string, boolean> => { try { return { unblock: true, ship: true, mine: false, proposals: false, ...JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') }; } catch { return { unblock: true, ship: true, mine: false, proposals: false }; } };

async function snooze(id: string, until: string | null) {
  await api('POST', '/api/inbox/snooze', { id, until });
  await loadSnapshot();
  toast(until ? `Snoozed until ${when(until)}` : 'Back in your Inbox');
}

/** ⋯ for one row: snooze (exact wake times), priority, hand a task back. */
function RowMenu({ it }: { it: Row }) {
  const t = it.ticket;
  const run = (fn: () => Promise<unknown>) => () => { fn().catch((e) => toast((e as Error).message, true)); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="size-9 shrink-0 p-0" aria-label={`Options for ${it.verb}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        {it.snoozed_until ? <DropdownMenuItem className="min-h-10" onSelect={run(() => snooze(it.id, null))}>Bring back now</DropdownMenuItem>
          : it.protected ? <DropdownMenuLabel className="font-normal text-muted-foreground">Can't snooze: it protects production</DropdownMenuLabel>
            : snoozePresets().map((p) => <DropdownMenuItem key={p.id} className="min-h-10" onSelect={run(() => snooze(it.id, p.until))}>Snooze {p.label.toLowerCase()}{it.waiting?.length ? ` (with ${it.waiting.length} waiting)` : ''}</DropdownMenuItem>)}
        {t && it.kind !== 'deploy' && it.kind !== 'regression' && <><DropdownMenuSeparator /><DropdownMenuLabel className="font-normal text-muted-foreground">Priority (now {t.priority || 'P2'}{t.priority_pinned ? ', set by you' : ''})</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={t.priority || 'P2'} onValueChange={(p) => { if (p !== t.priority) run(() => api('PATCH', `/api/tickets/${t.key}`, { priority: p }).then(() => { loadSnapshot(); toast(`${t.key} is ${p}`); }))(); }}>
            {[['P0', 'P0 · drop everything'], ['P1', 'P1 · high'], ['P2', 'P2 · normal'], ['P3', 'P3 · low']].map(([p, label]) => <DropdownMenuRadioItem key={p} value={p} className="min-h-10">{label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {!!t.priority_pinned && <DropdownMenuItem className="min-h-10" onSelect={run(() => api('PATCH', `/api/tickets/${t.key}`, { unpin_priority: true }).then(() => { loadSnapshot(); toast('The team can set its priority again'); }))}>Let the team set the priority</DropdownMenuItem>}</>}
        {it.kind === 'owner_task' && t && <><DropdownMenuSeparator /><DropdownMenuItem className="min-h-10" onSelect={run(() => api('POST', `/api/tickets/${t.key}/owner-task`, { owner_task: false }).then(() => { loadSnapshot(); toast('Handed back to the team'); }))}>Hand back to the team</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One compact row: what to do (one line) and its action; a second line with where it belongs and why it is here. */
function InboxRow({ it, hero = false }: { it: Row; hero?: boolean }) {
  const [open, setOpen] = useState(hero);
  const t = it.ticket;
  const why = reasons(it as never);
  const reason = it.kind === 'question' && t ? questionFor(t) || it.reason : it.reason;
  const openIt = () => t && (it.kind === 'plan' ? openFeature(t.key) : openTicket(t.key, { decision: it.id }));
  // Facts as plain small text (no chips): a row stays two short lines on a phone.
  // CI as the server last read it, for this commit (stale and unknown said plainly): the same fact as the brief.
  const ev = it.lane === 'ship' ? briefOf(it.id)?.evidence?.ci : null;
  const ci = ev ? { text: ev.state === 'stale' ? 'CI stale' : ev.state === 'unknown' ? 'CI unknown' : `CI ${ev.checks === 'none' ? 'not run' : ev.checks}${ev.mergeable === 'CONFLICTING' ? ' · conflicts' : ''}${ev.state === 'old' ? ' (old)' : ''}`,
    tone: ev.state === 'stale' || ev.checks === 'failing' || ev.mergeable === 'CONFLICTING' ? 'text-blocked' : ev.state === 'current' && ev.checks === 'passing' ? 'text-shipped' : 'text-muted-foreground' } : null;
  const fact = it.lane === 'ship' && t ? <>{ci && <span className={ci.tone}>· {ci.text}</span>}{t.risk === 'high' && <span className="text-muted-foreground">· high risk</span>}</>
    : it.kind === 'question' && t?.assignee ? <span className="text-[13px] text-muted-foreground">from {firstName(t.assignee)}</span> : null;
  // Delegation (#9): the delegate's take on this decision (shadow) or why it is yours (an escalation).
  const dl = (it as BoardItem & { delegate?: { seat_name?: string }; escalation?: { seat_name?: string } });
  const take = dl.delegate ? `${dl.delegate.seat_name} would decide` : dl.escalation ? `${dl.escalation.seat_name} left it for you` : null;
  return (
    <article data-key={it.id} data-kind={it.kind} data-ticket={t?.key} className={cn('grid grid-cols-[minmax(0,1fr)] gap-1.5 px-3 py-2.5', hero && 'gap-2 p-4', fresh(it) && 'animate-in fade-in duration-300')}>
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)} className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
        <h3 className={cn('min-w-0 flex-1 font-semibold leading-snug', hero ? 'text-[17px]' : 'truncate text-[15px]')}>{t ? <button type="button" className="block w-full truncate text-left hover:underline" title={it.verb} onClick={openIt}>{it.verb}</button> : it.verb}</h3>
        {/* On a phone the title opens the decision; the button would crowd the title off the row. */}
        {!hero && <DecisionButton it={it} size="sm" className={cn('shrink-0', it.kind !== 'page' && 'max-md:hidden')} />}
        {t && <RowMenu it={it} />}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-9 text-[13px]">
        <span className="font-medium text-needs">{KIND_LABEL[it.kind || ''] || 'Needs you'}</span>
        {t && <Lineage t={t} className="min-w-0 max-w-[45%] text-[13px] [&>button]:max-w-[16ch]" />}
        {why.map((w) => <span key={w} className={cn('text-muted-foreground', /^P[01]$/.test(w) && 'font-semibold text-needs')}>{w}</span>)}
        {it.time_hint && <span className="text-muted-foreground">· {it.time_hint}</span>}
        {it.snoozed_until && <span className="text-muted-foreground">· back {when(it.snoozed_until)}</span>}
        {fact}
        {/* A phone row stays two short lines: there the delegate's take shows when the row or the decision opens. */}
        {take && <span data-take className="text-muted-foreground max-md:hidden">· {take}</span>}
        {!!it.waiting?.length && <span data-waiting={it.waiting.map((w) => w.key).join(',')} className="text-muted-foreground">· +{it.waiting.length} waiting question{it.waiting.length === 1 ? '' : 's'}</span>}
      </div>
      {!open && <BriefLine it={it} />}
      {open && <div className="grid gap-3 pl-9">
        <div className="max-w-[68ch] text-sm"><Clamp id={`reason-${it.id}`} text={clean(reason)} /></div>
        {t && <DecisionLead it={it} t={t} inline full={['merge', 'publish', 'guard', 'deploy', 'access'].includes(it.kind || '')} />}
        {it.kind === 'packages' && (it as BoardItem & { packages?: PkgRequest }).packages && <div className="rounded-lg border bg-card"><PackageRequestRow r={(it as BoardItem & { packages: PkgRequest }).packages} /></div>}
        {!!it.waiting?.length && <p className="text-sm text-muted-foreground">
          {it.kind === 'epic_review' ? 'Also answers: ' : `${it.waiting.length} more question${it.waiting.length === 1 ? '' : 's'} wait${it.waiting.length === 1 ? 's' : ''} on this: `}
          {it.waiting.map((w, i) => <span key={w.id}>{i > 0 && ', '}<button type="button" className="hover:text-foreground hover:underline" onClick={() => openTicket(w.key, { decision: w.id })}>{w.name}</button></span>)}</p>}
        {/* The action is always reachable from an open row (on a phone the collapsed row shows only the title). */}
        {(hero || open) && <div className={cn('flex flex-wrap gap-2', !hero && 'md:hidden')}>{t && <Button variant="ghost" onClick={openIt}>Details</Button>}<DecisionButton it={it} className="max-md:flex-1" /></div>}
      </div>}
    </article>
  );
}

function Lane({ id, title, hint, rows, open, onToggle }: { id: string; title: string; hint: string; rows: Row[]; open: boolean; onToggle: () => void }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title} data-lane={id} className="grid gap-1.5">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-baseline gap-2 text-left">
        {open ? <ChevronDown className="size-4 self-center" aria-hidden /> : <ChevronRight className="size-4 self-center" aria-hidden />}
        <b>{title}</b><span className="font-mono text-sm text-muted-foreground">{rows.length}</span>
        <span className="truncate text-[13px] text-muted-foreground max-md:hidden">{hint}</span>
      </button>
      {open && <div className="grid grid-cols-[minmax(0,1fr)] divide-y overflow-hidden rounded-lg border bg-card">{rows.map((it) => <InboxRow key={it.id} it={it} />)}</div>}
    </section>
  );
}

export function InboxPage() {
  const B = currentBoard() as Board & { snoozed?: Row[]; do_first?: string | null };
  const c = B.counts;
  const [lanes, setLanes] = useState(openLanes);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const rows = B.needs_you as Row[];
  if (rows.some((x) => x.kind === 'merge')) loadPrs(); // reading the PR list is also how the server learns each PR's CI
  const first = rows.find((r) => r.id === B.do_first) || null;
  const rest = rows.filter((r) => r !== first);
  const toggle = (id: string) => { const n = { ...lanes, [id]: !lanes[id] }; setLanes(n); try { localStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* private mode */ } };
  const snoozed = B.snoozed || [];
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      <Section id="needs" title="Needs you" count={c.needs_you} tone="needs">
        <div className="-mt-2 mb-4"><ProgramUpdate compact /></div>
        {rows.length ? <div className="grid gap-5">
          {first && <div data-do-first className="grid gap-1.5"><span className="text-[13px] font-medium text-needs">Do first</span>
            <div className="overflow-hidden rounded-lg border border-l-[3px] border-l-needs bg-card"><InboxRow key={first.id} it={first} hero /></div></div>}
          {LANES.map((l) => <Lane key={l.id} {...l} rows={rest.filter((r) => r.lane === l.id)} open={!!lanes[l.id]} onToggle={() => toggle(l.id)} />)}
        </div> : <Empty title={snoozed.length ? 'Nothing due now.' : 'Nothing needs you.'}>{snoozed.length ? `${snoozed.length} snoozed. ` : ''}{c.working} working, {c.queued} queued.</Empty>}
        <div className="mt-5"><DecidedLane rows={(B as Board & { decided?: Record<string, unknown>[] }).decided || []} /></div>
        {snoozed.length > 0 && <div className="mt-5 grid gap-1.5" data-snoozed>
          <button type="button" aria-expanded={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)} className="flex items-center gap-2 text-left text-sm text-muted-foreground">
            {showSnoozed ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}Snoozed <span className="font-mono">{snoozed.length}</span></button>
          {showSnoozed && <div className="divide-y overflow-hidden rounded-lg border bg-card opacity-90">{snoozed.map((it) => <InboxRow key={it.id} it={it} />)}</div>}
        </div>}
      </Section>
      <div className="grid gap-8 xl:sticky xl:top-32">
        <Section id="working" title="Working now" count={c.working}>
          {c.working ? <div className="grid gap-2">{B.working.map((it) => <WorkingRow key={it.id} it={it} />)}</div>
            : <p className="text-muted-foreground">{S.settings.paused === 'true' ? 'The desk is halted. Resume it from Desk.' : 'No seat is running right now.'}</p>}
        </Section>
        <Section id="blocked" title="Blocked" count={c.blocked} tone="blocked">
          {c.blocked ? <div className="grid gap-2">{B.blocked.map((it) => (
            <button key={it.id} type="button" data-key={it.id} onClick={() => openTicket(it.ticket!.key)} className="grid gap-1 rounded-lg border border-l-[3px] border-l-blocked bg-card p-3 text-left hover:bg-secondary">
              <b>{it.verb}</b><span className="text-sm text-muted-foreground">{reasonText(it.reason)}</span></button>))}</div>
            : <p className="text-muted-foreground">Nothing is blocked.</p>}
        </Section>
      </div>
    </div>
  );
}
