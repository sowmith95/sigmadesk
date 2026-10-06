// People on a ticket, phone first: the people picker (who to tag, and whether each tag may give production read access
// for the reply) and the person sheet (status, current work, give or revoke access, tag in chat). On a phone both are
// full-height bottom sheets that sit above the on-screen keyboard; on a desktop the picker is a popover and the person
// sheet a small dialog. The access rules live on the server (src/access.js); this only shows them and calls its API.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Dialog } from 'radix-ui';
import { KeyRound, Search, X } from 'lucide-react';
import { nameOf } from '../../../../public/names.js';
import { seatState, matchSeats } from '../../../../public/mentions.js';
import { S, api, agentMap, ticketByKey, openSheet, openTicket } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AsyncButton } from './AsyncButton';
import { SeatAvatar, Tag } from './Bits';
import { cn } from '@/lib/utils';
import type { Agent } from '@/types';

const PHONE = '(max-width: 759px)';
/** Phone layout (bottom sheets) below 760 px. */
export function useIsPhone() {
  const [m, set] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => { const q = window.matchMedia(PHONE); const on = () => set(q.matches); q.addEventListener('change', on); return () => q.removeEventListener('change', on); }, []);
  return m;
}

/** The visible viewport: its height and how much the on-screen keyboard covers at the bottom. */
function useVisualViewport(active: boolean) {
  const read = () => { const v = window.visualViewport; return v ? { height: v.height, bottom: Math.max(0, window.innerHeight - v.height - v.offsetTop) } : { height: window.innerHeight, bottom: 0 }; };
  const [s, set] = useState(read);
  useEffect(() => {
    if (!active) return;
    const v = window.visualViewport, on = () => set(read());
    on(); v?.addEventListener('resize', on); v?.addEventListener('scroll', on); window.addEventListener('resize', on);
    return () => { v?.removeEventListener('resize', on); v?.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

/**
 * A dialog that is a full-height bottom sheet on a phone (above the keyboard, inside the safe areas) and a centred
 * dialog on a desktop. Radix Dialog: focus trap, Escape and the close button close it, focus returns via onClosed.
 */
export function BottomSheet({ open, onOpenChange, title, description, children, footer, phone, initialFocus, onClosed, top, ...rest }:
  { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; phone: boolean;
    initialFocus?: RefObject<HTMLElement | null>; onClosed?: () => void; top?: ReactNode } & Record<`data-${string}`, string | boolean>) {
  const vv = useVisualViewport(open && phone);
  const kb = vv.bottom > 40; // the on-screen keyboard is up: it covers the bottom safe area
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content {...rest}
          onOpenAutoFocus={(e) => { if (initialFocus) { e.preventDefault(); initialFocus.current?.focus({ preventScroll: true }); } }}
          onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}
          className={cn('fixed z-50 flex flex-col overflow-hidden bg-background shadow-xl outline-none',
            phone ? 'inset-x-0 rounded-t-2xl border-t' : 'left-1/2 top-1/2 max-h-[85dvh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border')}
          style={phone ? { bottom: vv.bottom, height: `calc(${Math.round(vv.height)}px - env(safe-area-inset-top) - 12px)` } : undefined}>
          {phone && <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40" />}
          <header className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-2 sm:pt-4">
            <div className="grid min-w-0 flex-1 gap-0.5 pt-1">
              <Dialog.Title className="text-lg font-semibold leading-tight">{title}</Dialog.Title>
              {description ? <Dialog.Description className="text-sm text-muted-foreground">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-md bg-secondary hover:bg-accent"><X className="size-5" /></Dialog.Close>
          </header>
          {top}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain" data-sheet-body>{children}</div>
          {footer && <footer className="shrink-0 border-t bg-card px-4 pt-3" style={{ paddingBottom: kb || !phone ? 12 : 'calc(env(safe-area-inset-bottom) + 12px)' }}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------- production access (GET /api/access), shared by the picker, the bar and the person sheet ----------------
export type Grant = { id: number; seat: string; probes: string[]; expires_at: string | null; ticket_key: string | null; run_id: number | null; standing: number; granted_by: string };
type AccessData = { grants: Grant[]; mention_access?: Record<string, string[]> };
let cache: AccessData | null = null;
/** The desk's access state while `active` (re-read every `every` ms while the page is visible). */
export function useAccess(active: boolean, every = 15_000) {
  const [d, setD] = useState<AccessData | null>(cache);
  const load = () => api('GET', '/api/access').then((x: AccessData) => { cache = x; setD(x); }).catch(() => {});
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, every);
    return () => clearInterval(t);
  }, [active, every]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: d, reload: load };
}
const first = (a: Agent | undefined, id: string) => String(a?.name || id).split(/\s+/)[0];
/** The server's reasons, said to the owner ("your decision", "your access policy"). */
const toOwner = (why: string[]) => why.map((w) => w.replace(/the owner's decision/g, 'your decision').replace(/the (access )?policy/g, 'your access policy')
  .replace(/^automatic access for tagged seats/, 'automatic access for tagged people')).join('; ');
const ticketName = (k: string) => { const t = ticketByKey(k); return t ? nameOf(t) : k; };
const STATE_TONE: Record<string, string> = { free: 'text-shipped', busy: 'text-needs', off: 'text-muted-foreground' };

// ---------------- the people picker ----------------
/**
 * Choose who a message tags (all seats, searchable, several at once) and, per chosen person, whether the tag may give
 * them production read access for their reply. `why[seat]` is the server's preview: [] = the rule applies.
 */
export function PeoplePicker({ initial, choice: initialChoice, why, onApply, phone, searchRef }:
  { initial: string[]; choice: Record<string, boolean>; why: Record<string, string[]> | undefined; onApply: (seats: string[], choice: Record<string, boolean>) => void;
    phone: boolean; searchRef: RefObject<HTMLInputElement | null> }) {
  const [sel, setSel] = useState<string[]>(initial);
  const [q, setQ] = useState('');
  const [choice, setChoice] = useState(initialChoice);
  const id = useId();
  const agents = S.agents as Agent[];
  const list = matchSeats(agents, q) as Agent[];
  const toggle = (seat: string) => setSel((s) => (s.includes(seat) ? s.filter((x) => x !== seat) : [...s, seat]));
  const n = sel.length;
  const changed = n !== initial.length || sel.some((x) => !initial.includes(x));
  const names = sel.map((s) => first(agents.find((a) => a.id === s), s));
  const label = n ? `Tag ${n} ${n === 1 ? 'person' : 'people'}` : initial.length ? 'Remove all tags' : 'Tag people';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-people-picker>
      <div className="shrink-0 px-4 pb-2">
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input ref={searchRef} type="search" aria-label="Search people" placeholder="Search by name or role" value={q} enterKeyHint="done"
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (list[0] && q) { toggle(list[0].id); setQ(''); } } }}
            className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30" />
        </label>
      </div>
      <ul aria-label="People" className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain border-t" data-people-list>
        {list.map((a) => {
          const st = seatState(a, ticketName);
          const on = sel.includes(a.id);
          const w = why?.[a.id];
          const allow = choice[a.id] !== false;
          return (
            <li key={a.id} data-pick-seat={a.id} data-selected={on || undefined} className={cn(on && 'bg-primary/5')}>
              <label title={st.key === 'off' ? `${a.name} is switched off (Settings → Team): a tag stays blocked until they are on.` : undefined} className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2 hover:bg-secondary">
                <input type="checkbox" checked={on} onChange={() => toggle(a.id)} aria-describedby={`${id}-${a.id}`} className="size-5 shrink-0 accent-primary" />
                <SeatAvatar id={a.id} size="md" />
                <span className="grid min-w-0 flex-1 leading-tight"><b className={cn('truncate text-sm', st.key === 'off' && 'text-muted-foreground')}>{a.name}</b>
                  <span className="truncate text-xs text-muted-foreground">{a.role}</span></span>
                <span id={`${id}-${a.id}`} className={cn('line-clamp-2 max-w-[38%] shrink-0 text-right text-xs', STATE_TONE[st.key])}>{st.text}</span>
              </label>
              {on && <div className="grid gap-1 pb-3 pl-[4.25rem] pr-4 text-[13px]" data-access-for={a.id}>
                {w === undefined ? <span className="text-muted-foreground">Checking production access…</span>
                  : w.length === 0 ? <>
                    <label className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5"><KeyRound aria-hidden className="size-3.5 shrink-0" />Allow production read access for this reply</span>
                      <Switch checked={allow} data-access-toggle={a.id} aria-label={`Allow ${a.name} production read access for this reply`}
                        onCheckedChange={(v) => setChoice((c) => ({ ...c, [a.id]: v }))} />
                    </label>
                    <span className="text-muted-foreground">{allow ? 'Read-only, ends with the reply (1 hour at most).' : `Ask me in Inbox: if ${a.name} needs production, you decide there.`}</span>
                  </> : <span className="text-muted-foreground" data-access-why={a.id}>
                    <KeyRound aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />No automatic access: {toOwner(w)}. Ask me in Inbox: if {a.name} needs production, you decide there.</span>}
              </div>}
            </li>);
        })}
        {!list.length && <li className="px-4 py-6 text-center text-muted-foreground">Nobody matches “{q}”.</li>}
      </ul>
      <div className={cn('shrink-0 border-t bg-card px-4 pt-3', phone ? 'pb-[calc(env(safe-area-inset-bottom)+12px)]' : 'pb-3')}>
        {n > 0 && <p className="mb-2 truncate text-sm text-muted-foreground" aria-live="polite">{names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}</p>}
        <Button size="lg" className="h-12 w-full text-base" data-apply-tags disabled={!n && !changed} onClick={() => onApply(sel, choice)}>{label}</Button>
      </div>
    </div>
  );
}

// ---------------- the person sheet ----------------
const leftText = (iso: string | null, now: number) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m left` : `${m}:${String(sec).padStart(2, '0')} left`;
};
const KIND: Record<string, string> = { mention: 'answering a tag on', implement: 'building', qa: 'testing', review: 'reviewing', design: 'designing', respond: 'replying on', groom: 'grooming' };

/** Tap a participant: who they are, what they are doing, their production access (give, revoke, countdown), tag them. */
export function PersonSheet({ seat, tkey, onClose, onTag }: { seat: string; tkey: string; onClose: () => void; onTag: (seat: string) => void }) {
  const phone = useIsPhone();
  const a = agentMap()[seat] as Agent | undefined;
  const { data, reload } = useAccess(true, 10_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const tagging = useRef(false);
  if (!a) return null;
  const st = seatState(a, ticketName);
  const name = first(a, seat);
  const grants = (data?.grants || []).filter((g) => g.seat === seat);
  const grant = (body: Record<string, unknown>, ok: string) => async () => { await api('POST', '/api/access/grant', { seat, probes: ['*'], reason: `given from ${tkey}`, ...body }); await reload(); return ok; };
  const span = (g: Grant) => (g.standing ? 'standing' : g.ticket_key ? `for ${g.ticket_key === tkey ? 'this ticket' : ticketName(g.ticket_key)} · ${leftText(g.expires_at, now)} at most`
    : g.run_id ? `this reply only · ${leftText(g.expires_at, now)}` : leftText(g.expires_at, now));
  return (
    <BottomSheet open onOpenChange={(v) => { if (!v) onClose(); }} phone={phone} title={a.name} description={a.role} data-person-sheet={seat}
      onClosed={() => { if (tagging.current) onTag(seat); }}
      footer={<Button size="lg" className="h-12 w-full text-base" onClick={() => { tagging.current = true; onClose(); }}>Tag {name} in chat</Button>}>
      <div className="grid gap-5 px-4 pb-4">
        <div className="flex items-center gap-3">
          <SeatAvatar id={seat} size="lg" />
          <div className="grid gap-1">
            <Tag className="justify-self-start" tone={st.key === 'free' ? 'shipped' : st.key === 'busy' ? 'needs' : 'neutral'}>{st.key === 'free' ? 'Free' : st.key === 'busy' ? 'Busy' : 'Switched off'}</Tag>
            <span className="text-sm text-muted-foreground" data-person-work>
              {a.current_ticket ? <>{KIND[a.current_kind || ''] || 'working on'} <button type="button" className="text-primary hover:underline" onClick={() => openTicket(a.current_ticket!)}>{ticketName(a.current_ticket)}</button></>
                : st.key === 'off' ? 'Switched off in Settings → Team: a tag stays blocked until they are on.' : 'Nothing right now: a tag starts at once.'}
            </span>
          </div>
        </div>
        <section className="grid gap-2.5" aria-label="Production read access">
          <h3 className="text-sm font-semibold">Production read access</h3>
          {grants.length ? grants.map((g) => (
            <div key={g.id} data-grant={g.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <KeyRound aria-hidden className="size-4 text-shipped" />
              <span className="min-w-0 flex-1 text-sm"><b>Active</b> · <span className="tabular-nums" data-grant-left>{span(g)}</span>
                <span className="block text-xs text-muted-foreground">{g.probes.includes('*') ? 'all read-only probes' : g.probes.join(', ')} · given by {g.granted_by === 'owner' ? 'you' : g.granted_by === 'owner_mention' ? 'your tag' : g.granted_by}</span></span>
              <AsyncButton size="sm" variant="secondary" className="h-10" run={async () => { await api('POST', `/api/access/grants/${g.id}/revoke`, { reason: 'revoked by the owner' }); await reload(); }} ok={`${name}'s access revoked`}>Revoke access</AsyncButton>
            </div>))
            : <p className="text-sm text-muted-foreground" data-no-access>{data ? `${name} cannot read production now.` : 'Loading…'}</p>}
          <p className="text-sm">{grants.length ? 'Give more production read access' : 'Give production read access'}</p>
          <div className="grid grid-cols-2 gap-2">
            <AsyncButton variant="secondary" className="h-11" data-give="hour" run={grant({ minutes: 60 }, `${name} can read production for 1 hour`)} ok={(r) => String(r)}>1 hour</AsyncButton>
            <AsyncButton variant="secondary" className="h-11" data-give="ticket" run={grant({ ticket_key: tkey }, `${name} can read production for this ticket`)} ok={(r) => String(r)}>For this ticket</AsyncButton>
          </div>
          <p className="text-xs text-muted-foreground">Read-only probes; writes, restarts and deploys stay impossible. “For this ticket” works while {name} is building or reviewing it and ends when it closes.</p>
          <button type="button" className="justify-self-start text-sm text-primary hover:underline" onClick={() => openSheet({ type: 'access' })}>All production access…</button>
        </section>
      </div>
    </BottomSheet>
  );
}

