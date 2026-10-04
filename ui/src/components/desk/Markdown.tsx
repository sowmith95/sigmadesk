// A small, safe markdown renderer for messages and documents written by seats and the owner. It builds React
// elements only (no HTML injection): paragraphs, headings, bullet and numbered lists, block quotes, fenced code,
// bold, italics, inline code and http(s) links. Ticket keys in plain text become named chips via Named.
import { Fragment, type ReactNode } from 'react';
import { Named } from './Bits';
import { cn } from '@/lib/utils';

type Block = { type: 'p' | 'h' | 'ul' | 'ol' | 'quote' | 'code'; lines: string[]; level?: number };

export function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ type: 'code', lines: body });
      continue;
    }
    if (!line.trim()) { out.push({ type: 'p', lines: [] }); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ type: 'h', level: h[1].length, lines: [h[2]] }); continue; }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
    const q = line.match(/^\s*>\s?(.*)$/);
    const type: Block['type'] = ul ? 'ul' : ol ? 'ol' : q ? 'quote' : 'p';
    const text = ul ? ul[1] : ol ? ol[1] : q ? q[1] : line;
    const last = out.at(-1);
    if (last && last.type === type && last.lines.length) last.lines.push(text);
    else out.push({ type, lines: [text] });
  }
  return out.filter((b) => b.lines.length || b.type === 'code');
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]{1,200}\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?<![\w*])[*_][^*_\n]{1,200}[*_](?![\w*]))/g;

export function Inline({ text, self }: { text: string; self?: string }): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0, m: RegExpExecArray | null, n = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > at) parts.push(<Named key={n++} text={text.slice(at, m.index)} self={self} />);
    const [all, code, bold, link, href, url, em] = m;
    if (code) parts.push(<code key={n++} className="rounded bg-background/70 px-1 py-px font-mono text-[0.88em]">{code.slice(1, -1)}</code>);
    else if (bold) parts.push(<strong key={n++} className="font-semibold"><Named text={bold.slice(2, -2)} self={self} /></strong>);
    else if (link) parts.push(<a key={n++} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{link.slice(1, link.indexOf(']('))}</a>);
    else if (url) parts.push(<a key={n++} href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{url.replace(/^https?:\/\/(www\.)?/, '')}</a>);
    else if (em) parts.push(<em key={n++}>{em.slice(1, -1)}</em>);
    else parts.push(<Fragment key={n++}>{all}</Fragment>);
    at = m.index + all.length;
  }
  if (at < text.length) parts.push(<Named key={n++} text={text.slice(at)} self={self} />);
  return <>{parts}</>;
}

export function Markdown({ text, self, className }: { text: string; self?: string; className?: string }) {
  return (
    <div className={cn('grid gap-2 [overflow-wrap:anywhere]', className)}>
      {blocks(text).map((b, i) => {
        if (b.type === 'code') return <pre key={i} className="overflow-x-auto rounded-md bg-background/70 p-2.5 font-mono text-[13px] leading-relaxed">{b.lines.join('\n')}</pre>;
        if (b.type === 'h') return <p key={i} className={cn('font-semibold', (b.level || 3) <= 2 && 'text-[1.05em]')}><Inline text={b.lines[0]} self={self} /></p>;
        if (b.type === 'ul') return <ul key={i} className="grid list-disc gap-1 pl-5 marker:text-muted-foreground">{b.lines.map((l, j) => <li key={j}><Inline text={l} self={self} /></li>)}</ul>;
        if (b.type === 'ol') return <ol key={i} className="grid list-decimal gap-1 pl-5 marker:text-muted-foreground">{b.lines.map((l, j) => <li key={j}><Inline text={l} self={self} /></li>)}</ol>;
        if (b.type === 'quote') return <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">{b.lines.map((l, j) => <p key={j}><Inline text={l} self={self} /></p>)}</blockquote>;
        return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={l} self={self} /></Fragment>)}</p>;
      })}
    </div>
  );
}
