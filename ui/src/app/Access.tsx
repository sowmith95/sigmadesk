import { useEffect, useRef, useState } from 'react';
import { api, closeSheet, loadSnapshot } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/desk/Panel';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Section } from '@/components/desk/Bits';

type Grant = { id: number; seat: string; seat_name: string; probes: string[]; expires_at: string | null; ticket_key: string | null; run_id: number | null; standing: number; granted_by: string; reason: string | null; created_at: string; revoked_at?: string | null; revoked_by?: string | null };
type Req = { id: number; seat: string; seat_name: string; probes: string[]; why: string; minutes: number | null; ticket_scoped: number; ticket_key: string | null; status: string; approver_name?: string | null; owner_reason?: string | null; decided_by?: string | null; note?: string | null; created_at: string };
type Policy = { approvers: string[]; seats: string[]; probes: string[]; maxMinutes: number; maxActive: number; ticketMaxHours: number; ownerMentionAutoGrant?: boolean; postDeployAutoGrant?: boolean };
type Data = { grants: Grant[]; requests: Req[]; policy: Policy; probes: string[]; seats: { id: string; name: string; role: string }[]; history: { grants: Grant[]; requests: Req[] } };

const probesText = (p: string[]) => (p.includes('*') ? 'all read-only probes' : p.join(', '));
const left = (iso: string | null, now: number) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'ending';
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
};
const span = (g: Grant, now: number) => (g.standing ? 'standing' : g.ticket_key ? `for ${g.ticket_key} · ${left(g.expires_at, now)} at most` : g.run_id ? `this run only · ${left(g.expires_at, now)} at most` : left(g.expires_at, now));
const reqSpan = (r: Req) => (r.ticket_scoped ? (r.ticket_key ? `for ${r.ticket_key}` : 'for one run') : `${r.minutes} min`);
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Gear → Production access: who can read production, for how long; requests; the approver policy; history. */
export function AccessPanel() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [g, setG] = useState({ seat: 'sre', probes: '*', minutes: '60', ticket: '', standing: false, reason: '' });
  const [pol, setPol] = useState<Record<string, string> | null>(null);
  const [edited, setEdited] = useState(false);
  const editedRef = useRef(false);
  const load = () => api('GET', '/api/access').then((x: Data) => { setD(x); if (!editedRef.current) setPol({ approvers: x.policy.approvers.join(', '), seats: x.policy.seats.join(', '), probes: x.policy.probes.join(', '), maxMinutes: String(x.policy.maxMinutes), maxActive: String(x.policy.maxActive), ticketMaxHours: String(x.policy.ticketMaxHours), ownerMentionAutoGrant: x.policy.ownerMentionAutoGrant === false ? 'off' : 'on', postDeployAutoGrant: x.policy.postDeployAutoGrant === true ? 'on' : 'off' }); }).catch((e: Error) => setError(e.message));
  // Grants end on their own (expiry, ticket or run end, an approver's revoke): poll the desk's state, not just the clock.
  useEffect(() => { load(); const t = setInterval(() => { setNow(Date.now()); if (document.visibilityState === 'visible') load(); }, 10_000); return () => clearInterval(t); }, []);
  const after = async () => { await load(); await loadSnapshot(); };
  return (
    <Panel title="Production access" description="Who may run the desk's read-only production probes, and for how long." onClose={closeSheet} wide
      footer={<div className="flex justify-end"><AsyncButton variant="destructive" confirm="Revoke every production access grant and decline every open request now? Probes in flight are cancelled."
        run={async () => { await api('POST', '/api/access/revoke-all', {}); await after(); }} ok="All access revoked">Revoke all</AsyncButton></div>}>
      {!d ? <p className="text-muted-foreground">{error || 'Loading…'}</p> : <>
        <Section title="Active grants"><div className="divide-y rounded-lg border bg-card">
          {d.grants.length ? d.grants.map((x) => (
            <div key={x.id} className="flex items-center gap-3 px-4 py-2.5"><span className="grid min-w-0 flex-1"><b>{x.seat_name}</b>
              <span className="text-sm text-muted-foreground">{probesText(x.probes)} · {span(x, now)} · by {x.granted_by}{x.reason ? ` · ${x.reason}` : ''}</span></span>
              <AsyncButton size="sm" variant="secondary" run={async () => { await api('POST', `/api/access/grants/${x.id}/revoke`, { reason: 'revoked by the owner' }); await after(); }} ok="Revoked">Revoke</AsyncButton></div>))
            : <p className="px-4 py-3 text-muted-foreground">Nobody can read production right now.</p>}
        </div></Section>
        <Section title="Requests"><div className="divide-y rounded-lg border bg-card">
          {d.requests.length ? d.requests.map((r) => (
            <div key={r.id} className="grid gap-2 px-4 py-2.5"><span><b>{r.seat_name}</b> wants {probesText(r.probes)} {reqSpan(r)}</span>
              <span className="text-sm text-muted-foreground">{r.why}{r.status === 'owner' ? ` · needs you: ${r.owner_reason || ''}` : ` · ${r.approver_name || 'an approver'} reviews it`}</span>
              <span className="flex gap-2"><AsyncButton size="sm" run={async () => { await api('POST', `/api/access/requests/${r.id}/approve`, {}); await after(); }} ok="Granted">Grant {reqSpan(r)}</AsyncButton>
                <AsyncButton size="sm" variant="secondary" run={async () => { await api('POST', `/api/access/requests/${r.id}/deny`, { reason: 'declined by the owner' }); await after(); }} ok="Declined">Decline</AsyncButton></span></div>))
            : <p className="px-4 py-3 text-muted-foreground">No open requests.</p>}
        </div></Section>
        <Section title="Grant access"><div className="grid gap-2 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            <select aria-label="Seat" className="h-9 rounded-md border bg-background px-2" value={g.seat} onChange={(e) => setG({ ...g, seat: e.target.value })}>{d.seats.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}</select>
            <Input aria-label="Probes" className="w-56" value={g.probes} onChange={(e) => setG({ ...g, probes: e.target.value })} placeholder="* or db_health, container_logs" />
            <Input aria-label="Minutes" className="w-24" inputMode="numeric" value={g.minutes} disabled={g.standing || !!g.ticket} onChange={(e) => setG({ ...g, minutes: e.target.value })} placeholder="minutes" />
            <Input aria-label="Ticket" className="w-28" value={g.ticket} disabled={g.standing} onChange={(e) => setG({ ...g, ticket: e.target.value.trim() })} placeholder="or ticket" />
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={g.standing} onChange={(e) => setG({ ...g, standing: e.target.checked })} />standing</label>
          </div>
          <Input aria-label="Reason" value={g.reason} onChange={(e) => setG({ ...g, reason: e.target.value })} placeholder="Why (shown on the ticket and in the history)" />
          <AsyncButton className="justify-self-start" run={async () => { await api('POST', '/api/access/grant', { seat: g.seat, probes: list(g.probes), minutes: Number(g.minutes) || null, ticket_key: g.ticket || null, standing: g.standing, reason: g.reason }); await after(); }} ok="Granted">Grant</AsyncButton>
        </div></Section>
        {pol && <Section title="What the EM and SRE may approve"><div className="grid gap-2 rounded-lg border bg-card p-4 text-sm">
          <p className="text-muted-foreground">Requests within this policy are decided by the EM or the SRE (never for themselves). Access for the EM or SRE themselves, renewals, and anything beyond this policy come to your Inbox.</p>
          {([['approvers', 'Approvers (manager, sre)'], ['seats', 'Seats they may grant'], ['probes', 'Probes (* = all)'], ['maxMinutes', 'Longest grant (minutes)'], ['maxActive', 'Active agent grants at most'], ['ticketMaxHours', 'Ticket-scoped cap (hours)']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between gap-3"><span>{label}</span><Input className="w-72" value={pol[k]} onChange={(e) => { editedRef.current = true; setEdited(true); setPol({ ...pol, [k]: e.target.value }); }} /></label>))}
          <label className="flex items-center justify-between gap-3"><span>Tagged people may get read access for their reply automatically</span>
            <input type="checkbox" className="size-5" aria-label="Automatic read access for tagged people" checked={pol.ownerMentionAutoGrant !== 'off'} onChange={(e) => { editedRef.current = true; setEdited(true); setPol({ ...pol, ownerMentionAutoGrant: e.target.checked ? 'on' : 'off' }); }} /></label>
          <label className="flex items-center justify-between gap-3"><span>Post-deploy checks: the SRE may read the checked probes for that check's run only</span>
            <input type="checkbox" className="size-5" aria-label="Automatic read access for post-deploy checks" checked={pol.postDeployAutoGrant === 'on'} onChange={(e) => { editedRef.current = true; setEdited(true); setPol({ ...pol, postDeployAutoGrant: e.target.checked ? 'on' : 'off' }); }} /></label>
          <AsyncButton className="justify-self-start" variant="secondary" run={async () => {
            await api('POST', '/api/access/policy', { policy: { approvers: list(pol.approvers), seats: list(pol.seats), probes: list(pol.probes), maxMinutes: Number(pol.maxMinutes), maxActive: Number(pol.maxActive), ticketMaxHours: Number(pol.ticketMaxHours), ownerMentionAutoGrant: pol.ownerMentionAutoGrant !== 'off', postDeployAutoGrant: pol.postDeployAutoGrant === 'on' } }); editedRef.current = false; setEdited(false); await after();
          }} ok="Policy saved">{edited ? 'Save policy (unsaved changes)' : 'Save policy'}</AsyncButton>
        </div></Section>}
        <Section title="History"><div className="grid gap-1 text-sm text-muted-foreground">
          {[...d.history.grants.map((x) => ({ at: x.created_at, text: `#${x.id} ${x.seat_name}: ${probesText(x.probes)} by ${x.granted_by}${x.revoked_at ? ` · ended (${x.revoked_by})` : ''}` })),
            ...d.history.requests.map((r) => ({ at: r.created_at, text: `request #${r.id} ${r.seat_name}: ${r.status}${r.decided_by ? ` by ${r.decided_by}` : ''}${r.note ? ` · ${r.note}` : ''}` }))]
            .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40).map((h, i) => <p key={i}><span className="font-mono">{h.at.slice(5, 16).replace('T', ' ')}</span> {h.text}</p>)}
          {!d.history.grants.length && !d.history.requests.length && <p>Nothing yet.</p>}
        </div></Section>
        <Button variant="ghost" className="justify-self-start" onClick={load}>Refresh</Button>
      </>}
    </Panel>
  );
}
