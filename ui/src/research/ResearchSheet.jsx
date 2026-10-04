import { useEffect, useState } from 'react';
import { S, closeSheet, loadResearch, api, loadSnapshot } from '../store.js';
import { TEMPLATES, fromTemplate, blankDraft } from '../lib/programs.js';
import { Sheet, SheetHead, AsyncButton } from '../kit/index.js';
import { ProgramCard, ProgramEditor } from './ProgramCard.jsx';
import { Connectors } from './Connectors.jsx';

export default function ResearchSheet() {
  const [editing, setEditing] = useState(null); // { id, row } for an existing program, or { draft } for a new one
  useEffect(() => { loadResearch(); }, []);
  const r = S.research;
  const data = r?.data;
  const head = <SheetHead title="Research" sub="Who researches, how often, and who checks their work before anything is built." onClose={closeSheet} />;
  if (!data) return <Sheet label="Research" onClose={closeSheet} head={head}><p className="muted">{r?.error || 'Loading research programs…'}</p></Sheet>;
  const saved = data.programs;
  const opts = { takenIds: saved.map((p) => p.id), defaultReview: data.default_review, seats: S.agents.map((a) => a.id) };
  const market = data.market_hours;
  return (
    <Sheet label="Research" onClose={closeSheet} head={head}>
      <p className="rs-market"><i className={`dot ${market.open_now ? '' : ''}`} style={{ background: market.open_now ? 'var(--green)' : 'var(--steel)' }} aria-hidden="true" />
        Market {market.open_now ? 'open' : 'closed'} · {market.start}–{market.end} {market.timezone.replace('_', ' ')}</p>
      {data.problems?.length > 0 && <p className="warn">{data.problems.join(' ')}</p>}
      {!data.configured && <p className="muted small">These programs come from the configuration until you save one here.</p>}
      <section className="rs-section" aria-labelledby="h-programs">
        <h3 id="h-programs">Programs</h3>
        {saved.map((p) => <ProgramCard key={p.id} program={p} saved={saved} editing={editing?.id === p.id ? editing.row : null}
          onEdit={(row) => setEditing({ id: p.id, row })} onClose={() => setEditing(null)} />)}
        {editing?.draft ? <article className="program"><p className="program-sentence">New program</p>
          <ProgramEditor isNew initial={editing.draft} saved={saved} onClose={() => setEditing(null)} /></article>
          : <>
            <h4>Add a program</h4>
            <div className="templates">
              {TEMPLATES.map((t) => <button key={t.id} type="button" className="template" onClick={() => setEditing({ draft: fromTemplate(t, opts) })}><b>{t.label}</b><span>{t.blurb}</span></button>)}
              <button type="button" className="template" onClick={() => setEditing({ draft: blankDraft(opts) })}><b>Start blank</b><span>Pick every setting yourself</span></button>
            </div>
          </>}
        {data.configured && <div className="row-actions"><AsyncButton variant="ghost" size="small" confirm="Discard saved programs and return to the configuration defaults?"
          run={async () => { await api('POST', '/api/research/programs/reset', {}); setEditing(null); await Promise.all([loadResearch(), loadSnapshot().catch(() => {})]); }} ok="Programs reset to the configuration">Reset to configuration</AsyncButton></div>}
      </section>
      <Connectors />
    </Sheet>
  );
}
