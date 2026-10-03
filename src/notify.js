// Optional push to your phone: a webhook (Discord / Slack / ntfy-compatible) when the desk needs you.
// Sent by the desk process (never by agents), deep-linked to the ticket on the board.
import { config } from './config.js';
import * as store from './db.js';

const recent = new Map(); // dedupe key -> ts

export async function notify(kind, ticket, text) {
  const n = config.notify;
  if (!n?.webhookUrl || !n.events.includes(kind)) return;
  const key = `${kind}:${ticket?.key}:${text}`.slice(0, 300);
  if (recent.has(key) && Date.now() - recent.get(key) < 10 * 60_000) return;
  recent.set(key, Date.now());
  const link = n.boardUrl && ticket ? `${n.boardUrl.replace(/\/$/, '')}/#${ticket.key}` : '';
  const icon = { needs_human: '📣', ready_for_human: '✅', page: '🚨', done: '🎉' }[kind] || '•';
  const msg = `${icon} **${ticket ? `${ticket.key} · ` : ''}${text}**${ticket ? `\n${ticket.title}` : ''}${link ? `\n${link}` : ''}`;
  const isSlack = /hooks\.slack\.com/.test(n.webhookUrl);
  const isNtfy = /ntfy\./.test(n.webhookUrl);
  try {
    const res = await fetch(n.webhookUrl, {
      method: 'POST',
      headers: isNtfy ? { Title: 'SigmaDesk', 'User-Agent': 'SigmaDesk' } : { 'Content-Type': 'application/json', 'User-Agent': 'SigmaDesk' },
      body: isNtfy ? msg.replace(/\*\*/g, '') : JSON.stringify(isSlack ? { text: msg.replace(/\*\*/g, '*') } : { content: msg.slice(0, 1900), username: 'SigmaDesk' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) store.logEvent({ kind: 'error', text: `notify webhook HTTP ${res.status}` });
  } catch (err) {
    store.logEvent({ kind: 'error', text: `notify webhook failed: ${err.message}` });
  }
}
