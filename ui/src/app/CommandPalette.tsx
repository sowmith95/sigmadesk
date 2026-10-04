// ⌘K / Ctrl+K: go to any page, open any ticket by name or key, start a new ticket. Navigation only; desk controls
// (halt, breaker, running research) stay on their pages where their consequences are explained.
import { nameOf } from '../../../public/names.js';
import { Lightbulb, Plus } from 'lucide-react';
import { S, setPalette, setView, openTicket, openSheet, openFeature, currentBoard } from '@/store.js';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { NAV } from './Shell';
import { STAGE_LABEL } from '@/components/desk/Work';
import type { Board, Ticket } from '@/types';

export function CommandPalette() {
  const B = currentBoard() as Board;
  const open = S.palette;
  const go = (fn: () => void) => () => { setPalette(false); fn(); };
  const decisions = B.needs_you.filter((x) => x.ticket);
  const tickets = (S.tickets as Ticket[]).filter((t) => !['done', 'wontdo'].includes(t.status)).slice(0, 200);
  return (
    <CommandDialog open={open} onOpenChange={setPalette} title="Find or do something" description="Go to a page, open a ticket, or create one.">
      <CommandInput placeholder="Type a page, a ticket name or key…" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>Nothing matches. Try a ticket key such as SD-12.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={go(() => openSheet({ type: 'new-feature' }))}><Lightbulb />New feature (plan with Codex)</CommandItem>
          <CommandItem onSelect={go(() => openSheet({ type: 'new' }))}><Plus />New ticket</CommandItem>
        </CommandGroup>
        {decisions.length > 0 && <CommandGroup heading="Needs you">
          {decisions.map((it) => <CommandItem key={it.id} value={`${it.verb} ${it.key}`} onSelect={go(() => (it.kind === 'plan' ? openFeature(it.key) : openTicket(it.key, { decision: it.id })))}>{it.verb}<CommandShortcut>{it.key}</CommandShortcut></CommandItem>)}
        </CommandGroup>}
        <CommandGroup heading="Pages">
          {NAV.map(({ page, label, icon: Icon }) => <CommandItem key={page} value={`page ${label}`} onSelect={go(() => setView(page))}><Icon />{label}</CommandItem>)}
        </CommandGroup>
        <CommandGroup heading="Tickets">
          {tickets.map((t) => <CommandItem key={t.key} value={`${nameOf(t)} ${t.title} ${t.key}`} onSelect={go(() => (t.type === 'feature' && !t.parent_key ? openFeature(t.key) : openTicket(t.key)))}>
            <span className="truncate">{nameOf(t)}</span><span className="ml-2 truncate text-muted-foreground">{STAGE_LABEL[t.status] || t.status}</span><CommandShortcut>{t.key}</CommandShortcut></CommandItem>)}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
