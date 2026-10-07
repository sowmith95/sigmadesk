// Exchange-session calendar for the post-deploy watch's "next session open" checkpoint (sowmith95/sigmadesk#7).
//
// A small built-in table of NYSE full-day holidays and early closes for 2026–2027, with the regular session
// 09:30–16:00 America/New_York (early closes end at 13:00). Wall-clock times are converted with the IANA zone, so DST
// changes are handled by Intl, never by fixed offsets. The owner can extend or replace the table in the config:
//   deployWatch.calendar = { timezone, open: "09:30", close: "16:00",
//                            holidays: ["2028-01-17", ...], earlyCloses: { "2028-11-24": "13:00" }, replace: false }
// replace: true uses only the configured lists. A year the table does not cover is reported (`known: false`), so a
// checkpoint scheduled from the weekday rule alone says so in its evidence.
import { config } from './config.js';

export const BUILTIN = {
  timezone: 'America/New_York', open: '09:30', close: '16:00',
  years: [2026, 2027],
  holidays: [
    // 2026
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    // 2027 (Juneteenth observed Fri 18 Jun, Independence Day observed Mon 5 Jul, Christmas observed Fri 24 Dec)
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ],
  earlyCloses: { '2026-11-27': '13:00', '2026-12-24': '13:00', '2027-11-26': '13:00' },
};

/** The effective calendar: the built-in table merged with (or replaced by) deployWatch.calendar. */
export function calendar(over = config.deployWatch?.calendar || {}) {
  const o = over && typeof over === 'object' ? over : {};
  const replace = o.replace === true;
  const holidays = new Set([...(replace ? [] : BUILTIN.holidays), ...(Array.isArray(o.holidays) ? o.holidays.map(String) : [])]);
  const earlyCloses = { ...(replace ? {} : BUILTIN.earlyCloses), ...(o.earlyCloses && typeof o.earlyCloses === 'object' ? o.earlyCloses : {}) };
  const years = new Set([...(replace ? [] : BUILTIN.years), ...(Array.isArray(o.years) ? o.years.map(Number) : []),
    ...[...holidays].map((d) => Number(d.slice(0, 4)))]);
  return { timezone: o.timezone || BUILTIN.timezone, open: o.open || BUILTIN.open, close: o.close || BUILTIN.close, holidays, earlyCloses, years };
}

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar date (YYYY-MM-DD), weekday 0-6 and minutes after midnight of an instant in a zone. */
export function localParts(d, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day, mins: Number(parts.hour) * 60 + Number(parts.minute) };
}
/** The UTC instant of a wall-clock time on a local date in a zone (DST-correct: the offset is read at that instant). */
export function zonedTime(date, hhmm, tz) {
  const [y, m, dd] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, m - 1, dd, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t), tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const seen = Date.UTC(py, pm - 1, pd, Math.floor(p.mins / 60), p.mins % 60);
    if (seen === want) break;
    t += want - seen;
  }
  return new Date(t);
}
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
const weekday = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/** The session on a local date: null on weekends/holidays, else { date, open, close (Dates), early, known }. */
export function sessionOn(date, cal = calendar()) {
  const known = cal.years.has(Number(date.slice(0, 4)));
  const wd = weekday(date);
  if (wd === 0 || wd === 6 || cal.holidays.has(date)) return null;
  const closeAt = cal.earlyCloses[date] || cal.close;
  return { date, open: zonedTime(date, cal.open, cal.timezone), close: zonedTime(date, closeAt, cal.timezone), early: !!cal.earlyCloses[date], known };
}
/** Is the exchange in its regular session at this instant? */
export function isSessionOpen(at = new Date(), cal = calendar()) {
  const s = sessionOn(localParts(at, cal.timezone).date, cal);
  return !!s && at >= s.open && at < s.close;
}
/** The first session whose open is strictly after `after` (looks ahead at most three weeks). */
export function nextSessionOpen(after = new Date(), cal = calendar()) {
  let date = localParts(after, cal.timezone).date;
  for (let i = 0; i < 21; i++, date = addDays(date, 1)) {
    const s = sessionOn(date, cal);
    if (s && s.open > after) return s;
  }
  return null;
}
