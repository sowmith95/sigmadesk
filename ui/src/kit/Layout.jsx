import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { portrait, presenceOf } from '../../../public/avatars.js';
import { linkKeys } from '../../../public/names.js';
import { S, setOpen, agentMap, ticketByKey, openTicket } from '../store.js';
import { CloseButton } from './Button.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && <span className="muted small field-hint">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

/** <details> whose open state survives live re-renders and remounts (keyed by id). */
export function Disclosure({ id, summary, children, className = '', defaultOpen = false }) {
  const [open, setOpenState] = useState(S.open[id] ?? defaultOpen);
  return (
    <details className={cls('disc', className)} open={open} onToggle={(e) => { setOpenState(e.currentTarget.open); setOpen(id, e.currentTarget.open); }}>
      <summary>{summary}</summary>
      <div className="disc-b">{children}</div>
    </details>
  );
}

const PX = { sm: 24, md: 32, lg: 44, xl: 64 };
/** Seat portrait (SVG from avatars.js, shared with Classic) with presence ring. */
export function Avatar({ id, size = 'sm' }) {
  const ref = useRef(null);
  const a = agentMap()[id];
  const pr = a ? presenceOf(a) : null;
  const sig = a ? `${a.id}|${a.engine}|${a.model}|${pr.key}|${size}` : '';
  useLayoutEffect(() => {
    if (!ref.current || !a) return;
    ref.current.replaceChildren(portrait(a, { size: PX[size] || 24, presence: pr.key }));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return <span className={`av ${size}`} title={id === 'owner' ? 'You' : id || 'Desk'}>{id === 'owner' ? 'You' : '·'}</span>;
  return <span ref={ref} className={`pav ${size} ${pr.key}`} title={`${a.name}, ${a.role}, ${pr.text}`} />;
}

/** Text with ticket keys rendered as named chips that open the ticket. */
export function Named({ text }) {
  const parts = linkKeys(String(text ?? ''), ticketByKey);
  return parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span>
    : <button key={i} type="button" className="kchip" title={p.key} onClick={(e) => { e.stopPropagation(); openTicket(p.key); }}>{p.name}</button>));
}

/** Overflow actions behind one button. Closes on outside click and on Escape (Sheet handles Escape order). */
export function Menu({ label = 'More actions', items }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current?.open && !ref.current.contains(e.target)) ref.current.open = false; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return (
    <details className="overflow" ref={ref}>
      <summary className="btn ghost" aria-label={label}>{label}</summary>
      <div className="menu">{items.filter(Boolean)}</div>
    </details>
  );
}

const BACKGROUND = () => [...document.querySelectorAll('[data-bg]')];
/**
 * Dialog sheet: traps Tab, Escape closes (an open overflow menu first), marks the page behind as inert, focuses
 * [data-autofocus] or the close button on open, and returns focus to what opened it (or that ticket's card).
 */
export function Sheet({ label, head, children, footer, onClose, bodyRef }) {
  const panel = useRef(null);
  useEffect(() => {
    const active = document.activeElement;
    const returnTo = { el: active, key: active?.closest?.('[data-key]')?.dataset.key || null };
    document.body.classList.add('dialog-open');
    for (const el of BACKGROUND()) el.inert = true;
    (panel.current?.querySelector('[data-autofocus]') || panel.current?.querySelector('.close'))?.focus();
    return () => {
      document.body.classList.remove('dialog-open');
      for (const el of BACKGROUND()) el.inert = false;
      const target = returnTo.el?.isConnected ? returnTo.el
        : returnTo.key ? document.querySelector(`[data-key="${CSS.escape(returnTo.key)}"] button, button[data-key="${CSS.escape(returnTo.key)}"]`) : null;
      (target || document.getElementById('view'))?.focus?.();
    };
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        const o = panel.current?.querySelector('details.overflow[open]');
        if (o) o.open = false; else onClose();
      }
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')]
          .filter((el) => el.getClientRects().length);
        const first = f[0], last = f.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-panel" role="dialog" aria-modal="true" aria-label={label} ref={panel}>
        <div className="sheet-h">{head}</div>
        <div className="sheet-b" ref={bodyRef}>{children}</div>
        {footer ? <div className="sheet-f">{footer}</div> : null}
      </div>
    </div>
  );
}
/** Standard sheet header: title, optional subtitle and extras, close button. */
export function SheetHead({ title, sub, onClose, children }) {
  return (
    <>
      <div className="row"><h2>{title}</h2><CloseButton onClose={onClose} /></div>
      {sub ? <p className="sub">{sub}</p> : null}
      {children}
    </>
  );
}

export const Empty = ({ title, children }) => <div className="empty-state"><p className="big">{title}</p>{children ? <p className="muted">{children}</p> : null}</div>;
export const KeyTag = ({ k }) => <span className="key mono">{k}</span>;
