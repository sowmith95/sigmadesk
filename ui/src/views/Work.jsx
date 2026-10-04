import { useState } from 'react';
import { S, currentBoard, openTicket, openSheet, questionFor } from '../store.js';
import { nameOf } from '../../../public/names.js';
import { ago } from '../lib/format.js';
import { Chip, Avatar, Button, Disclosure, KeyTag } from '../kit/index.js';
import { KIND_LABEL, STAGE_LABEL, NowLine, cardFor, firstName, reasonText } from './shared.jsx';

// Filter state outlives view switches, like v2's S.filter.
const saved = { open: false, q: '', assignee: '', closed: false, shippedAll: false };

function WorkCard({ it }) {
  const t = it.ticket;
  if (!t) return <article className="kcard"><div className="kcard-top"><Chip tone="amber">{KIND_LABEL[it.kind] || 'Needs you'}</Chip></div><b>{it.verb}</b>
    <p className="reason small">{it.reason}</p><Button size="small" onClick={() => openSheet({ type: 'desk' })}>{it.action}</Button></article>;
  const card = it.bucket === 'working' ? cardFor(t) : null;
  const kids = it.epic ? S.tickets.filter((k) => k.parent_key === t.key) : [];
  const line = it.bucket === 'needs_you' ? (it.kind === 'question' ? questionFor(t) || it.reason : null) : it.bucket === 'working' && !it.epic ? null : reasonText(it.reason);
  return (
    <article className={`kcard b-${it.bucket}`} data-key={it.id}>
      <button className="kcard-main" type="button" onClick={() => openTicket(t.key, it.bucket === 'needs_you' ? { decision: it.id } : {})}>
        <div className="kcard-top">
          {it.bucket === 'blocked' ? <Chip tone="red">Blocked</Chip> : it.bucket === 'needs_you' ? <Chip tone="amber">{KIND_LABEL[it.kind] || 'Needs you'}</Chip> : null}
          {it.bucket === 'epic' ? <Chip>{it.live ? 'Epic · a slice is running' : 'Epic'}</Chip> : it.stage && it.bucket !== 'shipped' ? <Chip>{it.stage}</Chip> : null}
          <span className="spacer" /><KeyTag k={t.key} />
        </div>
        <b className="kcard-t">{it.name}</b>
        {line && <p className="reason small">{line.length > 170 ? `${line.slice(0, 169).replace(/\s+\S*$/, '')}…` : line}</p>}
        {card && <NowLine card={card} compact />}
        <div className="kcard-f">{t.assignee && <span className="who small"><Avatar id={it.worker || t.assignee} />{firstName(it.worker || t.assignee)}</span>}
          <span className="spacer" />{it.bucket === 'shipped' && <span className="muted small">{ago(t.updated_at)}</span>}</div>
      </button>
      <Button variant="ghost" size="small" onClick={() => openTicket(t.key)}>{it.bucket === 'working' ? 'View live conversation' : 'View conversation'}</Button>
      {kids.length > 0 && <Disclosure id={`epic-${t.key}`} summary={`${kids.length} slice${kids.length === 1 ? '' : 's'}`}>
        <ul className="slices">{kids.map((k) => <li key={k.key}><button className="linkish" type="button" onClick={() => openTicket(k.key)}>{nameOf(k)}</button>
          <Chip tone={k.status === 'done' ? 'green' : ['needs_human', 'ready_for_human'].includes(k.status) ? 'amber' : ''}>{STAGE_LABEL[k.status] || k.status}</Chip></li>)}</ul>
      </Disclosure>}
    </article>
  );
}

export function Work() {
  const B = currentBoard();
  const [f, setF] = useState(saved);
  const set = (patch) => { Object.assign(saved, patch); setF({ ...saved }); };
  const filtering = Boolean(f.q.trim() || f.assignee);
  const matches = (it) => {
    const t = it.ticket;
    if (!t) return !f.q && !f.assignee;
    if (f.assignee && t.assignee !== f.assignee) return false;
    const q = f.q.trim().toLowerCase();
    return !q || `${t.key} ${it.name} ${t.title}`.toLowerCase().includes(q);
  };
  const eng = S.agents.filter((a) => (S.meta.engineers || []).includes(a.id));
  const lanes = [
    ['wait', 'Waiting on you', B.needs_you, B.counts.needs_you, 'amber'],
    ['working', 'Working', B.working, B.counts.working, ''],
    ['queued', 'Queued', [...B.blocked, ...B.queued], B.counts.blocked + B.counts.queued, ''],
    ['shipped', 'Shipped', B.shipped, B.counts.shipped, 'green'],
  ];
  const epics = B.epics.filter(matches);
  return (
    <>
      <div className="toolbar"><h1 className="page-h">Work</h1><span className="spacer" />
        <Button onClick={() => openSheet({ type: 'prs' })}>Pull requests</Button>
        <Button variant={filtering ? 'on' : undefined} aria-expanded={f.open} aria-controls="filters" onClick={() => set({ open: !f.open })}>{filtering ? 'Filter · on' : 'Filter'}</Button></div>
      {f.open && <div className="filters" id="filters">
        <input id="work-q" type="search" placeholder="Search by name or key" aria-label="Search tickets" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <select id="work-assignee" aria-label="Assignee" value={f.assignee} onChange={(e) => set({ assignee: e.target.value })}>
          <option value="">Anyone</option>{eng.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <label className="check"><input id="work-closed" type="checkbox" checked={f.closed} onChange={(e) => set({ closed: e.target.checked })} />Show closed ({B.counts.closed})</label>
        {filtering && <Button variant="ghost" onClick={() => set({ q: '', assignee: '' })}>Clear</Button>}
      </div>}
      <div className="lanes">{lanes.map(([id, title, items, count, tone]) => {
        let list = items.filter(matches);
        const more = id === 'shipped' && !f.shippedAll && !filtering && list.length > 5 ? list.length - 5 : 0;
        if (more) list = list.slice(0, 5);
        return (
          <section key={id} className={`lane lane-${id}`} aria-labelledby={`lane-${id}`}>
            <h2 id={`lane-${id}`}>{title}<span className={`count ${count ? tone : ''}`}>{filtering ? `${list.length} of ${count}` : count}</span></h2>
            <div className="lane-b">
              {list.length ? list.map((it) => <WorkCard key={it.id} it={it} />)
                : <p className="muted pad">{filtering ? 'No matches.' : { wait: 'Nothing waiting on you.', working: 'No seat is running.', queued: 'Queue is empty.' }[id] || 'Nothing shipped yet.'}</p>}
              {more > 0 && <Button variant="ghost" size="wide" onClick={() => set({ shippedAll: true })}>View all {count}</Button>}
              {id === 'shipped' && f.shippedAll && !filtering && count > 5 && <Button variant="ghost" size="wide" onClick={() => set({ shippedAll: false })}>Show latest 5</Button>}
              {id === 'shipped' && f.closed && <><h3 className="sub-h">Closed ({B.counts.closed})</h3>{B.closed.filter(matches).map((it) => <WorkCard key={it.id} it={it} />)}</>}
            </div>
          </section>
        );
      })}</div>
      {B.epics.length > 0 && <section className="sec epics" aria-labelledby="h-epics"><h2 id="h-epics">Epics<span className="count">{filtering ? `${epics.length} of ${B.epics.length}` : B.epics.length}</span></h2>
        <div className="grid-cards">{epics.map((it) => <WorkCard key={it.id} it={it} />)}</div></section>}
    </>
  );
}
