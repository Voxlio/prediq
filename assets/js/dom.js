/* =============================================================================
   dom.js — the furniture every page shares.

   Element building, the status strip, and the notices that can appear anywhere.
   There is no build step here, so anything used by more than one page lives in
   this file rather than being copied into each: a copied notice is a notice
   that will eventually say two different things.

   The no-innerHTML rule holds across every page that imports this. Each string
   reaching the document goes through textContent or a text node, so a team name
   or bookmaker name coming back from ESPN can never be read as markup. That is
   a deliberate constraint — it means the site cannot be made to render hostile
   content by a change at the far end of an API we do not control.
   ========================================================================== */

import { LEAGUES } from './config.js';

/* =============================================================================
   1. ELEMENTS
   ========================================================================== */

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* A label→value pair, the densest honest way to publish a figure. Used by the
   card readout and by both ratings tables. */
export function field(dl, term, value, title) {
  const box = el('div');
  if (title) box.title = title;
  box.append(el('dt', null, term), el('dd', null, value));
  dl.append(box);
  return box;
}

/* =============================================================================
   2. THE STATUS STRIP

   Every page carries one: a few counts of what the page is actually built from,
   so the reader can see the evidence base rather than take it on trust.
   ========================================================================== */

export function stat(value, label) {
  const s = el('span');
  s.append(el('b', null, String(value)), document.createTextNode(' ' + label));
  return s;
}

export function setStatus(node, parts) {
  if (!node) return;
  clear(node);
  parts.forEach((part, i) => {
    if (i) node.append(el('span', 'status-sep', '/'));
    node.append(typeof part === 'string' ? el('span', 'status-mute', part) : part);
  });
}

/* The label is the honest name of whatever is actually happening. Prediq loads
   in two phases and they are not the same activity: the first is reading
   fixture lists, the second is reading league tables and results. A bar that
   said "building model" through both would be wrong for half its life. */
export function showProgress(statusNode, done, total, label = 'building model') {
  setStatus(statusNode, [stat(`${done}/${total}`, 'requests'), label]);
}

/* =============================================================================
   3. NOTICES
   ========================================================================== */

export function notice(title, body, kind) {
  const box = el('div', kind ? `notice is-${kind}` : 'notice');
  box.append(el('p', 'notice-title', title), el('p', 'notice-body', body));
  return box;
}

export function showFatal(mount, statusNode, message) {
  setStatus(statusNode, ['could not load']);
  clear(mount);
  mount.append(notice(
    'No data reached the page',
    message || 'The football data source could not be reached. This is usually temporary — try again in a minute. Nothing is shown rather than something invented.',
    'warn'));
}

/* api.js records failures by league slug, because that is the machine-readable
   identity. Turning "eng.1" into "Premier League" is this layer's job. */
export function leagueName(slug) {
  return LEAGUES.find(l => l.slug === slug)?.name ?? slug;
}

/* A partial failure is stated plainly rather than papered over. The caller
   supplies the consequence, because it differs by page — a missing league
   weakens a prediction and removes a whole block of the ratings table. */
export function errorNotice(errors, consequence) {
  const failed = [...new Set(errors.map(e => leagueName(e.league)))];
  const n = errors.length;
  return notice(
    'Some data did not load',
    `${n} request${n === 1 ? '' : 's'} failed, affecting ${failed.join(', ')}. ${consequence}`,
    'warn');
}

/* =============================================================================
   4. DAYS

   Two pages navigate by day — fixtures forward, the record back — so the key
   format, the labelling and the strip of buttons all live here. Two copies would
   eventually disagree about which day a 22:00 kickoff belongs to, and the two
   pages would then be describing the same match differently.

   A DAY KEY IS A CALENDAR LABEL, NOT AN INSTANT.

   `YYYY-MM-DD` is turned back into a Date by rebuilding local midnight from its
   three parts, never by parsing it as a moment. `new Date('2026-08-23')` is
   midnight UTC, which renders as the 22nd for every reader west of Greenwich.
   Shifting to midday UTC fixes that and then renders as the 24th at UTC+13 and
   UTC+14 — Kiritimati and Tongatapu are real places with real readers, and the
   bug survives review precisely because it passes at UTC, at −7 and at +1. Local
   midnight is the same calendar date in every zone, because it never crosses a
   boundary at all.

   The two pages derive their keys from different places, which is correct rather
   than inconsistent. The record page reads keys the archive wrote in UTC, so the
   writer and the reader always agree which file a late kickoff was filed under.
   The fixtures page derives keys from kickoff instants in the READER's zone, so
   a 22:00 UTC match sits under Monday in Lagos and Sunday in Los Angeles — the
   day each of them will actually watch it. For late kickoffs the two can
   therefore differ by one, and each is right about its own question.
   ========================================================================== */

const fmtWeekday  = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fmtDayNum   = new Intl.DateTimeFormat(undefined, { day: 'numeric' });
const fmtDayFull  = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const pad = n => String(n).padStart(2, '0');

/* An instant → the calendar date it falls on in the reader's own zone. */
export const localDayKey = d =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

export const dayKeyToDate = key => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/* Whole days between two calendar dates, signed, future positive.
   Rounded rather than floored because two local midnights are 23 or 25 hours
   apart across a daylight-saving change, and an unrounded division would put
   "Tomorrow" a day out twice a year. */
export const daysFromToday = (key, now = new Date()) =>
  Math.round((+dayKeyToDate(key) - +dayKeyToDate(localDayKey(now))) / 864e5);

/* The unabbreviated label, and the only place "Today" is decided. A reader
   choosing what to look at wants the relative word far more than the date, and
   the fixtures page's day headings said "Today" long before the tabs existed —
   heading and tab now come from the same function so they cannot disagree. */
export function dayLabel(key, now = new Date()) {
  const n = daysFromToday(key, now);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return fmtDayFull.format(dayKeyToDate(key));
}

/* =============================================================================
   THE DAY STRIP

   Buttons, not links, and one per day there is actually something to show. A tab
   that turns out to be empty costs a click and reads as breakage rather than as
   "no football that day", so callers pass only the days they hold.
   ========================================================================== */
export function dayStrip(days, current, onPick, { now = new Date() } = {}) {
  const box = el('div', 'toggle');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Pick a day');

  for (const day of days) {
    const on = day === current;
    const today = daysFromToday(day, now) === 0;
    const d = dayKeyToDate(day);

    const b = el('button', 'toggle-b daytab' + (on ? ' is-on' : '') + (today ? ' is-today' : ''));
    b.type = 'button';

    /* Weekday and day number are separate spans so the stylesheet can drop the
       weekday on a narrow screen: seven tabs carrying "Sat 23 Aug" need about
       49rem and the page is 42rem, so something has to go. A horizontally
       scrolling strip was the alternative, and at 320px it would leave two days
       off-screen with nothing to indicate they were there.

       "Today" replaces the pair outright — it is shorter than the date it stands
       in for and needs no number to be unambiguous. It survives the narrow
       breakpoint by its own rule, since a hidden weekday would leave an empty
       button. */
    if (today) b.append(el('span', 'daytab-wd', 'Today'));
    else b.append(el('span', 'daytab-wd', fmtWeekday.format(d)),
                  el('span', 'daytab-d', fmtDayNum.format(d)));

    /* The full date, always, because every label above is an abbreviation and
       "Today" hides the date completely. */
    b.title = dayLabel(day, now) + ' · ' + fmtDayShort.format(d);

    /* The machine-readable key rides along, so a test — and anyone reading the
       DOM — can tell which button means which day without parsing a label that
       changes with the reader's locale. */
    b.dataset.day = day;

    if (on) {
      b.setAttribute('aria-current', 'date');
      b.disabled = true;
    } else {
      b.addEventListener('click', () => onPick(day));
    }
    box.append(b);
  }
  return box;
}
