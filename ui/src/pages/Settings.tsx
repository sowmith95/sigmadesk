import { useEffect, useRef, useState } from 'react';
import { S, api, toast, setView, openSheet } from '@/store.js';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SwitchRow } from '@/components/desk/Fields';
import { SeatAvatar, Section } from '@/components/desk/Bits';
import { ChoiceChips } from '@/components/desk/Choices';

function NumberSetting({ k, label, hint, step = 1 }: { k: string; label: string; hint: string; step?: number }) {
  const [v, setV] = useState<string>(S.settings[k] ?? '');
  const seen = useRef(S.settings[k]);
  useEffect(() => { if (S.settings[k] !== seen.current) { seen.current = S.settings[k]; setV(S.settings[k] ?? ''); } });
  const save = async () => {
    if (String(v) === String(S.settings[k])) return;
    try { await api('POST', '/api/settings', { key: k, value: String(v) }); toast('Saved'); } catch (e) { toast((e as Error).message, true); setV(S.settings[k] ?? ''); }
  };
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <label htmlFor={`set-${k}`} className="grid gap-0.5"><b className="font-medium">{label}</b><span className="text-[13px] text-muted-foreground">{hint}</span></label>
      <Input id={`set-${k}`} type="number" inputMode="decimal" min={k === 'daily_budget_usd' ? 0 : 1} step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} className="w-28 shrink-0 text-right font-mono" />
    </div>
  );
}
const Bool = ({ k, label, hint }: { k: string; label: string; hint: string }) => (
  <div className="py-3"><SwitchRow label={label} hint={hint} checked={S.settings[k] === 'true'} onChange={async (on) => { try { await api('POST', '/api/settings', { key: k, value: String(on) }); toast('Saved'); } catch (e) { toast((e as Error).message, true); } }} /></div>
);
const Group = ({ children }: { children: React.ReactNode }) => <div className="divide-y rounded-lg border bg-card px-4">{children}</div>;

export default function SettingsPage() {
  const progs = S.meta.research?.programs || [];
  return (
    <div className="grid max-w-3xl gap-8">
      <Section title="Limits"><Group>
        <NumberSetting k="daily_budget_usd" label="Daily spend limit (USD)" hint="Notional model spend per day." step={5} />
        <NumberSetting k="max_concurrent" label="Seats at once" hint="A market-hours window in the config can lower this." />
        <Bool k="auto_fallback" label="Provider fallback" hint="When one provider is low or down, seats use another. Limits and gates still apply." />
      </Group></Section>
      <Section title="Grooming"><Group>
        <div className="grid gap-3 py-3">
          <div className="grid gap-0.5"><b className="font-medium">Morgan grooms on</b><span className="text-[13px] text-muted-foreground">Grooming reads the repository and turns requests into tasks. Codex reads the code directly; the seat's own engine is whatever Models per seat sets for Morgan.</span></div>
          <ChoiceChips label="Grooming engine" hideLabel value={S.settings.groom_engine === 'seat' ? 'seat' : 'codex'}
            options={[{ value: 'codex', label: 'Codex' }, { value: 'seat', label: "Morgan's own engine" }]}
            onChange={async (v) => { try { await api('POST', '/api/settings', { key: 'groom_engine', value: v }); toast('Saved'); } catch (e) { toast((e as Error).message, true); } }} />
        </div>
      </Group></Section>
      <Section title="Research"><Group>
        <div className="flex items-center justify-between gap-4 py-3"><div className="grid gap-0.5"><b className="font-medium">Research programs</b><span className="text-[13px] text-muted-foreground">{progs.length ? `${progs.filter((p: { enabled: boolean }) => p.enabled).length} of ${progs.length} running.` : 'None yet.'} Who researches, how often, and who checks their work.</span></div>
          <Button variant="secondary" onClick={() => setView('research')}>Open Research</Button></div>
        <NumberSetting k="max_open_proposals" label="Proposals waiting at most" hint="Research pauses while this many ideas wait for grooming." />
      </Group></Section>
      <Section title="GitHub"><Group>
        <Bool k="github_sync" label="Sync GitHub issues" hint={`Mirror tickets and comments to ${S.meta.repo || 'GitHub'}.`} />
        <Bool k="open_draft_prs" label="Open draft PRs" hint="After QA, push the branch and open a draft PR. Nothing merges automatically." />
      </Group></Section>
      <Section title="Models per seat"><div className="divide-y rounded-lg border bg-card">
        {S.agents.map((a: { id: string; name: string; role: string; engine?: string; model?: string; enabled?: boolean }) => { const r = S.meta.routing?.[a.id] || {}; return (
          <button key={a.id} type="button" onClick={() => openSheet({ type: 'models', id: a.id })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary">
            <SeatAvatar id={a.id} size="md" /><span className="grid min-w-0 flex-1"><b className="truncate">{a.name}</b><span className="truncate text-sm text-muted-foreground">{a.role}</span></span>
            <span className="font-mono text-[13px] text-muted-foreground">{a.enabled === false ? 'off' : `${r.engine || a.engine}${(r.model ?? a.model) ? `, ${r.model ?? a.model}` : ''}`}</span></button>); })}
      </div></Section>
      <p className="text-sm text-muted-foreground">Halt, resume and the breaker are on the Desk page. The <a className="text-primary hover:underline" href="/classic.html">Classic view</a> stays available for architecture reviews and councils.</p>
    </div>
  );
}
