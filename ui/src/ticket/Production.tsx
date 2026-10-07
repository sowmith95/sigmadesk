// Post-deploy watch on a ticket (#7): Merged → Deployed (workflow, time) → Verified ✓ / Watching / Regression ⚠, the
// ticket's "How to verify in production" criteria, and the owner's one action when a regression holds the train.
import { useEffect, useState } from 'react';
import { S, api, loadSnapshot } from '@/store.js';
import { hhmm } from '@/lib/format.js';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, type Tone } from '@/components/desk/Bits';
import type { Ticket } from '@/types';

type Run = { workflow: string; run_id: number; run_attempt: number; target: string | null; status: string; completed_at: string | null };
type Checkpoint = { id: number; name: string; label: string; due_at: string; status: string; verdict: string | null; limited: boolean; summary: string | null };
type Watch = { id: number; merge_sha: string; deployed_at: string; status: string; note: string | null; hold: boolean; incident_key: string | null; revert_key: string | null;
  workflows: { workflow: string; run_id: number; run_attempt: number }[]; checkpoints: Checkpoint[] };
type View = { criteria: string | null; criteria_by: string | null; trading_path: boolean; criteria_block: string | null; owner_merge_only: boolean; merged_at: string | null;
  nothing_deployed: { merge_sha: string; at: string } | null; deploys: { deploy_key: string; status: string; cleared_by: string | null; runs: Run[] }[]; watches: Watch[] };

const WATCH: Record<string, { label: string; tone: Tone }> = {
  watching: { label: 'Watching', tone: 'neutral' }, verified: { label: 'Verified ✓', tone: 'shipped' }, regression: { label: 'Regression ⚠', tone: 'blocked' },
  inconclusive: { label: 'Inconclusive', tone: 'needs' }, superseded: { label: 'Superseded', tone: 'neutral' },
};
const wf = (r: { workflow: string; run_id: number; run_attempt: number }) => `${r.workflow.split('/').pop()}${r.run_id ? ` #${r.run_id}${r.run_attempt > 1 ? ` (attempt ${r.run_attempt})` : ''}` : ''}`;
const CP_TEXT = (c: Checkpoint) => (c.status === 'done' ? `${c.verdict}${c.verdict === 'verified' && c.limited ? ' (limited)' : ''}` : c.status === 'superseded' ? 'not run (superseded)'
  : c.status === 'needs_sre' || c.status === 'sre_running' ? 'with the SRE' : `due ${hhmm(c.due_at)}`);

export function Production({ t }: { t: Ticket }) {
  const [v, setV] = useState<View | null>(null);
  const live = S.meta?.production;
  // Reload when the desk reports production changes (holds, watches) or the ticket moves.
  const sig = `${t.updated_at}|${JSON.stringify(live?.hold?.map((w: { id: number }) => w.id) || [])}|${JSON.stringify(live?.active?.map((w: { id: number; checkpoints?: Checkpoint[] }) => [w.id, w.checkpoints?.map((c) => c.status)]) || [])}`;
  useEffect(() => {
    let gone = false;
    api('GET', `/api/tickets/${t.key}/production`).then((x) => { if (!gone) setV(x as View); }).catch(() => {});
    return () => { gone = true; };
  }, [t.key, sig]);
  if (!v) return null;
  const merged = t.status === 'done';
  if (!merged && !v.criteria_block && !v.criteria) return null;
  const w = v.watches[v.watches.length - 1] || null;
  const d = v.deploys[v.deploys.length - 1] || null;
  return (
    <section aria-label="Production" className="grid gap-2 rounded-lg border bg-card px-4 py-3" data-production>
      {merged && <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <li><Tag tone="shipped">Merged</Tag>{v.merged_at && <span className="ml-1 text-muted-foreground">{hhmm(v.merged_at)}</span>}</li>
        <li aria-hidden>→</li>
        {v.nothing_deployed && !d ? <li><Tag>Nothing deployed</Tag></li>
          : d ? <li><Tag tone={d.status === 'success' ? 'shipped' : d.status === 'failed' ? 'blocked' : 'needs'}>{d.status === 'success' ? 'Deployed' : d.status === 'failed' ? 'Deploy failed' : 'Deploy unconfirmed'}</Tag>
            <span className="ml-1 text-muted-foreground">{d.runs.map(wf).join(', ')}{d.runs[0]?.completed_at ? ` · ${hhmm(d.runs[0].completed_at)}` : ''}{d.cleared_by ? ' · hold cleared by you' : ''}</span></li>
            : <li><Tag>Deploy not recorded yet</Tag></li>}
        {w && <><li aria-hidden>→</li><li><Tag tone={WATCH[w.status]?.tone || 'neutral'}>{WATCH[w.status]?.label || w.status}</Tag></li></>}
      </ol>}
      {w && <ul className="grid gap-0.5 text-[13px] text-muted-foreground">
        {w.checkpoints.map((c) => <li key={c.id}><span className="text-foreground">{c.label}</span>: {CP_TEXT(c)}{c.summary && c.status === 'done' ? ` — ${c.summary.slice(0, 160)}` : ''}</li>)}
        {w.incident_key && <li>Incident {w.incident_key}{w.revert_key ? ` · revert prepared in ${w.revert_key} (only you merge it)` : ''}</li>}
      </ul>}
      {w?.hold && <div className="flex flex-wrap items-center gap-2"><span className="flex-1 text-sm text-blocked">Deploying merges are held until you clear this.</span>
        <AsyncButton size="sm" confirm="Clear the regression hold? Do this once production is safe: deploying merges continue. The regression verdict stays on record."
          run={async () => { await api('POST', '/api/deploy/regression-hold/clear', { watch_id: w.id }); await loadSnapshot(); }} ok="Regression hold cleared">Clear the hold</AsyncButton></div>}
      {v.criteria ? <p className="text-[13px]"><span className="text-muted-foreground">How to verify in production{v.criteria_by ? ` (${v.criteria_by === 'owner' ? 'you' : v.criteria_by})` : ''}: </span>{v.criteria}</p>
        : v.criteria_block ? <p className="text-[13px] text-blocked">Blocked from merging: {v.criteria_block}.</p>
          : merged ? <p className="text-[13px] text-muted-foreground">No "How to verify in production" criteria: the checks are general health only (limited).</p> : null}
    </section>
  );
}
