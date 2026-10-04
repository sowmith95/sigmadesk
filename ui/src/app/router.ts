// Hash routes: #/inbox, #/work, #/team, #/research, #/prs, #/desk, #/settings, and a ticket over any page: #/work/SD-5.
// The old v2 form #SD-5 still opens the ticket. Back closes a ticket (each open pushes a history entry).
export const PAGES = ['inbox', 'work', 'team', 'research', 'prs', 'desk', 'settings'] as const;
export type Page = (typeof PAGES)[number];
const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function parse(hash: string): { page: Page; ticket: string | null } {
  const raw = hash.replace(/^#\/?/, '');
  if (KEY.test(raw)) return { page: 'inbox', ticket: raw };
  const [p, t] = raw.split('/');
  const page = (PAGES as readonly string[]).includes(p) ? (p as Page) : 'inbox';
  return { page, ticket: t && KEY.test(t) ? t : null };
}
export const href = (page: Page, ticket?: string | null) => `#/${page}${ticket ? `/${ticket}` : ''}`;
