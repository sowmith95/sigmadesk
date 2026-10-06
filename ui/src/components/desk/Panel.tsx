import { useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * The desk's side panel (shadcn Sheet = Radix Dialog): traps focus, Escape closes, the page behind is hidden from
 * assistive tech and returns focus to what opened it. Full screen on phones. Header and footer stay put; the body scrolls.
 */
export function Panel({ title, description, head, children, footer, onClose, wide, bodyRef, label, compact }:
  { title: ReactNode; description?: ReactNode; head?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; bodyRef?: RefObject<HTMLDivElement | null>; label?: string; compact?: boolean }) {
  // Radix only restores focus to a Dialog.Trigger; panels here open from code, the palette and links. Remember the
  // opener; on close return to it, else to its card (it may have re-rendered), else to the page content.
  const opener = useRef<{ el: Element | null; key: string | null } | null>(null);
  if (!opener.current) { const a = document.activeElement; opener.current = { el: a, key: (a as HTMLElement | null)?.closest?.('[data-key]')?.getAttribute('data-key') || null }; }
  const restore = (e: Event) => {
    e.preventDefault();
    const o = opener.current!;
    const target = (o.el as HTMLElement | null)?.isConnected && o.el !== document.body ? o.el as HTMLElement
      : o.key ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(o.key)}"] button, button[data-key="${CSS.escape(o.key)}"]`) : null;
    (target || document.getElementById('main'))?.focus();
  };
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" data-panel showCloseButton={false} aria-label={label} aria-describedby={description ? undefined : undefined}
        className={cn('w-full gap-0 border-l p-0 sm:max-w-[640px]', wide && 'sm:max-w-[780px]')}
        onCloseAutoFocus={restore}
        // An inline list that owns Escape while open (the composer's @ picker) closes first; the panel stays.
        onEscapeKeyDown={(e) => { if (document.querySelector('[data-captures-escape]')) e.preventDefault(); }}
        onOpenAutoFocus={(e) => { const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-autofocus]'); if (el) { e.preventDefault(); el.focus(); } }}>
        {/* compact (a phone reply has focus): one line, title only, so the thread keeps the room. */}
        <header className={cn('grid grid-cols-[minmax(0,1fr)] gap-1.5 border-b px-5 sm:px-6', compact ? 'pb-2 pt-[calc(env(safe-area-inset-top)+8px)]' : 'pb-3 pt-[calc(env(safe-area-inset-top)+16px)]')}>
          <div className={cn('flex gap-3', compact ? 'items-center' : 'items-start')}>
            <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1">
              {!compact && head}
              <SheetTitle className={cn('font-semibold leading-tight', compact ? 'truncate text-base' : 'text-xl [overflow-wrap:anywhere]')}>{title}</SheetTitle>
              {description ? <SheetDescription className="text-muted-foreground">{description}</SheetDescription> : <SheetDescription className="sr-only">Details</SheetDescription>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-10 shrink-0 place-items-center rounded-md bg-secondary hover:bg-accent max-md:size-11"><X className="size-5" /></button>
          </div>
        </header>
        {/* minmax(0,1fr): grid tracks would otherwise grow to the widest unbreakable child (tab rows, long titles). */}
        {/* compact: extra room below so the newest message can scroll to the top even in a short thread. */}
        <div ref={bodyRef} className={cn('grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-5 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6', compact && 'pb-[60dvh]')}>{children}</div>
        {footer ? <footer className="grid gap-2.5 border-t bg-card px-5 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 sm:px-6">{footer}</footer> : null}
      </SheetContent>
    </Sheet>
  );
}
