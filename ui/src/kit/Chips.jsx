import { useId, useRef, useState } from 'react';

const cls = (...xs) => xs.filter(Boolean).join(' ');

/** Read-only status chip. tone: amber | red | green | blue. */
export const Chip = ({ tone, className, children, ...rest }) => <span className={cls('chip', tone, className)} {...rest}>{children}</span>;

/**
 * A row of selectable chips.
 * - single (default): a radiogroup; arrow keys move and select, only the selected chip is in the tab order.
 * - multiple: a group of toggle buttons (aria-pressed).
 * options: [{ value, label, hint?, disabled?, title?, lead? (node before the label, e.g. an avatar) }]
 */
export function ChipGroup({ label, labelHidden = false, options, value, onChange, multiple = false, size, className, describedBy }) {
  const id = useId();
  const refs = useRef([]);
  const selected = (v) => (multiple ? (value || []).includes(v) : value === v);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const focusIndex = multiple ? null : Math.max(0, options.findIndex((o) => o.value === value && !o.disabled));
  const pick = (o) => {
    if (o.disabled) return;
    if (!multiple) return onChange(o.value);
    const set = new Set(value || []);
    if (set.has(o.value)) set.delete(o.value); else set.add(o.value);
    onChange(options.map((x) => x.value).filter((v) => set.has(v)));
  };
  const onKeyDown = (e, i) => {
    if (multiple) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step && !['Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const pos = enabled.indexOf(i);
    const next = e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled.at(-1) : enabled[(pos + step + enabled.length) % enabled.length];
    refs.current[next]?.focus();
    onChange(options[next].value);
  };
  return (
    <div className={cls('chip-group', size, className)} role={multiple ? 'group' : 'radiogroup'} aria-labelledby={labelHidden ? undefined : `${id}-l`}
      aria-label={labelHidden ? label : undefined} aria-describedby={describedBy}>
      {!labelHidden && <span id={`${id}-l`} className="chip-group-l">{label}</span>}
      <div className="chip-row">
        {options.map((o, i) => (
          <button key={String(o.value)} ref={(el) => { refs.current[i] = el; }} type="button" className={cls('choice', o.lead && 'with-lead')}
            role={multiple ? undefined : 'radio'} aria-checked={multiple ? undefined : selected(o.value)} aria-pressed={multiple ? selected(o.value) : undefined}
            tabIndex={multiple ? 0 : i === focusIndex ? 0 : -1} disabled={o.disabled} title={o.title}
            onClick={() => pick(o)} onKeyDown={(e) => onKeyDown(e, i)}>
            {o.lead}<span className="choice-t">{o.label}</span>{o.hint ? <span className="choice-h">{o.hint}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Free-text tokens (sources, tags). Enter or comma adds; Backspace on an empty field removes the last token.
 * `normalize` returns the cleaned token or null to reject it. Suggestions not yet added appear as quick-add chips.
 */
export function ChipInput({ label, values, onChange, suggestions = [], normalize = (s) => s.trim() || null, placeholder, max = 40, hint }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const add = (raw) => {
    const parts = String(raw).split(',').map(normalize).filter(Boolean);
    if (!parts.length) { if (String(raw).trim()) setError('That does not look like a source; try a domain such as arxiv.org.'); return; }
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    onChange(next); setText(''); setError('');
  };
  const remove = (v) => onChange(values.filter((x) => x !== v));
  const left = suggestions.filter((s) => !values.includes(s));
  return (
    <div className="chip-input">
      <label htmlFor={id} className="chip-group-l">{label}</label>
      {hint && <p className="muted small">{hint}</p>}
      <div className="token-box" onClick={(e) => { if (e.target === e.currentTarget) document.getElementById(id)?.focus(); }}>
        {values.map((v) => (
          <span key={v} className="token">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => remove(v)}>×</button></span>
        ))}
        <input id={id} type="text" value={text} placeholder={values.length ? '' : placeholder} aria-invalid={!!error || undefined}
          onChange={(e) => { const v = e.target.value; if (v.endsWith(',')) add(v); else { setText(v); setError(''); } }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) { e.preventDefault(); add(text); }
            if (e.key === 'Backspace' && !text && values.length) remove(values.at(-1));
          }}
          onBlur={() => { if (text.trim()) add(text); }} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {left.length > 0 && (
        <div className="chip-row suggestions" aria-label={`Suggested ${label.toLowerCase()}`}>
          {left.map((s) => <button key={s} type="button" className="choice ghosted" onClick={() => add(s)}>+ {s}</button>)}
        </div>
      )}
    </div>
  );
}

/** − n + with bounds; the number is readable by screen readers as a spinbutton. */
export function NumberStepper({ label, value, min, max, onChange, unit }) {
  const id = useId();
  const set = (n) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <div className="stepper">
      <span id={`${id}-l`} className="chip-group-l">{label}</span>
      <div className="stepper-row">
        <button type="button" className="choice square" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - 1)}>−</button>
        <span role="spinbutton" tabIndex={0} aria-labelledby={`${id}-l`} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} className="stepper-v"
          onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set(value + 1); } if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set(value - 1); } }}>
          {value}{unit ? <span className="muted"> {unit}</span> : null}
        </span>
        <button type="button" className="choice square" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}>+</button>
      </div>
    </div>
  );
}

/** On/off switch with a label and optional hint. */
export function Toggle({ label, hint, checked, onChange, disabled }) {
  const id = useId();
  return (
    <label className="toggle" htmlFor={id}>
      <span className="toggle-l"><b>{label}</b>{hint ? <span className="muted small">{hint}</span> : null}</span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Ordered status (a real sequence): steps before `current` are done, `current` is active. */
export function StatusSteps({ steps, current, failed = false, label }) {
  const at = steps.indexOf(current);
  return (
    <ol className="steps" aria-label={label}>
      {steps.map((s, i) => {
        const state = failed && i === at ? 'failed' : i < at ? 'done' : i === at ? 'now' : 'todo';
        return <li key={s} className={`step ${state}`} aria-current={i === at ? 'step' : undefined}><span className="step-dot" aria-hidden="true" />{s}</li>;
      })}
    </ol>
  );
}
