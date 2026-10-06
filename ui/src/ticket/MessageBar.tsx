// The ticket conversation's message bar, messaging style: always at the bottom of the Conversation tab, one tap to
// type. "@" opens the people picker (a full-height sheet on a phone, a popover on a desktop); typing "@ro" filters
// inline. Tagged people show as removable chips. What the text tags is exactly what is sent (mentions[] is
// authoritative on the server); each tagged person's production-access choice travels with the message (no_access).
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Popover } from 'radix-ui';
import { AtSign, KeyRound, SendHorizontal, X } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { taggedSeats, removeMention, setMentions } from '../../../public/mentions.js';
import { S, api, loadDetail, loadSnapshot, draftKey, setDraft } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { SeatAvatar } from '@/components/desk/Bits';
import { BottomSheet, PeoplePicker, useAccess, useIsPhone } from '@/components/desk/PeopleSheet';
import { useMentionPicker, SeatPicker } from './Mentions';
import { cn } from '@/lib/utils';
import type { Agent, Ticket } from '@/types';

export type BarHandle = { focus: () => void; tag: (seat: string) => void };
// Per ticket, the owner's access choice for each tagged person (true = may get access for the reply; false = ask me).
const choices: Record<string, Record<string, boolean>> = {};
const firstOf = (id: string) => String((S.agents as Agent[]).find((a) => a.id === id)?.name || id).split(/\s+/)[0];
const names = (ids: string[]) => { const n = ids.map(firstOf); return n.length < 3 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`; };
const newId = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

export function MessageBar({ t, onTyping, handle }: { t: Ticket; onTyping: (v: boolean) => void; handle: MutableRefObject<BarHandle | null> }) {
  const dk = draftKey(t.key);
  const [text, setText] = useState<string>(S.drafts[dk] || '');
  useEffect(() => { setText(S.drafts[dk] || ''); }, [dk]);
  const area = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const requestId = useRef<string | null>(null); // one per message: a retried POST returns what the first one made
  const edit = (v: string) => { setText(v); setDraft(dk, v); requestId.current = null; };
  const tags = useMentionPicker({ text, setText: edit, area });
  const agents = S.agents as Agent[];
  const tagged: string[] = taggedSeats(text, agents);
  const phone = useIsPhone();
  const [picking, setPicking] = useState(false);
  const caret = useRef<number | null>(null); // where the picker's tags go (the open "@query", or the caret)
  const [choice, setChoiceState] = useState<Record<string, boolean>>(choices[t.key] || {});
  const setChoice = (c: Record<string, boolean>) => { choices[t.key] = c; setChoiceState(c); };
  const { data } = useAccess(picking || tagged.length > 0, 30_000);
  const why = data?.mention_access;
  const autoAccess = (seat: string) => why?.[seat]?.length === 0 && choice[seat] !== false;
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => { const el = area.current, at = caretTo.current; if (el && at != null) { caretTo.current = null; el.focus(); el.setSelectionRange(at, at); } });

  const openPicker = () => { caret.current = area.current ? area.current.selectionStart : text.length; tags.close(); setPicking(true); };
  const apply = (seats: string[], c: Record<string, boolean>) => {
    const out = setMentions(text, seats, agents, caret.current);
    edit(out.text); setChoice({ ...choice, ...c }); setPicking(false);
    // On a phone the keyboard stays down until the person taps the field: the chips and Send stay in view.
    if (!phone) caretTo.current = out.caret;
  };
  handle.current = {
    focus: () => area.current?.focus(),
    tag: (seat) => { const out = setMentions(text, [...new Set([...tagged, seat])], agents, area.current?.selectionStart ?? text.length); edit(out.text); caretTo.current = out.caret; },
  };

  // The field grows with what you type (a phone keeps it to 22% of the screen so the thread stays readable above it).
  const grow = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * (window.innerWidth < 768 ? 0.22 : 0.4))}px`; };
  useLayoutEffect(() => { grow(area.current); }, [text]);

  const sent = () => { setDraft(dk, ''); setText(''); setChoice({}); requestId.current = null; area.current?.blur(); onTyping(false); };
  const post = (mode: 'comment' | 'discussion') => async () => {
    const body = text.trim();
    if (!body) { area.current?.focus(); throw new Error('Type a message first.'); }
    requestId.current ||= newId();
    const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode, mentions: [], request_id: requestId.current });
    sent(); await loadDetail(); return r;
  };
  // A message that tags people; a closed ticket is reopened first, if you say so.
  const sendTagged = async () => {
    const body = text.trim();
    const reopen = async () => {
      if (!window.confirm(`${nameOf(t)} is closed. Reopen it and send your message?`)) return false;
      await api('PATCH', `/api/tickets/${t.key}`, { status: 'todo' }); await loadSnapshot().catch(() => {}); return true;
    };
    if (['done', 'wontdo'].includes(t.status) && !(await reopen())) return false;
    requestId.current ||= newId();
    const noAccess = tagged.filter((s) => choice[s] === false);
    const send = () => api('POST', `/api/tickets/${t.key}/reply`, { body, mode: 'auto', mentions: tagged, request_id: requestId.current, ...(noAccess.length ? { no_access: noAccess } : {}) });
    let r;
    try { r = await send(); } catch (e) {
      if ((e as { code?: string }).code !== 'ticket_closed' || !(await reopen())) throw e;
      r = await send();
    }
    sent(); await loadDetail(); return r;
  };
  const sendLabel = tagged.length ? `Send to ${names(tagged)}` : 'Send';
  const sendOk = tagged.length ? `Sent to ${names(tagged)}; they answer here` : 'Sent to the thread';

  const bar = (
    <div className="grid min-w-0 gap-1.5" data-message-bar>
      <SeatPicker {...tags.picker} onMore={openPicker} />
      {tagged.length > 0 && <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-tag-line>
        <span className="text-sm text-muted-foreground">To</span>
        {tagged.map((s) => (
          <span key={s} data-mention-chip={s} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-0.5 pr-0.5 text-sm font-medium text-primary">
            <SeatAvatar id={s} size="sm" /><span className="truncate">{firstOf(s)}</span>
            {autoAccess(s) && <KeyRound aria-label="may get production read access for this reply" className="size-3.5" />}
            <button type="button" aria-label={`Remove ${firstOf(s)}`} onMouseDown={(e) => e.preventDefault()} onClick={() => edit(removeMention(text, s, agents))}
              className="grid size-6 place-items-center rounded-full hover:bg-primary/20"><X className="size-3.5" /></button>
          </span>))}
      </div>}
      {!tagged.length && text.trim() && <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground" data-send-hint>
        Sends a comment to the thread.
        <AsyncButton variant="link" size="sm" className="h-8 px-0 text-[13px]" onMouseDown={(e) => e.preventDefault()} run={post('discussion')} ok="Sent to the manager as a design discussion; the ticket keeps its place">Ask the manager instead</AsyncButton>
      </p>}
      <div className="flex items-end gap-2">
        <Button type="button" variant="secondary" size="icon" className="size-11 shrink-0" aria-label="Tag people" aria-haspopup="dialog" aria-expanded={picking}
          onMouseDown={(e) => e.preventDefault()} onClick={openPicker}><AtSign className="size-5" /></Button>
        <Textarea id="message" ref={area} rows={1} aria-label="Message" placeholder="Message… type @ to tag" maxLength={8000} value={text} enterKeyHint="enter"
          className="max-h-[40dvh] min-h-11 resize-none overflow-y-auto py-2.5 leading-snug max-md:max-h-[22dvh]"
          {...tags.aria}
          onChange={(e) => { edit(e.target.value); tags.sync(e.target.value, e.target.selectionStart); }}
          onKeyDown={(e) => {
            tags.keyDown(e);
            if (!e.defaultPrevented && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.querySelector<HTMLButtonElement>('[data-send]')?.click(); }
          }}
          onClick={(e) => tags.sync(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) tags.sync(e.currentTarget.value, e.currentTarget.selectionStart); }}
          // Typing on a phone: the header shrinks to one line and the thread scrolls so the newest message starts at the top.
          onFocus={() => { if (window.innerWidth >= 768) return; onTyping(true); setTimeout(() => document.querySelector('[data-panel] [role="log"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); }}
          onBlur={() => { onTyping(false); setTimeout(() => tags.close(), 150); }} />
        {/* Keep the field focused through the press: on a phone its blur re-lays out the panel under the finger. */}
        <AsyncButton data-send size="icon" className="size-11 shrink-0 sm:w-auto sm:px-4" aria-label={sendLabel} disabled={!text.trim()} onMouseDown={(e) => e.preventDefault()}
          run={tagged.length ? sendTagged : post('comment')} ok={sendOk}><SendHorizontal className="size-5" /><span className="max-sm:sr-only">Send</span></AsyncButton>
      </div>
    </div>
  );
  const picker = picking && <PeoplePicker initial={tagged} choice={choice} why={why} phone={phone} searchRef={search} onApply={apply} />;
  const back = () => { if (!phone) area.current?.focus(); };
  if (phone) return <>
    {bar}
    <BottomSheet open={picking} onOpenChange={setPicking} phone title="Tag people" description="They answer in this thread." data-people-sheet
      onClosed={back}>{picker}</BottomSheet>
  </>;
  return (
    <Popover.Root open={picking} onOpenChange={setPicking} modal>
      <Popover.Anchor asChild>{bar}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} data-people-popover
          onOpenAutoFocus={(e) => { e.preventDefault(); search.current?.focus(); }} onCloseAutoFocus={(e) => { e.preventDefault(); back(); }}
          className={cn('z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover pt-3 shadow-xl outline-none')}>
          <p className="px-4 pb-2 text-sm font-semibold">Tag people <span className="font-normal text-muted-foreground">· they answer in this thread</span></p>
          {picker}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

