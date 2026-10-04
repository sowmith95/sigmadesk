// Presentation-only building blocks (no app store): shared by the desk and the Projects home.
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'needs' | 'blocked' | 'shipped' | 'action' | 'neutral';
const TONES: Record<Tone, string> = {
  needs: 'bg-needs/15 text-needs', blocked: 'bg-blocked/15 text-blocked', shipped: 'bg-shipped/15 text-shipped', action: 'bg-primary/15 text-primary', neutral: 'bg-secondary text-foreground',
};
/** Small status label. Colour only when it means something. */
export function Tag({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[13px] font-medium', TONES[tone], className)}>{children}</span>;
}
export const Key = ({ k }: { k: string }) => <span className="whitespace-nowrap font-mono text-[13px] text-muted-foreground">{k}</span>;

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="grid gap-1 rounded-lg border border-dashed px-5 py-6"><p className="text-base font-semibold">{title}</p>{children && <p className="text-muted-foreground">{children}</p>}{action && <div className="mt-2">{action}</div>}</div>;
}

/** Label, large tabular value, optional sub line (after ComplexTrading's StatTile). */
export function StatTile({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return <div className="grid gap-0.5 rounded-lg border bg-card px-4 py-3"><span className="text-[13px] text-muted-foreground">{label}</span><b className="font-mono text-xl font-medium tabular">{value}</b>{sub && <span className="text-[13px] text-muted-foreground">{sub}</span>}</div>;
}

export function Section({ title, count, tone, children, id, actions }: { title: ReactNode; count?: number | string; tone?: Tone; children: ReactNode; id?: string; actions?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="grid scroll-mt-24 grid-cols-[minmax(0,1fr)] content-start gap-3">
      <div className="flex items-center gap-2">
        <h2 id={id ? `${id}-h` : undefined} className="text-base font-semibold">{title}</h2>
        {count !== undefined && <span className={cn('rounded-full px-2 py-0.5 font-mono text-xs tabular', tone && Number(count) ? TONES[tone] : 'bg-secondary text-muted-foreground')}>{count}</span>}
        <span className="flex-1" />{actions}
      </div>
      {children}
    </section>
  );
}
