// Chip choices built on shadcn ToggleGroup (Radix): single choice = radio semantics with roving focus; multiple =
// toggle buttons. Selected chips are solid blue (the desk's action colour); resting chips are outlined so a row of
// choices never reads as a row of status badges.
import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

export interface Choice<V extends string> { value: V; label: ReactNode; hint?: ReactNode; lead?: ReactNode; disabled?: boolean; title?: string }
const chip = 'h-auto min-h-9 max-w-full whitespace-normal text-left rounded-full border border-input bg-transparent px-3.5 py-1.5 text-[15px] font-medium text-foreground shadow-none hover:bg-secondary hover:text-foreground '
  + 'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground gap-2 max-md:min-h-11 disabled:opacity-45 [&_.hint]:text-muted-foreground data-[state=on]:[&_.hint]:text-primary-foreground/75';

function Items<V extends string>({ options, size }: { options: Choice<V>[]; size?: 'sm' }) {
  return options.map((o) => (
    <ToggleGroupItem key={o.value} value={o.value} disabled={o.disabled} title={o.title} aria-label={typeof o.label === 'string' ? o.label : o.title}
      className={cn(chip, o.lead && 'pl-1', size === 'sm' && 'min-h-8 px-3 text-sm')}>
      {o.lead}{o.label}{o.hint ? <span className="hint text-[13px] font-normal">{o.hint}</span> : null}
    </ToggleGroupItem>
  ));
}

export function ChoiceChips<V extends string>({ label, hideLabel, options, value, onChange, size, className }:
  { label: string; hideLabel?: boolean; options: Choice<V>[]; value: V; onChange: (v: V) => void; size?: 'sm'; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)}>
      {!hideLabel && <span className="text-sm text-muted-foreground">{label}</span>}
      <ToggleGroup type="single" aria-label={label} value={value} onValueChange={(v) => { if (v) onChange(v as V); }} className="flex flex-wrap justify-start gap-2" spacing={2}>
        <Items options={options} size={size} />
      </ToggleGroup>
    </div>
  );
}

export function MultiChips<V extends string>({ label, hideLabel, options, value, onChange, size, className }:
  { label: string; hideLabel?: boolean; options: Choice<V>[]; value: V[]; onChange: (v: V[]) => void; size?: 'sm'; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)}>
      {!hideLabel && <span className="text-sm text-muted-foreground">{label}</span>}
      <ToggleGroup type="multiple" aria-label={label} value={value} onValueChange={(v) => onChange(options.map((o) => o.value).filter((x) => v.includes(x)))} className="flex flex-wrap justify-start gap-2" spacing={2}>
        <Items options={options} size={size} />
      </ToggleGroup>
    </div>
  );
}
