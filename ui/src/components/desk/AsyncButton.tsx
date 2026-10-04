import { useState, type ComponentProps, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

type Props = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  /** Async work; return false to mean "cancelled" (no success toast). */
  run: (e: MouseEvent<HTMLButtonElement>) => unknown | Promise<unknown>;
  /** Success toast (or a function of the result). */
  ok?: string | ((result: unknown) => string);
  /** Ask before running. */
  confirm?: string;
};

/** A button that runs async work: disabled while running, success and error as toasts. */
export function AsyncButton({ run, ok, confirm: question, disabled, children, ...rest }: Props) {
  const [busy, setBusy] = useState(false);
  const onClick = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (busy) return;
    if (question && !window.confirm(question)) return;
    setBusy(true);
    try {
      const result = await run(e);
      if (ok && result !== false) toast(typeof ok === 'function' ? ok(result) : ok);
    } catch (err) { toast((err as Error).message, true); }
    finally { setBusy(false); }
  };
  return <Button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>{children}</Button>;
}
