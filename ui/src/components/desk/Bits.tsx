import { useLayoutEffect, useRef } from 'react';
import { GitPullRequest, Sigma } from 'lucide-react';
import { portrait, presenceOf } from '../../../../public/avatars.js';
import { linkKeys } from '../../../../public/names.js';
import { agentMap, ticketByKey, openTicket } from '@/store.js';
import { cn } from '@/lib/utils';
import type { Agent } from '@/types';

const PX = { sm: 24, md: 32, lg: 44, xl: 64 } as const;
/** Seat portrait from avatars.js (shared with Classic), with its presence ring. */
export function SeatAvatar({ id, size = 'sm', className }: { id: string | null | undefined; size?: keyof typeof PX; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const a = id ? (agentMap()[id] as Agent | undefined) : undefined;
  const pr = a ? presenceOf(a) : null;
  const sig = a ? `${a.id}|${a.engine}|${a.model}|${pr!.key}|${size}` : '';
  useLayoutEffect(() => { if (ref.current && a) ref.current.replaceChildren(portrait(a, { size: PX[size], presence: pr!.key })); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const px = PX[size];
  if (!a) {
    // Not a seat: you, GitHub, or the desk itself. An icon, never an empty dot.
    const label = id === 'owner' ? 'You' : id === 'github' ? 'GitHub' : 'Desk';
    const Icon = id === 'github' ? GitPullRequest : id === 'owner' ? null : Sigma;
    return <span className={cn('inline-grid shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground', id === 'owner' && 'bg-primary/20 text-primary', className)} style={{ width: px, height: px }} title={label} aria-hidden>
      {Icon ? <Icon style={{ width: px * 0.5, height: px * 0.5 }} /> : 'You'}</span>;
  }
  // !size-full: chip and button styles shrink any inner svg to 16 px; a portrait must fill its box.
  return <span ref={ref} className={cn('inline-flex shrink-0 leading-none [&_svg]:block [&_svg]:!size-full', className)} style={{ width: px, height: px }} title={`${a.name}, ${a.role}, ${pr!.text}`} />;
}

/** Text where ticket keys become named chips that open the ticket. */
export function Named({ text, self }: { text: string | null | undefined; self?: string }) {
  // Inside a ticket's own thread its key stays plain text: a chip that reopens the same ticket only adds noise.
  return linkKeys(String(text ?? ''), ticketByKey).map((p: string | { key: string; name: string }, i: number) => (typeof p === 'string' ? <span key={i}>{p}</span>
    : p.key === self ? <span key={i} className="font-mono text-[0.9em] text-muted-foreground">{p.key}</span>
    : <button key={i} type="button" title={p.key} onClick={(e) => { e.stopPropagation(); openTicket(p.key); }} className="rounded-md bg-secondary px-1.5 text-[0.95em] hover:bg-accent">{p.name}</button>));
}

export { Tag, Key, Empty, StatTile, Section, type Tone } from './Layout';
