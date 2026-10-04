import { useEffect, useState } from 'react';
import { S, api, loadResearch, loadSnapshot } from '@/store.js';
import { TEMPLATES, fromTemplate, blankDraft } from '@/lib/programs.js';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Section } from '@/components/desk/Bits';
import { ProgramCard, ProgramEditor } from '@/research/Programs';
import { Connectors } from '@/research/Connectors';
import type { Program } from '@/types';

export default function ResearchPage() {
  const [editing, setEditing] = useState<{ id?: string; row?: string; draft?: unknown } | null>(null);
  useEffect(() => { loadResearch(); }, []);
  const data = S.research?.data;
  if (!data) return <p className="text-muted-foreground">{S.research?.error || 'Loading research programs…'}</p>;
  const saved: Program[] = data.programs;
  const opts = { takenIds: saved.map((p) => p.id), defaultReview: data.default_review, seats: S.agents.map((a: { id: string }) => a.id) };
  const market = data.market_hours;
  return (
    <div className="grid max-w-5xl gap-8">
      <div className="grid gap-1.5">
        <p className="max-w-[68ch] text-muted-foreground">Who researches, how often, and who checks their work before anything is built. Tap any underlined part of a program to change it.</p>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><span aria-hidden className={`size-2 rounded-full ${market.open_now ? 'bg-shipped' : 'bg-muted-foreground'}`} />Market {market.open_now ? 'open' : 'closed'}, {market.start} to {market.end} {market.timezone.replace('_', ' ')}</p>
        {data.problems?.length > 0 && <p className="text-sm text-needs">{data.problems.join(' ')}</p>}
        {!data.configured && <p className="text-sm text-muted-foreground">These programs come from the configuration until you save one here.</p>}
      </div>
      <Section id="programs" title="Programs" count={saved.length}
        actions={data.configured ? <AsyncButton variant="ghost" size="sm" confirm="Discard saved programs and return to the configuration defaults?"
          run={async () => { await api('POST', '/api/research/programs/reset', {}); setEditing(null); await Promise.all([loadResearch(), loadSnapshot().catch(() => {})]); }} ok="Programs reset to the configuration">Reset to configuration</AsyncButton> : null}>
        <div className="grid gap-3">
          {saved.map((p) => <ProgramCard key={p.id} program={p} saved={saved} editingRow={editing?.id === p.id ? editing.row || 'label' : null} onEdit={(row) => setEditing({ id: p.id, row })} onClose={() => setEditing(null)} />)}
          {editing?.draft ? <article className="grid gap-3 rounded-lg border bg-card p-5"><p className="text-xl">New program</p>
            <ProgramEditor isNew initial={editing.draft as never} saved={saved} onClose={() => setEditing(null)} /></article> : null}
        </div>
      </Section>
      {!editing?.draft && <Section title="Add a program">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.filter((t: { seat: string }) => S.agents.some((a: { id: string }) => a.id === t.seat)).map((t: { id: string; label: string; blurb: string }) => <button key={t.id} type="button" onClick={() => setEditing({ draft: fromTemplate(t, opts) })}
            className="grid gap-1 rounded-lg border border-dashed px-4 py-3 text-left hover:border-solid hover:bg-card"><b>{t.label}</b><span className="text-sm text-muted-foreground">{t.blurb}</span></button>)}
          <button type="button" onClick={() => setEditing({ draft: blankDraft(opts) })} className="grid gap-1 rounded-lg border border-dashed px-4 py-3 text-left hover:border-solid hover:bg-card"><b>Start blank</b><span className="text-sm text-muted-foreground">Pick every setting yourself</span></button>
        </div>
      </Section>}
      <Connectors />
    </div>
  );
}
