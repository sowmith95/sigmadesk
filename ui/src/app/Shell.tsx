import { useEffect, type ReactNode } from 'react';
import { Inbox, KanbanSquare, Users, FlaskConical, GitPullRequest, Activity, Settings, Plus, Search } from 'lucide-react';
import { deskStatus } from '../../../public/attention.js';
import { S, currentBoard, setView, setPalette, openSheet } from '@/store.js';
import { money } from '@/lib/format.js';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Board } from '@/types';
import type { Page } from './router';

export const NAV: { page: Page; label: string; icon: typeof Inbox; primary?: boolean }[] = [
  { page: 'inbox', label: 'Inbox', icon: Inbox, primary: true }, { page: 'work', label: 'Work', icon: KanbanSquare, primary: true },
  { page: 'team', label: 'Team', icon: Users, primary: true }, { page: 'research', label: 'Research', icon: FlaskConical },
  { page: 'prs', label: 'Pull requests', icon: GitPullRequest }, { page: 'desk', label: 'Desk', icon: Activity }, { page: 'settings', label: 'Settings', icon: Settings },
];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Rail({ needs }: { needs: number }) {
  return (
    <nav aria-label="Pages" className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col gap-1 border-r bg-card px-2 py-3 md:flex xl:w-52">
      <div className="mb-3 flex items-baseline gap-2 px-2.5"><span aria-hidden className="text-2xl font-semibold leading-none text-primary">σ</span><span className="hidden text-[15px] font-semibold xl:inline">SigmaDesk</span></div>
      {NAV.map(({ page, label, icon: Icon }, i) => {
        const active = S.view === page;
        const item = (
          <button key={page} type="button" onClick={() => setView(page)} aria-current={active ? 'page' : undefined}
            className={cn('relative flex h-10 items-center gap-3 rounded-md px-2.5 text-[15px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground', active && 'bg-secondary text-foreground', i === 3 && 'mt-4')}>
            <Icon className="size-5 shrink-0" aria-hidden /><span className="hidden xl:inline">{label}</span>
            {page === 'inbox' && needs > 0 && <span className="absolute left-7 top-1 rounded-full bg-needs px-1.5 font-mono text-[11px] font-semibold text-background xl:static xl:ml-auto">{needs}</span>}
            <span className="sr-only xl:hidden">{label}</span>
          </button>
        );
        return <Tooltip key={page}><TooltipTrigger asChild>{item}</TooltipTrigger><TooltipContent side="right" className="xl:hidden">{label}</TooltipContent></Tooltip>;
      })}
    </nav>
  );
}

function MobileTabs({ needs }: { needs: number }) {
  const more = !['inbox', 'work', 'team'].includes(S.view);
  return (
    <nav aria-label="Pages" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 gap-1 border-t bg-card/95 px-2 pb-[calc(env(safe-area-inset-bottom)+6px)] pt-1.5 backdrop-blur md:hidden">
      {NAV.filter((n) => n.primary).map(({ page, label, icon: Icon }) => (
        <button key={page} type="button" onClick={() => setView(page)} aria-current={S.view === page ? 'page' : undefined}
          className={cn('relative grid min-h-12 place-items-center gap-0.5 rounded-md text-xs font-medium text-muted-foreground', S.view === page && 'bg-secondary text-foreground')}>
          <Icon className="size-5" aria-hidden />{label}
          {page === 'inbox' && needs > 0 && <span className="absolute right-[calc(50%-22px)] top-1 rounded-full bg-needs px-1.5 font-mono text-[11px] font-semibold text-background">{needs}</span>}
        </button>
      ))}
      <button type="button" onClick={() => setPalette(true)} aria-current={more ? 'page' : undefined}
        className={cn('grid min-h-12 place-items-center gap-0.5 rounded-md text-xs font-medium text-muted-foreground', more && 'bg-secondary text-foreground')}>
        <Search className="size-5" aria-hidden />More
      </button>
    </nav>
  );
}

/** One line of desk facts; each is a link to where you act on it. Replaces the four large instrument tiles. */
function StatusStrip({ B }: { B: Board }) {
  const c = B.counts;
  const spend = Number(S.meta.spend_today) || 0, limit = Number(S.settings.daily_budget_usd) || 0;
  const desk = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting' } : deskStatus(S);
  const held = (S.meta.providers || []).filter((p: { available: boolean; ready: boolean }) => p.available && !p.ready);
  const note = S.loadError ? `Can't load the desk: ${S.loadError}` : !S.connected && S.loaded ? 'Reconnecting; updates resume automatically.'
    : S.meta.preview ? 'Local preview: execution is disabled.' : held.length ? held.map((p: { label: string; reason?: string }) => `${p.label}: ${p.reason || 'on hold'}`).join(' · ') : '';
  const dot = { green: 'bg-shipped', amber: 'bg-needs', red: 'bg-blocked' }[desk.tone as string] || 'bg-muted-foreground';
  const item = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-secondary whitespace-nowrap';
  return (
    <div role="group" aria-label="Desk status" className="flex flex-wrap items-center gap-x-1 gap-y-0 px-3 py-1.5 md:px-5">
      <button type="button" className={cn(item, c.needs_you && 'text-needs')} onClick={() => setView('inbox')}><b className="font-mono font-semibold tabular">{c.needs_you}</b> need you</button>
      <button type="button" className={cn(item, c.blocked && 'text-blocked')} onClick={() => setView('inbox')}><b className="font-mono font-semibold tabular">{c.blocked}</b> blocked</button>
      <button type="button" className={item} onClick={() => setView('desk')} title="Spend today against the daily limit"><b className="font-mono font-medium tabular">{money(spend)}</b><span className="text-muted-foreground">of {money(limit)} today</span></button>
      <button type="button" className={item} onClick={() => setView('desk')} title={`Desk ${desk.label}: ${desk.detail}`}><span className={cn('size-2 rounded-full', dot)} aria-hidden />{desk.label}</button>
      {note && <p role="status" className={cn('px-2 text-sm md:ml-2 md:truncate text-muted-foreground', (S.loadError || (!S.connected && S.loaded)) && 'text-blocked')}>{note}</p>}
    </div>
  );
}

export function Shell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const B = currentBoard() as Board;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(!S.palette); }
      else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName) && !S.sheet) { e.preventDefault(); setPalette(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="flex min-h-dvh">
      {/* Not a hash link: hashes are routes here. */}
      <button type="button" onClick={() => document.getElementById('main')?.focus()} className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">Skip to content</button>
      <Rail needs={B.counts.needs_you} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur max-md:bg-background max-md:backdrop-blur-none">
          <div className="flex items-center gap-3 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+10px)] md:px-5">
            <span aria-hidden className="text-xl font-semibold text-primary md:hidden">σ</span>
            <h1 className="min-w-0 truncate text-lg font-semibold md:text-xl">{title}</h1>
            <span className="truncate text-sm text-muted-foreground max-md:hidden">{S.meta.project || ''}</span>
            <span className="flex-1" />
            {actions}
            <Button variant="outline" onClick={() => setPalette(true)} className="gap-2 text-muted-foreground max-md:size-10 max-md:p-0" aria-label="Find or do something">
              <Search className="size-4" /><span className="max-md:hidden">Find or do…</span><kbd className="rounded border bg-secondary px-1.5 font-mono text-[11px] max-md:hidden">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </Button>
            <Button onClick={() => openSheet({ type: 'new' })} className="max-md:size-10 max-md:p-0" aria-label="New ticket"><Plus className="size-4" /><span className="max-md:hidden">New ticket</span></Button>
          </div>
          <StatusStrip B={B} />
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-3 pb-[calc(env(safe-area-inset-bottom)+88px)] pt-4 outline-none md:px-6 md:pb-10">{children}</main>
      </div>
      <MobileTabs needs={B.counts.needs_you} />
    </div>
  );
}
