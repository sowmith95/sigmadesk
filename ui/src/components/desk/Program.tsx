// The program update: where the desk stands in a few lines (shipped, stuck and why, what needs you), computed from
// the board by public/program.js. The Inbox shows it as one quiet line; the Desk page shows every line.
import { currentBoard, openTicket, S } from '@/store.js';
import { programUpdate } from '../../../../public/program.js';
import { cn } from '@/lib/utils';

const TONE: Record<string, string> = { shipped: 'text-shipped', blocked: 'text-blocked', needs: 'text-needs', muted: 'text-muted-foreground' };

export function ProgramUpdate({ compact = false }: { compact?: boolean }) {
  const p = programUpdate(S, currentBoard());
  // The Inbox already lists what needs you; its line says what moved and what is stuck.
  const lines = compact ? p.lines.filter((l) => (l.id === 'shipped' && p.shipped) || l.id === 'stuck') : p.lines;
  if (!lines.length) return null;
  const line = (l: (typeof lines)[number], i: number) => l.keys.length === 1
    ? <button key={i} type="button" className={cn('text-left hover:underline', TONE[l.tone])} onClick={() => openTicket(l.keys[0])}>{l.text}</button>
    : <span key={i} className={TONE[l.tone]}>{l.text}</span>;
  if (compact) return <p data-program className="flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] leading-snug">{lines.map(line)}</p>;
  return (
    <section data-program aria-label="Program update" className="grid gap-1.5 rounded-lg border bg-card p-4 text-sm">
      <b className="text-base">Program update</b>
      {lines.map((l, i) => <div key={i}>{line(l, i)}</div>)}
    </section>
  );
}
