import { useId, useState, type ReactNode } from 'react';
import { X, Minus, Plus } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Labelled field with an optional hint and error, wired with aria-describedby. */
export function Field({ label, hint, error, children, id, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: (ids: { id: string; describedBy?: string }) => ReactNode; id?: string; className?: string }) {
  const auto = useId();
  const fid = id || auto;
  const describedBy = [hint && `${fid}-hint`, error && `${fid}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={fid} className="text-sm font-normal text-muted-foreground">{label}</Label>
      {children({ id: fid, describedBy })}
      {hint && <p id={`${fid}-hint`} className="text-[13px] text-muted-foreground">{hint}</p>}
      {error && <p id={`${fid}-err`} role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Free-text tokens (sources, tags). Enter or comma adds; Backspace on empty removes the last; suggestions add in one tap. */
export function TokenInput({ label, values, onChange, suggestions = [], normalize = (s: string) => s.trim() || null, placeholder, hint, invalidText = 'That entry is not valid.', max = 40 }:
  { label: string; values: string[]; onChange: (v: string[]) => void; suggestions?: string[]; normalize?: (s: string) => string | null; placeholder?: string; hint?: ReactNode; invalidText?: string; max?: number }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(',').map(normalize).filter((x): x is string => !!x);
    if (!parts.length) { if (raw.trim()) setError(invalidText); return; }
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    onChange(next); setText(''); setError('');
  };
  const left = suggestions.filter((s) => !values.includes(s));
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">{label}</Label>
      {hint && <p className="-mt-1 text-[13px] text-muted-foreground">{hint}</p>}
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 rounded-full bg-secondary py-0.5 pl-3 pr-1 text-sm">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}
              className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-9"><X className="size-3.5" /></button>
          </span>
        ))}
        <input id={id} value={text} placeholder={values.length ? '' : placeholder} aria-invalid={!!error || undefined}
          className="min-w-36 flex-1 bg-transparent px-1 py-1 outline-none placeholder:text-muted-foreground"
          onChange={(e) => { const v = e.target.value; if (v.endsWith(',')) add(v); else { setText(v); setError(''); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); add(text); } if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1)); }}
          onBlur={() => { if (text.trim()) add(text); }} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {left.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label={`Suggested ${label.toLowerCase()}`}>
        {left.map((s) => <button key={s} type="button" onClick={() => add(s)} className="rounded-full border border-dashed border-input px-3 py-1 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground max-md:min-h-11">+ {s}</button>)}
      </div>}
    </div>
  );
}

export function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const id = useId();
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <div className="grid gap-2">
      <span id={id} className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="max-md:size-11" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - 1)}><Minus /></Button>
        <span role="spinbutton" tabIndex={0} aria-labelledby={id} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} className="min-w-12 text-center text-lg font-semibold tabular"
          onKeyDown={(e) => { if (['ArrowUp', 'ArrowRight'].includes(e.key)) { e.preventDefault(); set(value + 1); } if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); set(value - 1); } }}>{value}</span>
        <Button variant="outline" size="icon" className="max-md:size-11" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}><Plus /></Button>
      </div>
    </div>
  );
}

/** A row with a label, an explanation and a switch. */
export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid gap-0.5"><Label htmlFor={id} className="font-medium">{label}</Label>{hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}</div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
