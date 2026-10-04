import { Suspense, lazy, useEffect, useRef } from 'react';
import { deskStatus } from '../../public/attention.js';
import { S, useDesk, currentBoard, setView, openSheet, closeSheet, openTicket } from './store.js';
import { money } from './lib/format.js';
import { IconButton, Sheet, SheetHead } from './kit/index.js';
import { SheetBoundary } from './kit/ErrorBoundary.jsx';
import { Inbox, goInbox } from './views/Inbox.jsx';
import { Work } from './views/Work.jsx';
import { Team } from './views/Team.jsx';
import { TicketSheet } from './sheets/Ticket.jsx';
import { NewTicketSheet, DeskSheet, MoneySheet, SettingsSheet, SeatSheet } from './sheets/Desk.jsx';
import { ModelsSheet } from './sheets/Models.jsx';

const ResearchSheet = lazy(() => import('./research/ResearchSheet.jsx'));
const PrsSheet = lazy(() => import('./sheets/Prs.jsx').then((m) => ({ default: m.PrsSheet })));
const PrSheet = lazy(() => import('./sheets/Prs.jsx').then((m) => ({ default: m.PrSheet })));

function Instruments() {
  const B = currentBoard();
  const c = B.counts;
  const spend = Number(S.meta.spend_today) || 0, limit = Number(S.settings.daily_budget_usd) || 0;
  const desk = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting' } : deskStatus(S);
  const Inst = ({ cls, label, value, onClick, title }) => (
    <button className={`inst ${cls}`} type="button" onClick={onClick} title={title} aria-label={title}><span className="inst-v">{value}</span><span className="inst-l">{label}</span></button>
  );
  return (
    <div className="instruments" role="group" aria-label="Desk status">
      <Inst cls={c.needs_you ? 'amber' : ''} label="Needs you" value={String(c.needs_you)} onClick={() => goInbox('sec-needs', setView)} title={`${c.needs_you} decision${c.needs_you === 1 ? '' : 's'} waiting for you`} />
      <Inst cls={c.blocked ? 'red' : ''} label="Blocked" value={String(c.blocked)} onClick={() => goInbox('sec-blocked', setView)} title={`${c.blocked} blocked`} />
      <Inst cls={`money ${limit && spend / limit > 0.9 ? 'amber' : ''}`} label={limit ? <span>of ${limit.toFixed(0)}<span className="wide-only"> today</span></span> : 'spent today'}
        value={<span className="mono">{money(spend)}</span>} onClick={() => openSheet({ type: 'money' })} title={`${money(spend)} spent of a ${money(limit)} daily limit. Open spend and provider quota`} />
      <Inst cls={`desk tone-${desk.tone}`} label="Desk" value={<span><i className="dot" aria-hidden="true" />{desk.label}</span>} onClick={() => openSheet({ type: 'desk' })} title={`Desk ${desk.label}: ${desk.detail}`} />
    </div>
  );
}

function Banner() {
  const held = (S.meta.providers || []).filter((p) => p.available && !p.ready);
  const msg = S.loadError ? `Can't load the desk: ${S.loadError}` : !S.connected && S.loaded ? 'Reconnecting. Updates resume automatically.'
    : S.meta.preview ? 'Local preview — execution is disabled here.' : held.length ? held.map((p) => `${p.label}: ${p.reason || 'on hold'}`).join(' · ') : '';
  return <div id="banner" data-bg className={`banner ${S.loadError || (!S.connected && S.loaded) ? 'bad' : ''}`} role="status" hidden={!msg}>{msg}</div>;
}

function SheetHost() {
  const sh = S.sheet;
  if (!sh) return null;
  const key = `${sh.type}:${sh.key || sh.id || sh.number || ''}:${sh.nonce || ''}`;
  const body = {
    ticket: <TicketSheet key={key} />, new: <NewTicketSheet key={key} />, desk: <DeskSheet key={key} />, money: <MoneySheet key={key} />,
    settings: <SettingsSheet key={key} />, seat: <SeatSheet key={key} />, models: <ModelsSheet key={key} id={sh.id} />,
    research: <ResearchSheet key={key} />, prs: <PrsSheet key={key} />, pr: <PrSheet key={key} />,
  }[sh.type];
  // The fallback is a real sheet, so Close, Escape and the inert background work while a lazy panel loads.
  const loading = <Sheet label="Loading" onClose={closeSheet} head={<SheetHead title="Loading…" onClose={closeSheet} />}><p className="muted">Opening…</p></Sheet>;
  return <SheetBoundary sheetKey={key}><Suspense fallback={loading}>{body}</Suspense></SheetBoundary>;
}

export function App() {
  useDesk();
  const hdr = useRef(null);
  const B = currentBoard();
  useEffect(() => {
    document.documentElement.style.setProperty('--hdr-h', `${hdr.current?.offsetHeight || 0}px`);
    if (S.loaded) { for (const it of B.needs_you) S.seen.add(it.id); S.painted = true; }
  });
  useEffect(() => {
    // A shared link to #KEY opens that ticket once the desk has loaded.
    if (S.loaded && !S.sheet && /^#[A-Z][A-Z0-9]*-\d+$/.test(location.hash)) openTicket(location.hash.slice(1));
  }, [S.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = B.counts.needs_you;
  const tab = (v, label) => <button type="button" aria-current={S.view === v ? 'page' : 'false'} onClick={() => setView(v)}>{label}{v === 'inbox' && n > 0 && <span className="tab-n">{n}</span>}</button>;
  return (
    <>
      <a className="skip" href="#view" data-bg>Skip to content</a>
      <header className="hdr" ref={hdr} data-bg>
        <div className="hdr-row">
          <div className="brand"><span className="sigma" aria-hidden="true">σ</span><span className="brand-name">SigmaDesk</span><span className="project">{S.meta.project || ''}</span></div>
          <nav className="tabs" aria-label="Views">{tab('inbox', 'Inbox')}{tab('work', 'Work')}{tab('team', 'Team')}</nav>
          <div className="hdr-actions">
            <button className="btn primary" id="btn-new" type="button" aria-label="New ticket" onClick={() => openSheet({ type: 'new' })}><span aria-hidden="true">+</span><span className="lbl">New ticket</span></button>
            <IconButton id="btn-gear" label="Settings" onClick={() => openSheet({ type: 'settings' })}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm8.2 4.6-.1-1.2 1.9-1.5-1.9-3.3-2.3.8a7 7 0 0 0-2-1.2L15.4 4h-3.8l-.4 2.4a7 7 0 0 0-2 1.2l-2.3-.8L5 10.1 7 11.6a7 7 0 0 0 0 2.4l-2 1.5 1.9 3.3 2.3-.8a7 7 0 0 0 2 1.2l.4 2.4h3.8l.4-2.4a7 7 0 0 0 2-1.2l2.3.8 1.9-3.3-1.9-1.5.1-1.2Z" /></svg>
            </IconButton>
          </div>
        </div>
        <Instruments />
      </header>
      <Banner />
      <main id="view" tabIndex={-1} data-view={S.view} data-bg>
        {!S.loaded && !S.loadError ? <p className="muted pad">Loading the desk…</p> : S.view === 'work' ? <Work /> : S.view === 'team' ? <Team /> : <Inbox setView={setView} />}
      </main>
      <SheetHost />
      {S.toasts[0] && <div className={`toast ${S.toasts[0].err ? 'err' : ''}`} role="status" aria-live="polite">{S.toasts[0].msg}</div>}
    </>
  );
}
export { closeSheet };
