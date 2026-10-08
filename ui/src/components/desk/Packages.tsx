// Package installs (#8): one request's manifest (every wheel the desk resolved, transitive ones too: version, size,
// sha256), the owner's Approve / Decline / Revoke, and a ticket's verified workspace venv. Phone-first: one column,
// the manifest collapsed until asked for.
import { useEffect, useState } from 'react';
import { api, loadSnapshot } from '@/store.js';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, type Tone } from '@/components/desk/Bits';

export type Wheel = { name: string; version: string; filename: string; sha256: string; size: number | null; requested: boolean; role: string };
export type PkgRequest = { id: number; seat: string; seat_name: string; ticket_key: string; why: string | null; specs: { name: string; version: string }[]; dev: number; status: string;
  manifest: Wheel[]; additions: Wheel[]; shared_count: number; total_bytes: number | null; error: string | null; note: string | null; expires_at: string | null; installed_at: string | null; created_at: string };
export type Fingerprint = { python: string; platform: string; shared_venv: string; added: { name: string; version: string; sha256: string; dev: boolean }[]; lock_size: number; lock_sha256: string; verified_at: string };

const STATUS: Record<string, { label: string; tone: Tone }> = {
  resolving: { label: 'Resolving', tone: 'neutral' }, owner: { label: 'Needs you', tone: 'needs' }, approved: { label: 'Approved', tone: 'shipped' },
  denied: { label: 'Declined', tone: 'neutral' }, failed: { label: 'Refused', tone: 'blocked' }, revoked: { label: 'Revoked', tone: 'blocked' },
  expired: { label: 'Expired', tone: 'neutral' }, closed: { label: 'Ticket closed', tone: 'neutral' }, withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};
export const mbText = (n: number | null | undefined) => (n ? `${(n / 1e6).toFixed(1)} MB` : '—');
const pins = (r: PkgRequest) => r.specs.map((s) => `${s.name}==${s.version}`).join(', ');

/** One request: who, which ticket, why, state; the full manifest on demand; the owner's actions. */
export function PackageRequestRow({ r, onDone }: { r: PkgRequest; onDone?: () => Promise<void> | void }) {
  const [open, setOpen] = useState(r.status === 'owner');
  const after = async () => { await onDone?.(); await loadSnapshot(); };
  const st = STATUS[r.status] || { label: r.status, tone: 'neutral' as Tone };
  const wheels = r.manifest.filter((w) => w.role !== 'shared');
  return (
    <div className="grid gap-2 px-4 py-3" data-pkg-request={r.id}>
      <div className="flex flex-wrap items-center gap-2"><b className="min-w-0">{r.seat_name}</b><span className="text-sm text-muted-foreground">{r.ticket_key}</span><Tag tone={st.tone}>{st.label}</Tag>
        {r.dev ? <Tag>dev/test</Tag> : null}{r.installed_at && <Tag tone="shipped">Installed</Tag>}</div>
      <p className="text-sm"><span className="font-mono">{pins(r)}</span>{r.additions.length > r.specs.length ? <span className="text-muted-foreground"> + {r.additions.length - r.specs.length} dependencies</span> : null}
        {r.total_bytes ? <span className="text-muted-foreground"> · {mbText(r.total_bytes)}</span> : null}</p>
      {r.why && <p className="text-sm text-muted-foreground">{r.why}</p>}
      {(r.error || (r.note && r.status !== 'approved')) && <p className="text-sm text-blocked">{r.error || r.note}</p>}
      {r.status === 'approved' && r.expires_at && <p className="text-[13px] text-muted-foreground">Installable until {r.expires_at.slice(5, 16).replace('T', ' ')} UTC, while {r.ticket_key} is open.</p>}
      {!!wheels.length && <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm text-primary">{wheels.length} wheel{wheels.length === 1 ? '' : 's'} from PyPI{r.shared_count ? ` · ${r.shared_count} already in the shared venv (unchanged)` : ''}</summary>
        <ul className="mt-1 grid gap-1 text-[13px]">
          {wheels.map((w) => <li key={w.filename} className="grid min-w-0">
            <span><span className="font-mono">{w.name}=={w.version}</span>{w.requested ? <span className="text-muted-foreground"> · asked for</span> : w.role === 'installer' ? <span className="text-muted-foreground"> · installer only (not installed)</span> : <span className="text-muted-foreground"> · dependency</span>} · {mbText(w.size)}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={w.sha256}>sha256 {w.sha256}</span></li>)}
        </ul>
      </details>}
      <div className="flex flex-wrap gap-2">
        {r.status === 'owner' && <>
          <AsyncButton size="sm" run={async () => { await api('POST', `/api/packages/${r.id}/approve`, {}); await after(); }} ok="Approved">Approve install</AsyncButton>
          <AsyncButton size="sm" variant="secondary" run={async () => { await api('POST', `/api/packages/${r.id}/deny`, { reason: 'declined by the owner' }); await after(); }} ok="Declined">Decline</AsyncButton></>}
        {['approved', 'resolving'].includes(r.status) && <AsyncButton size="sm" variant="secondary" confirm="Revoke this package grant? Further installs are refused; what is already installed stays in that ticket's workspace."
          run={async () => { await api('POST', `/api/packages/${r.id}/revoke`, { reason: 'revoked by the owner' }); await after(); }} ok="Revoked">Revoke</AsyncButton>}
      </div>
    </div>
  );
}

/** Ticket details: the workspace venv the desk verified after an offline install (python, platform, lock, hashes). */
export function TicketPackages({ ticketKey, sig }: { ticketKey: string; sig?: string }) {
  const [v, setV] = useState<{ requests: PkgRequest[]; fingerprint: Fingerprint | null } | null>(null);
  useEffect(() => {
    let gone = false;
    api('GET', `/api/tickets/${ticketKey}/packages`).then((x) => { if (!gone) setV(x as typeof v); }).catch(() => {});
    return () => { gone = true; };
  }, [ticketKey, sig]);
  if (!v || (!v.requests.length && !v.fingerprint)) return null;
  const fp = v.fingerprint;
  return (
    <section aria-label="Packages" className="grid gap-1.5 rounded-lg border bg-card px-4 py-3 text-[13px]" data-packages>
      <b className="text-sm">Workspace venv</b>
      {fp ? <>
        <p>Python {fp.python} · {fp.platform} · +{fp.added.length} package{fp.added.length === 1 ? '' : 's'} on the shared venv</p>
        <p className="text-muted-foreground">{fp.added.map((a) => `${a.name}==${a.version}${a.dev ? ' (dev)' : ''}`).join(', ')}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={fp.lock_sha256}>lock {fp.lock_size} distributions · sha256 {fp.lock_sha256}</p>
        <p className="text-muted-foreground">Verified {fp.verified_at.slice(5, 16).replace('T', ' ')} UTC; QA tests with this venv.</p>
      </> : <p className="text-muted-foreground">Nothing installed yet.</p>}
      {v.requests.map((r) => <p key={r.id} className="text-muted-foreground">#{r.id} {pins(r)}: {STATUS[r.status]?.label || r.status}</p>)}
    </section>
  );
}
