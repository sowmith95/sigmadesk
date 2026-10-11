// How long ago a ticket was created, for chips and cards in both the app and the classic board (pure, no DOM).
/**
 * A ticket's age since creation, compact enough for a chip: "now", "12m", "3h", "2d", then the date ("Oct 7") after a
 * week, with the year when it is not this year ("Dec 20, 2025"). A timestamp in the future (clock skew) reads "now".
 * Whole units, rounded down, so a boundary never jumps ahead (59 min is "59m", not "1h").
 */
export function createdAge(iso, now = Date.now(), { timeZone } = {}) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const s = (now - at) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const year = (ms) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(ms);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone, ...(year(at) !== year(now) ? { year: 'numeric' } : {}) }).format(at);
}
/** The full local creation time for a hover title and an accessible label: "Created Oct 7, 2026, 3:37 PM". */
export function createdTitle(iso, { timeZone } = {}) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  return `Created ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(at).replace(/[\u202f\u00a0]/g, ' ')}`;
}
