// Hash routes: #/inbox, #/work, #/features, #/team, #/research, #/prs, #/desk, #/settings, and a ticket over any page:
// #/work/SD-5. Features: #/features/SD-9 is a feature's document; #/features/SD-9/SD-12 a task over it; a ticket over
// the feature list is #/features/all/SD-12. The old v2 form #SD-5 still opens the ticket. Back closes a ticket.
export const PAGES = ['inbox', 'work', 'features', 'team', 'research', 'prs', 'desk', 'settings'] as const;
export type Page = (typeof PAGES)[number];
const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
export interface Route { page: Page; ticket: string | null; feature: string | null }

export function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (KEY.test(raw)) return { page: 'inbox', ticket: raw, feature: null };
  const [p, a, b] = raw.split('/');
  const page = (PAGES as readonly string[]).includes(p) ? (p as Page) : 'inbox';
  const key = (x?: string) => (x && KEY.test(x) ? x : null);
  if (page === 'features') return { page, feature: key(a), ticket: key(b) };
  return { page, ticket: key(a), feature: null };
}
export function href(page: Page, ticket?: string | null, feature?: string | null) {
  if (page === 'features') return `#/features${feature ? `/${feature}` : ticket ? '/all' : ''}${ticket ? `/${ticket}` : ''}`;
  return `#/${page}${ticket ? `/${ticket}` : ''}`;
}
