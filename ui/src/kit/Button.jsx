import { useState } from 'react';
import { toast } from '../store.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');

/** Plain button in the desk style. variant: primary | danger | ghost | on; size: small | big | wide. */
export function Button({ variant, size, className, type = 'button', ...rest }) {
  return <button type={type} className={cls('btn', variant, size, className)} {...rest} />;
}

/**
 * A button whose click runs async work: disabled while it runs, the success message as a toast, errors as an error
 * toast. `run` may return false to mean "cancelled" (no toast). `confirm` asks first.
 */
export function AsyncButton({ run, ok, confirm: question, children, disabled, ...rest }) {
  const [busy, setBusy] = useState(false);
  const onClick = async (e) => {
    e.stopPropagation();
    if (busy) return;
    if (question && !window.confirm(question)) return;
    setBusy(true);
    try {
      const result = await run(e);
      if (ok && result !== false) toast(typeof ok === 'function' ? ok(result) : ok);
    } catch (err) { toast(err.message, true); }
    finally { setBusy(false); }
  };
  return <Button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>{children}</Button>;
}

export function IconButton({ label, className, children, ...rest }) {
  return <button type="button" className={cls('icon-btn', className)} aria-label={label} title={label} {...rest}>{children}</button>;
}
export const CloseButton = ({ onClose }) => <button type="button" className="close" aria-label="Close" onClick={onClose}>×</button>;
