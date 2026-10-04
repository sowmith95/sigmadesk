import { S, currentBoard, agentMap, openTicket, questionFor, loadPrs } from '../store.js';
import { nameOf } from '../../../public/names.js';
import { ago, clean, waited } from '../lib/format.js';
import { Chip, Avatar, Button, Empty, KeyTag } from '../kit/index.js';
import { KIND_LABEL, CiChip, ReviewsView, prReviewsOf, NowLine, cardFor, Clamp, DecisionButton, firstName, reasonText } from './shared.jsx';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fresh = (it) => S.painted && !S.seen.has(it.id) && !reduced();

function MergeRow({ it }) {
  const t = it.ticket;
  return (
    <article className={`mrow ${fresh(it) ? 'enter' : ''}`} data-key={it.id}>
      <div className="mrow-main">
        <button className="title-btn" type="button" onClick={() => openTicket(t.key, { decision: it.id })}>{it.name}</button>
        <div className="mrow-meta">
          {t.assignee && <span className="who small"><Avatar id={t.assignee} />{firstName(t.assignee)}</span>}
          <CiChip t={t} /><ReviewsView raw={prReviewsOf(t)} compact /><span className="muted small">{ago(t.updated_at)}</span>
        </div>
      </div>
      <DecisionButton it={it} label="Review" aria-label={`Review merge of ${it.name}`} />
    </article>
  );
}

function DecisionCard({ it }) {
  const t = it.ticket;
  const reason = it.kind === 'question' && t ? questionFor(t) || it.reason : it.reason;
  const open = () => openTicket(t.key, { decision: it.id });
  return (
    <article className={`dcard kind-${it.kind} ${fresh(it) ? 'enter' : ''}`} data-key={it.id}>
      <div className="dcard-top"><Chip tone="amber">{KIND_LABEL[it.kind] || 'Needs you'}</Chip>{it.proposal_id && <Chip>Proposal #{it.proposal_id}</Chip>}
        {it.council_id && <Chip>Council #{it.council_id}</Chip>}{t && <KeyTag k={t.key} />}<span className="spacer" />
        <span className="muted small">{waited(t?.updated_at || it.incident?.last_seen)}</span></div>
      <h3>{t ? <button className="title-btn" type="button" onClick={open}>{it.verb}</button> : it.verb}</h3>
      <Clamp id={`reason-${it.id}`} text={clean(reason)} n={300} />
      <div className="dcard-f">{t?.assignee && <span className="who"><Avatar id={t.assignee} />{agentMap()[t.assignee]?.name || ''}</span>}
        <span className="spacer" />{t && <Button variant="ghost" aria-label={`Details for ${it.verb}`} onClick={open}>Details</Button>}<DecisionButton it={it} /></div>
    </article>
  );
}

function BlockedCard({ it }) {
  const t = it.ticket;
  return (
    <article className="bcard" data-key={it.id}>
      <div className="dcard-top"><Chip tone="red">Blocked</Chip>{t && <KeyTag k={t.key} />}<span className="spacer" /><span className="muted small">{ago(t?.updated_at)}</span></div>
      <h3><button className="title-btn" type="button" onClick={() => openTicket(t.key)}>{it.verb}</button></h3>
      <p className="reason">{reasonText(it.reason)}</p>
    </article>
  );
}

export function WorkingCard({ it }) {
  const t = it.ticket;
  const card = cardFor(t);
  const w = it.worker || card?.worker;
  return (
    <button className="wcard" type="button" data-key={it.id} onClick={() => openTicket(t.key)}>
      <div className="wcard-h">{w && <Avatar id={w} size="md" />}
        <div className="wcard-t"><b>{it.name}</b><span className="muted small">{w ? `${agentMap()[w]?.name || ''} · ${it.stage || 'Working'}` : it.stage || ''}</span></div>
        {it.stage && <Chip>{it.stage}</Chip>}</div>
      <NowLine card={card} compact />
    </button>
  );
}

export function goInbox(anchor, setView) {
  setView('inbox');
  requestAnimationFrame(() => {
    const el = anchor ? document.getElementById(anchor) : null;
    if (el) el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    else window.scrollTo(0, 0);
  });
}

export function Inbox({ setView }) {
  const B = currentBoard();
  const c = B.counts;
  if (B.needs_you.some((x) => x.kind === 'merge')) loadPrs();
  const groups = [];
  for (const it of B.needs_you) {
    if (it.kind === 'merge') { const last = groups.at(-1); if (last?.merge) last.items.push(it); else groups.push({ merge: true, items: [it] }); }
    else groups.push({ merge: false, items: [it] });
  }
  const jump = (id, label, n, tone) => <button className={`jump ${n ? tone : ''}`} type="button" onClick={() => goInbox(id, setView)} aria-label={`Jump to ${label}: ${n}`}>{label}<b>{n}</b></button>;
  return (
    <>
      <nav className="jumps" aria-label="Inbox sections">{jump('sec-needs', 'Needs you', c.needs_you, 'amber')}{jump('sec-blocked', 'Blocked', c.blocked, 'red')}{jump('sec-working', 'Working', c.working, '')}</nav>
      <section className="sec" id="sec-needs" aria-labelledby="h-needs">
        <h2 id="h-needs">Needs you{c.needs_you > 0 && <span className="count amber">{c.needs_you}</span>}</h2>
        {c.needs_you ? <div className="stack">{groups.map((g) => (g.merge
          ? <div className="mrows" key={`m-${g.items[0].id}`}>{g.items.map((it) => <MergeRow key={it.id} it={it} />)}</div>
          : <DecisionCard key={g.items[0].id} it={g.items[0]} />))}</div>
          : <Empty title="Nothing needs you.">{c.working} working, {c.queued} queued.</Empty>}
      </section>
      <section className="sec" id="sec-blocked" aria-labelledby="h-blocked">
        <h2 id="h-blocked">Blocked<span className={`count ${c.blocked ? 'red' : ''}`}>{c.blocked}</span></h2>
        {c.blocked ? <div className="stack">{B.blocked.map((it) => <BlockedCard key={it.id} it={it} />)}</div> : <p className="muted pad">Nothing is blocked.</p>}
      </section>
      <section className="sec" id="sec-working" aria-labelledby="h-working">
        <h2 id="h-working">Working<span className="count">{c.working}</span></h2>
        {c.working ? <div className="grid-cards">{B.working.map((it) => <WorkingCard key={it.id} it={it} />)}</div>
          : <p className="muted pad">{S.settings.paused === 'true' ? 'The desk is halted. Resume it from the Desk instrument.' : 'No seat is running right now.'}</p>}
      </section>
    </>
  );
}
export const ticketName = (t) => nameOf(t);
