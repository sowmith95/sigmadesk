// @mentions on a ticket: the composer's seat picker, the tags line, per-recipient delivery states under the owner's
// message, and the participants row with "Add people". The rules live in public/mentions.js (unit-tested).
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Check, UserPlus } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { mentionQuery, matchSeats, insertMention, seatState, handleOf, taggedSeats, deliveryView } from '../../../public/mentions.js';
import { S, api, ticketByKey, loadDetail, toast } from '@/store.js';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, SeatAvatar, MentionChip } from '@/components/desk/Bits';
import { cn } from '@/lib/utils';
import type { Agent } from '@/types';

type Q = { start: number; query: string } | null;
type Delivery = { id: number; seat_id: string; status: string; reason?: string | null; routed?: string | null; reply_comment_id?: number | null; run_id?: number | null };

const ticketName = (k: string) => { const t = ticketByKey(k); return t ? nameOf(t) : k; };
const STATE_TONE: Record<string, string> = { free: 'text-shipped', busy: 'text-needs', off: 'text-muted-foreground' };
const firstName = (a: Agent | undefined, id: string) => String(a?.name || id).split(/\s+/)[0];

/**
 * The composer's "@" picker for one textarea: call `sync` after every change and caret move, pass `keyDown` to the
 * textarea, and render `<SeatPicker {...picker} />` next to it. Escape closes the picker, not the panel.
 */
export function useMentionPicker({ text, setText, area }: { text: string; setText: (v: string) => void; area: RefObject<HTMLTextAreaElement | null> }) {
  const [q, setQ] = useState<Q>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const agents = S.agents as Agent[];
  const items = q ? matchSeats(agents, q.query).slice(0, 8) as Agent[] : [];
  const open = !!q && items.length > 0;
  // The caret after a pick goes where the tag ends, set in the same commit as the new text (a frame later would move it
  // under characters typed meanwhile).
  const caretAt = useRef<number | null>(null);
  useLayoutEffect(() => { const el = area.current, at = caretAt.current; if (el && at != null) { caretAt.current = null; el.focus(); el.setSelectionRange(at, at); } });
  const sync = (value: string, caret: number | null) => { const next = caret == null ? null : mentionQuery(value, caret); setQ(next); if (!next || next.query !== q?.query) setActive(0); };
  const pick = (a: Agent) => {
    if (!q) return;
    const out = insertMention(text, q, handleOf(a, agents));
    caretAt.current = out.caret;
    setText(out.text); setQ(null);
  };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[Math.min(active, items.length - 1)]); }
    else if (e.key === 'Escape') { e.preventDefault(); setQ(null); }
  };
  /** Open the picker at the caret (the "@" button): inserts "@" when the caret is not already in a tag. */
  const start = () => {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const at = mentionQuery(text, caret);
    if (at) { setQ(at); el?.focus(); return; }
    const before = text.slice(0, caret), after = text.slice(caret);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const value = `${before}${pad}@${after}`;
    setText(value);
    const pos = before.length + pad.length + 1;
    caretAt.current = pos;
    setQ({ start: pos - 1, query: '' });
  };
  const optionId = (i: number) => `${id}-seat-${i}`;
  return {
    sync, keyDown, start, close: () => setQ(null),
    aria: open ? { 'aria-controls': `${id}-list`, 'aria-activedescendant': optionId(Math.min(active, items.length - 1)) } : {},
    picker: { open, items, active, listId: `${id}-list`, optionId, onPick: pick, onHover: setActive },
  };
}

export function SeatPicker({ open, items, active, listId, optionId, onPick, onHover }:
  { open: boolean; items: Agent[]; active: number; listId: string; optionId: (i: number) => string; onPick: (a: Agent) => void; onHover: (i: number) => void }) {
  if (!open) return null;
  return (
    // data-captures-escape: the panel leaves Escape to this list while it is open.
    <div data-mention-picker data-captures-escape className="grid gap-1 rounded-lg border bg-popover p-1 shadow-lg">
      <p className="px-2 pt-1 text-xs text-muted-foreground">Tag someone · they answer here</p>
      <ul id={listId} role="listbox" aria-label="People to tag" className="grid max-h-[38dvh] gap-0.5 overflow-y-auto overscroll-contain">
        {items.map((a, i) => {
          const st = seatState(a, ticketName);
          return (
            <li key={a.id} id={optionId(i)} role="option" aria-selected={i === active} data-seat={a.id}
              // Keep the textarea focused through the tap (a blur would re-lay out the footer under the finger).
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== active) onHover(i); }} onClick={() => onPick(a)}
              className={cn('flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5', i === active ? 'bg-accent' : 'hover:bg-secondary', st.key === 'off' && 'opacity-60')}>
              <SeatAvatar id={a.id} size="md" />
              <span className="grid min-w-0 flex-1 leading-tight"><b className="truncate text-sm">{a.name}</b><span className="truncate text-xs text-muted-foreground">{a.role}</span></span>
              <span className={cn('shrink-0 text-xs', STATE_TONE[st.key])}>{st.text}</span>
            </li>);
        })}
      </ul>
    </div>
  );
}

/** "To: Rowan, Devon" — exactly the seats the message will tag (what you see is what is sent). */
export function TagLine({ text, onTag }: { text: string; onTag: () => void }) {
  const seats = taggedSeats(text, S.agents);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm" data-tag-line>
      {seats.length ? <><span className="text-muted-foreground">To</span>{seats.map((s: string) => <MentionChip key={s} seat={s} />)}</>
        : <span className="text-muted-foreground">Type @ to tag someone; they answer in this thread.</span>}
      <span className="flex-1" />
      <Button type="button" size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onTag} aria-label="Tag someone">@ Tag</Button>
    </div>
  );
}

/** Each tagged seat's delivery under the owner's message: Queued, Working, Replied, Blocked (why), Failed, Cancelled. */
export function Deliveries({ list, tkey }: { list: Delivery[]; tkey: string }) {
  const agents = Object.fromEntries((S.agents as Agent[]).map((a) => [a.id, a]));
  const act = (m: Delivery, action: 'retry' | 'cancel') => async () => { await api('POST', `/api/mentions/${m.id}/${action}`, {}); await loadDetail(); };
  const jump = (id?: number | null) => { if (id) document.querySelector(`[data-message="c${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  return (
    <ul aria-label="Who this message tagged" className="grid justify-items-end gap-1" data-deliveries>
      {list.map((m) => {
        const a = agents[m.seat_id];
        const busy = a?.status === 'working' && !(a.current_ticket === tkey && a.current_kind === 'mention');
        const v = deliveryView(m, { busy });
        const name = firstName(a, m.seat_id);
        return (
          <li key={m.id} data-delivery={m.seat_id} data-state={m.status} className="flex max-w-full flex-wrap items-center justify-end gap-1.5 text-sm">
            <SeatAvatar id={m.seat_id} size="sm" />
            <span className="font-medium">{name}</span>
            <Tag tone={v.tone as 'neutral'}>{v.label}</Tag>
            {v.detail && <span className={cn('min-w-0 text-[13px] text-muted-foreground', ['blocked', 'failed'].includes(m.status) && 'basis-full text-right text-blocked')}>{v.detail}</span>}
            {m.status === 'replied' && m.reply_comment_id && <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => jump(m.reply_comment_id)}>See reply</button>}
            {v.retry && <AsyncButton size="sm" variant="secondary" className="h-8" run={act(m, 'retry')} ok={`Tag sent to ${name} again`}>Retry</AsyncButton>}
            {v.cancel && <AsyncButton size="sm" variant="ghost" className="h-8" confirm={m.status === 'working' ? `Stop ${name}'s answer?` : undefined} run={act(m, 'cancel')} ok="Tag cancelled">Cancel</AsyncButton>}
          </li>);
      })}
    </ul>
  );
}

/** Who is on the ticket (stacked portraits) and "Add people": participants see the thread; only tags start work. */
export function Participants({ tkey, list }: { tkey: string; list: { seat_id: string }[] }) {
  const agents = S.agents as Agent[];
  const on = new Set(list.map((p) => p.seat_id));
  const shown = list.slice(0, 5);
  const more = list.length - shown.length;
  const toggle = (a: Agent) => async (e: Event) => {
    e.preventDefault(); // keep the menu open: add several people at once
    try { await api('POST', `/api/tickets/${tkey}/participants`, on.has(a.id) ? { remove: [a.id] } : { add: [a.id] }); await loadDetail(); }
    catch (err) { toast((err as Error).message, true); }
  };
  return (
    <div className="flex items-center gap-2" data-participants={tkey}>
      {list.length > 0 && <span className="flex -space-x-2" aria-label={`On this ticket: ${list.map((p) => firstName(agents.find((a) => a.id === p.seat_id), p.seat_id)).join(', ')}`} role="img">
        {shown.map((p) => <span key={p.seat_id} className="inline-flex rounded-full ring-2 ring-card"><SeatAvatar id={p.seat_id} size="sm" /></span>)}
        {more > 0 && <span className="z-10 inline-grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold ring-2 ring-card">+{more}</span>}</span>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="h-8 px-2 max-md:h-10"><UserPlus className="size-4" />Add people</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60dvh] min-w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">They see this thread. Tag them in a message to ask for something.</DropdownMenuLabel>
          {agents.map((a) => {
            const st = seatState(a, ticketName);
            return <DropdownMenuItem key={a.id} data-add-seat={a.id} className="min-h-11 gap-2.5" onSelect={toggle(a)}>
              <SeatAvatar id={a.id} size="md" />
              <span className="grid min-w-0 flex-1 leading-tight"><b className="truncate text-sm">{a.name}</b><span className="truncate text-xs text-muted-foreground">{a.role} · {st.text}</span></span>
              {on.has(a.id) && <Check className="size-4 text-primary" aria-label="on this ticket" />}
            </DropdownMenuItem>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
