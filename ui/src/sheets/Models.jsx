import { useEffect, useState } from 'react';
import { S, api, agentMap, closeSheet, loadSnapshot, openSeat } from '../store.js';
import { Sheet, SheetHead, ChipGroup, Toggle, Field, Button, AsyncButton } from '../kit/index.js';

const POLICIES = [{ value: 'automatic', label: 'Automatic', hint: 'any compatible provider' }, { value: 'custom', label: 'My order' }, { value: 'off', label: 'Wait', hint: 'for the preferred provider' }];

function Profile({ title, p, onChange, catalog, seatId }) {
  const allowed = catalog.seats.find((s) => s.id === seatId)?.supported_engines || ['claude', 'codex'];
  const engines = catalog.engines.filter((e) => allowed.includes(e.id));
  const engine = engines.find((e) => e.id === p.engine);
  const models = engine?.models || [];
  const health = (S.meta.providers || []).find((x) => x.id === p.engine);
  const relayHeld = p.engine === 'perplexity' && !(S.meta.providers || []).find((x) => x.id === 'claude')?.ready;
  const efforts = models.find((m) => m.id === p.model)?.efforts || engine?.efforts || [];
  const setEngine = (v) => onChange({ ...p, engine: v, ...(catalog.seats.find((s) => s.id === seatId)?.suggestions[v] || { model: catalog.engines.find((e) => e.id === v)?.models[0]?.id || '', effort: 'medium' }) });
  const setModel = (v) => { const e = models.find((m) => m.id === v)?.efforts || engine.efforts; onChange({ ...p, model: v, effort: e.includes(p.effort) ? p.effort : e.includes('high') ? 'high' : e[0] }); };
  return (
    <fieldset className="model-profile"><legend>{title}</legend>
      <ChipGroup label={`${title} provider`} options={engines.map((e) => ({ value: e.id, label: e.label, hint: e.available ? null : 'unavailable' }))} value={p.engine} onChange={setEngine} />
      <Field label={`${title} model`}><select aria-label={`${title} model`} value={p.model} onChange={(e) => setModel(e.target.value)}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id || m.note || 'Account default'}</option>)}</select></Field>
      <ChipGroup label={`${title} reasoning`} size="compact" options={efforts.map((e) => ({ value: e, label: e }))} value={p.effort} onChange={(effort) => onChange({ ...p, effort })} />
      <p className="small" role="status">{health?.ready ? (relayHeld ? 'Connected; waiting for an available Claude relay' : 'Provider ready') : health?.reason || 'Provider status unavailable'}</p>
      <p className="muted small">{models.find((m) => m.id === p.model)?.note || engine?.costs || ''}</p>
      {p.engine === 'perplexity' && <p className="muted small">Thinking roles only. Uses Perplexity credits plus a local Claude relay; both must be available.</p>}
    </fieldset>
  );
}

export function ModelsSheet({ id }) {
  const a = agentMap()[id];
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [d, setD] = useState(() => ({ engine: a.engine, model: a.model || '', effort: a.effort, enabled: a.enabled !== false,
    mode: a.fallbacks === undefined ? 'automatic' : a.fallbacks.length ? 'custom' : 'off', fallbacks: structuredClone(a.fallbacks || []) }));
  useEffect(() => { api('GET', '/api/engines').then(setCatalog).catch((e) => setError(e.message)); }, []);
  const running = S.runs.find((r) => r.id === a.current_run);
  const setMode = (mode) => {
    const next = { ...d, mode };
    if (mode === 'custom' && !d.fallbacks.length) { const alt = catalog.engines.find((e) => e.id !== d.engine && e.id !== 'perplexity'); if (alt) next.fallbacks = [{ engine: alt.id, ...catalog.seats.find((s) => s.id === a.id)?.suggestions[alt.id] }]; }
    setD(next);
  };
  return (
    <Sheet label={`${a.name} models`} onClose={closeSheet} head={<SheetHead title={`${a.name} · Models`} sub={a.role} onClose={closeSheet} />}
      footer={catalog && <div className="f-actions"><span className="spacer" /><AsyncButton variant="primary" run={async () => {
        if (d.mode === 'custom' && !d.fallbacks.length) throw new Error('Add a fallback or choose another policy.');
        await api('POST', '/api/team', { seats: { [a.id]: { engine: d.engine, model: d.model, effort: d.effort, enabled: d.enabled, fallback_mode: d.mode, ...(d.mode === 'automatic' ? {} : { fallbacks: d.mode === 'off' ? [] : d.fallbacks }) } } });
        await loadSnapshot(); openSeat(a.id);
      }} ok="Model preferences saved for the next run">Save models</AsyncButton></div>}>
      {!catalog ? <p className="muted">{error || 'Loading installed providers and model catalogs…'}</p> : <>
        <p>{running ? `Current run: ${running.model}. Saved changes apply to the next run.` : 'Changes apply to the next run.'}</p>
        <div className="set"><Toggle label="Seat enabled" hint="An off seat takes no new work." checked={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} /></div>
        <Profile title="Preferred" p={d} catalog={catalog} seatId={a.id} onChange={(p) => setD({ ...d, engine: p.engine, model: p.model, effort: p.effort })} />
        <ChipGroup label="When the preferred provider is unavailable" options={POLICIES} value={d.mode} onChange={setMode} />
        {d.mode === 'custom' && d.fallbacks.map((p, i) => <div key={i}><Profile title={`Fallback ${i + 1}`} p={p} catalog={catalog} seatId={a.id} onChange={(np) => setD({ ...d, fallbacks: d.fallbacks.map((x, j) => (j === i ? np : x)) })} />
          <Button variant="ghost" size="small" onClick={() => setD({ ...d, fallbacks: d.fallbacks.filter((_, j) => j !== i) })}>Remove fallback</Button></div>)}
        {d.mode === 'custom' && d.fallbacks.length < 3 && <Button onClick={() => setD({ ...d, fallbacks: [...d.fallbacks, { engine: 'codex', model: '', effort: 'medium' }] })}>Add fallback</Button>}
        <p className="muted small">Provider quota holds apply to all its models. If every compatible provider is unavailable, work waits and keeps its state.</p>
        {S.settings.auto_fallback !== 'true' && <p className="warn">Automatic fallback is globally off. Enable it from Team to use these backups.</p>}
      </>}
    </Sheet>
  );
}
