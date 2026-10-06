// Who is writing on a ticket, messaging-app style, derived only from real activity (public/presence.js): active runs and
// their latest steps, the scheduler's waiting entry, and the owner's own local draft. Nothing here animates unless a
// seat posted a step in the last 45 s; ages re-evaluate on a shared 10 s clock (no server polling).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { presenceFor, writingSentence, writingDetail, writingNames, presenceAnnouncement } from '../../../../public/presence.js';
import { S } from '@/store.js';
import { mergeEvents } from '@/lib/sync.js';
import { SeatAvatar } from './Bits';
import { cn } from '@/lib/utils';

type Presence = ReturnType<typeof presenceFor>;
type Writer = Presence['writers'][number];

// One interval for every presence view on screen, paused while the tab is hidden.
let tick = 0;
const tickers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(l: () => void) {
  tickers.add(l);
  if (!timer) timer = setInterval(() => { if (document.visibilityState !== 'visible') return; tick++; for (const f of tickers) f(); }, 10_000);
  return () => { tickers.delete(l); if (!tickers.size && timer) { clearInterval(timer); timer = null; } };
}
export const usePresenceClock = () => useSyncExternalStore(subscribeClock, () => tick);

/** Presence for a ticket from the live store (the open ticket's fetched events are merged in, as the run card does). */
export function ticketPresence(key: string, drafts: Record<string, string> = {}): Presence {
  const d = S.detail;
  const events = d && d.key === key && d.data ? mergeEvents(S.events, d.data.events) : S.events;
  // A tagged seat waiting for its turn is "up next" too (the scheduler keeps tags apart from the ticket's own reasons).
  const waiting = [...(S.meta.scheduler?.waiting || []), ...(S.meta.scheduler?.mention_queue || [])];
  return presenceFor({ key, agents: S.agents, runs: S.runs, events, waiting, drafts, now: Date.now() });
}

/** Screen-reader announcement: only when who is writing changes, and at most every 15 s. */
function useThrottled(text: string, ms = 15_000) {
  const [said, setSaid] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (text === said) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    const id = setTimeout(() => { last.current = Date.now(); setSaid(text); }, wait);
    return () => clearTimeout(id);
  }, [text, said, ms]);
  return said;
}

export function TypingDots({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-flex items-end gap-[3px] pb-[3px]', className)}>
    {[0, 1, 2].map((i) => <span key={i} className="sd-typing-dot size-[5px] rounded-full bg-current" style={{ animationDelay: `${i * 160}ms` }} />)}</span>;
}

const RING: Record<string, string> = { writing: 'ring-2 ring-primary', quiet: 'ring-1 ring-border', stalled: 'ring-2 ring-needs', next: 'opacity-60 ring-1 ring-border' };
function Face({ id, state }: { id: string; state: string }) {
  return <span data-presence-ring={state} className={cn('inline-flex shrink-0 rounded-full bg-card ring-offset-1 ring-offset-card', RING[state])}><SeatAvatar id={id} size="sm" /></span>;
}
// Tapping a chip while the reply has focus must not blur it first: on a phone the blur re-lays out the panel between
// press and release, and the tap lands on whatever moved under the finger. Keep focus on press; the handler moves it.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();
const chip = 'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border bg-background/60 py-1 pl-1 pr-3 text-left text-sm hover:bg-secondary max-md:min-h-11';

/**
 * The strip above the Conversation footer. onSeat opens that seat's live run; onDraft returns to the owner's draft.
 * `hideDraft` is set when the draft's own reply box is already on screen.
 */
export function PresenceStrip({ tkey, drafts, onSeat, onDraft, hideDraft }: { tkey: string; drafts: Record<string, string>; onSeat: (seat: string) => void; onDraft: (id: string) => void; hideDraft?: (id: string) => boolean }) {
  usePresenceClock();
  const p = ticketPresence(tkey, drafts);
  const announce = useThrottled(presenceAnnouncement(p));
  const writing = p.writers.filter((w) => w.state === 'writing');
  const others = p.writers.filter((w) => w.state !== 'writing');
  const draft = p.draft && !hideDraft?.(p.draft.id) ? p.draft : null;
  const empty = !p.writers.length && !p.next.length && !draft;
  return (
    // display: contents — the live region stays mounted (a hidden one is never announced) without adding footer gap.
    <div data-presence={tkey} className="contents">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announce}</span>
      {!empty && <div role="group" aria-label="Who is writing" className="flex flex-wrap items-center gap-1.5 max-md:-mx-1 max-md:py-0.5 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-1 max-md:[scrollbar-width:none] max-md:[&>*]:shrink-0">
        {writing.length > 0 && <WritingChip writers={writing} onSeat={onSeat} />}
        {others.map((w) => (
          <button key={w.seat} type="button" onMouseDown={keepFocus} data-presence-state={w.state} className={cn(chip, w.state === 'stalled' && 'border-needs/50 text-needs')} onClick={() => onSeat(w.seat)}
            aria-label={`${w.text}. Open the live run`} title={w.label || undefined}>
            <Face id={w.seat} state={w.state} /><span className="truncate">{w.text}</span></button>))}
        {p.next.map((n) => (
          <span key={n.seat} data-presence-state="next" className={cn(chip, 'cursor-default text-muted-foreground hover:bg-background/60')}><Face id={n.seat} state="next" /><span className="truncate">{n.text}</span></span>))}
        {draft && <button type="button" onMouseDown={keepFocus} data-presence-state="draft" className={cn(chip, 'text-muted-foreground')} onClick={() => onDraft(draft.id)}>
          <SeatAvatar id="owner" size="sm" /><span className="truncate">You have an unsent draft</span></button>}
      </div>}
    </div>
  );
}

function WritingChip({ writers, onSeat }: { writers: Writer[]; onSeat: (seat: string) => void }) {
  const one = writers.length === 1 ? writers[0] : null;
  const faces = writers.slice(0, 3);
  const more = writers.length - faces.length;
  const sentence = writingSentence(writers.map((w) => w.name));
  return (
    <button type="button" onMouseDown={keepFocus} data-presence-state="writing" className={cn(chip, 'border-primary/40')} onClick={() => onSeat(writers[0].seat)}
      aria-label={`${sentence.replace('…', '')}${one?.label ? `: ${one.label}` : ''}. Open the live run`} title={writers.map((w) => `${w.name}: ${writingDetail(w)}`).join('\n')}>
      <span className="flex shrink-0 -space-x-2">{faces.map((w) => <Face key={w.seat} id={w.seat} state="writing" />)}
        {more > 0 && <span className="z-10 inline-grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold ring-2 ring-card">+{more}</span>}</span>
      <span className="min-w-0 truncate"><span className="text-foreground">{sentence}</span>
        {one && <span className="text-muted-foreground"> {writingDetail(one)}</span>}</span>
      <TypingDots className="shrink-0 text-primary" />
    </button>
  );
}

/** Board cards: a tiny "someone is writing" mark (avatar ring + three dots), nothing otherwise. */
export function WritingMark({ tkey }: { tkey: string }) {
  usePresenceClock();
  const names = writingNames(ticketPresence(tkey));
  if (!names.length) return null;
  const s = writingSentence(names);
  return <span data-writing={tkey} className="inline-flex items-center gap-1 text-primary" title={s}><TypingDots /><span className="sr-only">{s}</span></span>;
}
