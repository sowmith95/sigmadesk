import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react';
import { S, useDesk, currentBoard, closeSheet } from '@/store.js';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/desk/Panel';
import { Shell } from '@/app/Shell';
import { InboxPage } from '@/pages/Inbox';
import { WorkPage } from '@/pages/Work';
import { TeamPage } from '@/pages/Team';
import { TicketSheet } from '@/ticket/TicketSheet';
import type { Board } from '@/types';

// Not needed for first paint: loaded on first use.
const CommandPalette = lazy(() => import('@/app/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const NewTicketDialog = lazy(() => import('@/app/Panels').then((m) => ({ default: m.NewTicketDialog })));
const SeatPanel = lazy(() => import('@/app/Panels').then((m) => ({ default: m.SeatPanel })));
const ModelsPanel = lazy(() => import('@/app/Panels').then((m) => ({ default: m.ModelsPanel })));
const ResearchPage = lazy(() => import('@/pages/Research'));
const PrsPage = lazy(() => import('@/pages/Prs'));
const PrPanel = lazy(() => import('@/pages/Prs').then((m) => ({ default: m.PrPanel })));
const DeskPage = lazy(() => import('@/pages/Desk'));
const SettingsPage = lazy(() => import('@/pages/Settings'));

const TITLES: Record<string, string> = { inbox: 'Inbox', work: 'Work', team: 'Team', research: 'Research', prs: 'Pull requests', desk: 'Desk', settings: 'Settings' };

/** A part that cannot render (most often: the desk was updated and this tab asks for a replaced chunk) offers a reload. */
class Boundary extends Component<{ children: ReactNode; resetKey: string; inPanel?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    const stale = /dynamically imported module|Failed to fetch|Importing a module script failed|chunk/i.test(String(this.state.error.message));
    const body = <div className="grid gap-3"><p>{stale ? 'A newer version of the desk is running. Reload to continue; reply drafts are kept.' : `This part could not open: ${this.state.error.message}.`}</p>
      <div className="flex gap-2"><Button onClick={() => location.reload()}>Reload the desk</Button><Button variant="ghost" asChild><a href="/classic.html">Open the Classic view</a></Button></div></div>;
    return this.props.inPanel ? <Panel title={stale ? 'The desk was updated' : 'Could not open'} onClose={closeSheet}>{body}</Panel> : body;
  }
}
const Loading = () => <p className="text-muted-foreground">Loading…</p>;

function Overlay() {
  const sh = S.sheet;
  if (!sh) return null;
  const key = `${sh.type}:${sh.key || sh.id || sh.number || ''}:${sh.nonce || ''}`;
  const node = ({ ticket: <TicketSheet key={key} />, new: <NewTicketDialog key={key} />, seat: <SeatPanel key={key} />, models: <ModelsPanel key={key} id={sh.id!} />, pr: <PrPanel key={key} /> } as Record<string, ReactNode>)[sh.type] ?? null;
  return <Boundary resetKey={key} inPanel><Suspense fallback={<Panel title="Loading…" onClose={closeSheet}><Loading /></Panel>}>{node}</Suspense></Boundary>;
}

export function App() {
  useDesk();
  const B = currentBoard() as Board;
  useEffect(() => { if (S.loaded) { for (const it of B.needs_you) S.seen.add(it.id); S.painted = true; } });
  const page = S.view as string;
  const content = !S.loaded && !S.loadError ? <Loading />
    : ({ inbox: <InboxPage />, work: <WorkPage />, team: <TeamPage />, research: <ResearchPage />, prs: <PrsPage />, desk: <DeskPage />, settings: <SettingsPage /> } as Record<string, ReactNode>)[page] ?? <InboxPage />;
  return (
    <TooltipProvider delayDuration={300}>
      <Shell title={TITLES[page] || 'Inbox'}><Boundary resetKey={page}><Suspense fallback={<Loading />}>{content}</Suspense></Boundary></Shell>
      <Overlay />
      {S.palette && <Suspense fallback={null}><CommandPalette /></Suspense>}
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}
