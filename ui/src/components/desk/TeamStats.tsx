// How each seat does on the work it builds, and how the desk assigns work. A table on wide screens, one card per seat
// on phones. Small samples are marked: two tasks say little about a seat.
import { S, api, loadSnapshot, toast } from '@/store.js';
import { money } from '@/lib/format.js';
import { Tag, SeatAvatar } from './Bits';
import { ChoiceChips } from './Choices';
import type { Agent } from '@/types';

type Cohort = { built: number; shipped: number; qa_first: number; qa_first_pass: number; first_pass_rate: number | null; review_rounds: number | null;
  cost_per_shipped: number | null; cost_n: number; cycle_min: number | null; few: boolean; interval?: [number, number] | null; band?: string | null;
  rest_rate?: number | null; excluded?: Record<string, number>; models?: Record<string, { qa_first: number; qa_first_pass: number }> };
type SeatStats = { all: Cohort; S: Cohort; 'M+': Cohort; builds_14d: number; busy_hours_7d: number };
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const dur = (m: number | null) => (m == null ? '—' : m < 90 ? `${Math.round(m)} min` : m < 60 * 36 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);

// First-try QA per size: small and medium work are different jobs, so they are never blended into one figure. The band
// compares the seat with the rest of the team on the same size; with few verdicts it says so instead of guessing.
const BAND: Record<string, string> = { too_early: 'too early to tell', inconclusive: 'no clear difference', above: 'above the team', below: 'below the team', no_comparison: 'nobody else to compare with' };
const BAND_TONE: Record<string, string> = { above: 'text-shipped', below: 'text-blocked' };
const range = (c: Cohort) => (c.interval ? `likely ${pct(c.interval[0])}–${pct(c.interval[1])}` : '');
function Qa({ c, label }: { c: Cohort; label: string }) {
  if (!c.qa_first) return null;
  return <span className="block" title={`${range(c)}${c.rest_rate != null ? `; rest of the team ${pct(c.rest_rate)}` : ''}`}>
    {label} {pct(c.first_pass_rate)} <span className="text-muted-foreground">({c.qa_first_pass}/{c.qa_first})</span>
    {c.band && <span className={BAND_TONE[c.band] || 'text-muted-foreground'}>, {BAND[c.band]}</span>}</span>;
}
const bySize = (s: SeatStats) => (s.S.qa_first || s['M+'].qa_first ? <><Qa c={s.S} label="small" /><Qa c={s['M+']} label="medium" /></> : '—');
const excluded = (s: SeatStats) => Object.entries(s.all.excluded || {}).map(([r, n]) => `${n} ${({ spec: 'unclear ticket', base: 'broken base', flaky: 'flaky test' } as Record<string, string>)[r] || r}`).join(', ');
const models = (s: SeatStats) => Object.entries(s.all.models || {}).map(([m, v]) => `${m.replace(':', ' ')} ${v.qa_first_pass}/${v.qa_first}`).join(', ');
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
            {excluded(s) && <><dt className="text-muted-foreground">Not counted</dt><dd>{excluded(s)}</dd></>}
            {models(s) && <><dt className="text-muted-foreground">Ran on</dt><dd className="[overflow-wrap:anywhere]">{models(s)}</dd></>}
            <dt className="text-muted-foreground">Cost per shipped</dt><dd>{cost(s)}</dd>
            <dt className="text-muted-foreground">Cycle time</dt><dd>{dur(s.all.cycle_min)}</dd>
            <dt className="text-muted-foreground">Busy, 7 days</dt><dd>{s.busy_hours_7d.toFixed(1)} h</dd>
          </dl>
        </li>); })}</ul>
      <details className="text-sm max-md:hidden"><summary className="cursor-pointer text-muted-foreground">Not counted and models</summary>
        <ul className="mt-2 grid gap-1">{builders.map((a) => { const s = stats?.seats[a.id] || empty; return (excluded(s) || models(s)) ? <li key={a.id}><b>{a.name}</b>: {[excluded(s) && `not counted: ${excluded(s)}`, models(s) && `ran on ${models(s)}`].filter(Boolean).join('; ')}</li> : null; })}</ul></details>
      <p className="text-[13px] text-muted-foreground">Bands compare each seat with the rest of the team on the same size of work, and say "too early" until there are 15 verdicts. Failures QA put down to an unclear ticket, a broken base branch or a flaky test are not counted against the builder. First-try QA is the first QA verdict on each task the seat built, by task size. Shipped means merged. Cycle time runs from the first build to the merge. Cost is the average per merged task, counting only runs with a measured cost.</p>
    </section>
  );
}
