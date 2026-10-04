// How each seat does on the work it builds, and how the desk assigns work. A table on wide screens, one card per seat
// on phones. Small samples are marked: two tasks say little about a seat.
import { S, api, loadSnapshot, toast } from '@/store.js';
import { money } from '@/lib/format.js';
import { Tag, SeatAvatar } from './Bits';
import { ChoiceChips } from './Choices';
import type { Agent } from '@/types';

type Cohort = { built: number; shipped: number; qa_first: number; qa_first_pass: number; first_pass_rate: number | null; review_rounds: number | null;
  cost_per_shipped: number | null; cost_n: number; cycle_min: number | null; few: boolean };
type SeatStats = { all: Cohort; S: Cohort; 'M+': Cohort; builds_14d: number; busy_hours_7d: number };
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const dur = (m: number | null) => (m == null ? '—' : m < 90 ? `${Math.round(m)} min` : m < 60 * 36 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);

// First-try QA per size: small and medium work are different jobs, so they are never blended into one figure.
const qa = (c: Cohort) => (c.qa_first ? `${pct(c.first_pass_rate)} (${c.qa_first_pass}/${c.qa_first})` : '—');
const bySize = (s: SeatStats) => [s.S.qa_first && `small ${qa(s.S)}`, s['M+'].qa_first && `medium ${qa(s['M+'])}`].filter(Boolean).join(', ') || '—';
const cost = (s: SeatStats) => (s.all.cost_per_shipped == null ? '—' : `${money(s.all.cost_per_shipped)}${s.all.cost_n < s.all.shipped ? ` (${s.all.cost_n} measured)` : ''}`);
function Cells({ s }: { s: SeatStats }) {
  return <>
    <td className="tabular">{s.all.shipped}<span className="text-muted-foreground"> of {s.all.built}</span></td>
    <td className="tabular">{bySize(s)}</td>
    <td className="tabular">{s.all.review_rounds == null ? '—' : s.all.review_rounds.toFixed(1)}</td>
    <td className="tabular">{dur(s.all.cycle_min)}</td>
    <td className="tabular">{cost(s)}</td>
    <td className="tabular">{s.busy_hours_7d.toFixed(1)} h</td>
  </>;
}

export function TeamStats() {
  const stats = S.meta.team_stats as { seats: Record<string, SeatStats>; as_of: string } | undefined;
  const mode = (S.settings.assign_mode || 'balanced') as 'balanced' | 'fixed';
  const builders = (S.agents as Agent[]).filter((a) => stats?.seats[a.id]?.all.built || ['senior-be', 'senior-fe', 'dba', 'junior'].includes(a.id));
  const none: Cohort = { built: 0, shipped: 0, qa_first: 0, qa_first_pass: 0, first_pass_rate: null, review_rounds: null, cost_per_shipped: null, cost_n: 0, cycle_min: null, few: true };
  const empty: SeatStats = { all: none, S: none, 'M+': none, builds_14d: 0, busy_hours_7d: 0 };
  const setMode = async (v: string) => { try { await api('POST', '/api/settings', { key: 'assign_mode', value: v }); await loadSnapshot(); toast(v === 'balanced' ? 'Balanced assignment on' : 'Fixed assignment on'); } catch (e) { toast((e as Error).message, true); } };
  return (
    <section aria-label="How the team builds" className="grid gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid min-w-0 flex-1 basis-72 gap-1"><b>Who builds what</b>
          <p className="text-sm text-muted-foreground">{mode === 'balanced'
            ? 'Balanced: each task goes to an idle seat that fits it, weighed by first-try QA, cost and engine limits. Fixes and review replies stay with the author.'
            : 'Fixed: each task waits for the one seat its size and area point to, even when another seat is free.'}</p></div>
        <ChoiceChips label="Assignment" hideLabel size="sm" value={mode} onChange={setMode} options={[{ value: 'balanced', label: 'Balanced' }, { value: 'fixed', label: 'Fixed' }]} />
      </div>
      <div className="max-md:hidden overflow-x-auto">
        <table className="w-full text-left text-sm [&_td]:py-2 [&_td]:pr-4 [&_th]:pb-2 [&_th]:pr-4 [&_th]:font-normal [&_th]:text-muted-foreground">
          <thead><tr><th>Seat</th><th>Shipped</th><th>First-try QA</th><th>Review rounds</th><th>Cycle time</th><th>Cost per shipped</th><th>Busy, 7 days</th></tr></thead>
          <tbody className="divide-y">{builders.map((a) => { const s = stats?.seats[a.id] || empty; return (
            <tr key={a.id} data-seat-stats={a.id}><td><span className="inline-flex items-center gap-2"><SeatAvatar id={a.id} />{a.name}<span className="text-muted-foreground">{a.short}</span>{s.all.few && <Tag>Few tasks</Tag>}</span></td><Cells s={s} /></tr>); })}</tbody>
        </table>
      </div>
      <ul className="grid gap-2 md:hidden">{builders.map((a) => { const s = stats?.seats[a.id] || empty; return (
        <li key={a.id} data-seat-stats={a.id} className="grid gap-2 rounded-md bg-secondary/50 p-3">
          <span className="flex items-center gap-2"><SeatAvatar id={a.id} /><b>{a.name}</b><span className="text-sm text-muted-foreground">{a.role}</span>{s.all.few && <Tag>Few tasks</Tag>}</span>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Shipped</dt><dd>{s.all.shipped} of {s.all.built}</dd>
            <dt className="text-muted-foreground">First-try QA</dt><dd>{bySize(s)}</dd>
            <dt className="text-muted-foreground">Cost per shipped</dt><dd>{cost(s)}</dd>
            <dt className="text-muted-foreground">Cycle time</dt><dd>{dur(s.all.cycle_min)}</dd>
            <dt className="text-muted-foreground">Busy, 7 days</dt><dd>{s.busy_hours_7d.toFixed(1)} h</dd>
          </dl>
        </li>); })}</ul>
      <p className="text-[13px] text-muted-foreground">First-try QA is the first QA verdict on each task the seat built, by task size. Shipped means merged. Cycle time runs from the first build to the merge. Cost counts only runs with a measured cost.</p>
    </section>
  );
}
