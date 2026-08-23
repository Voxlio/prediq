/* =============================================================================
   scorecard.js — the one line on the front page that says how the model has
   actually been doing lately.

     11 OF 19 CALLED YESTERDAY  /  4 IN A ROW  /  SEE THE RECORD

   WHY THIS EXISTS SEPARATELY FROM THE RECORD PAGE

   record.html already shows every prediction against what happened, and almost
   nobody clicks it. A site that publishes its own accuracy and then keeps that
   accuracy one navigation away is technically honest and practically silent, so
   this puts the smallest true version of it where it cannot be missed.

   It is deliberately the *recent* figure and not the all-time one. The all-time
   hit rate is the better statistic and the worse headline: it is an average over
   the whole archive, so it barely moves, and a number that never changes is not a
   reason to come back tomorrow. record.js's runOfPlay() answers the question a
   visitor actually has — how did it do last time out, and is it on a run.

   NO NEW REQUEST, NO SCORING LOGIC HERE

   Everything printed comes precomputed out of `recent` in data/summary.json,
   which the footer counter already downloads on this page. Working it out in the
   browser would mean fetching every day file in the archive to answer a question
   about the last one, and it would put a second definition of "a correct call"
   in a second file. store.js calls runOfPlay() once when the scorer runs; this
   file only formats what it finds.

   The consequence worth knowing: these figures are as fresh as the last Actions
   run, not as fresh as the last final whistle. The archive workflow settles
   results every few hours, so a match that ended twenty minutes ago is usually
   not in here yet. That is why nothing on this line claims to be live.

   THE SEAM: `scoreParts` is pure and `mountScorecard` takes its fetch and its
   clock as arguments, so the whole thing is testable without a browser.
   ========================================================================== */

import {
  el, icon, setStatus, dayLabel, daysFromToday,
  CHECK, FLAME, HISTORY, ARROW_RIGHT,
} from './dom.js';

/* The same path vitals.js uses, and store.js's paths.summary() before that. */
export const SUMMARY = 'data/summary.json';

/* Relative words where they read naturally, a date where they don't.
   "11 of 19 called yesterday" is a sentence; "11 of 19 called on Saturday 22
   August" is a sentence; "11 of 19 called Yesterday" is neither, which is why
   dom.js's dayLabel() is not used directly for the near days. */
export function whenLabel(key, now = new Date()) {
  const n = daysFromToday(key, now);
  /* n can be POSITIVE here, and that is not a bug to be defended against later.
     Archive day keys are written in UTC — dom.js's long comment explains why the
     writer and reader have to agree on that — while daysFromToday compares
     against the reader's own calendar date. A reader west of Greenwich, early in
     their day, can therefore see a key one ahead of their today. "today" is the
     least wrong word available; dayLabel() would say "Tomorrow", which is
     nonsense about a match that has already been played and scored. */
  if (n >= 0) return 'today';
  if (n === -1) return 'yesterday';
  return 'on ' + dayLabel(key, now);
}

/* Not dom.js's stat(), for the same reason vitals.js's vital() isn't: stat()
   serves three status strips whose figures carry no artwork, and bolting an
   optional icon onto it would grow an options bag on a helper used in a dozen
   places to suit one. Six lines here is the cheaper answer.

   The icon comes first and the number second on purpose — the eye lands on the
   glyph, which is the fastest way to tell three figures apart at 11px, and then
   reads the figure it labels. */
function figure(paths, value, label) {
  const s = el('span');
  s.append(
    icon(paths, 'sc-i'),
    el('b', null, String(value)),
    document.createTextNode(' ' + label));
  return s;
}

/* Returns the parts for setStatus(), or an empty array meaning "print nothing".

   Nothing is the right answer more often than it looks: a fresh archive, a
   summary file written before `recent` existed, a day whose matches have all
   kicked off but none of which are settled yet. In every one of those cases an
   invented zero would be a claim about football nobody has scored, so the line
   simply does not appear — the same rule the footer's day series follows, and the
   reason .scorecard:empty is in the stylesheet. */
export function scoreParts(recent, now = new Date()) {
  const days = recent && Array.isArray(recent.days) ? recent.days : [];
  const latest = days[0];
  if (!latest || !Number.isInteger(latest.n) || latest.n < 1) return [];

  const out = [
    figure(CHECK, latest.hits + ' of ' + latest.n, 'called ' + whenLabel(latest.day, now)),
  ];

  /* Two, not one. "1 in a row" is not a run, it is a match, and printing it
     would make the phrase meaningless on the days it appears. Zero is a live
     miss and says so by staying quiet. */
  if (Number.isInteger(recent.streak) && recent.streak >= 2) {
    out.push(figure(FLAME, recent.streak, 'in a row'));
  }

  /* Only once there is more than one day in the archive, and only when it adds
     something the first figure did not: with a single settled day the window is
     the same two numbers again, and repeating them reads as padding. */
  const w = recent.window;
  if (w && w.days > 1 && w.n > latest.n) {
    out.push(figure(HISTORY, w.hits + ' of ' + w.n, 'over ' + w.days + ' days'));
  }

  /* The arrow trails the text here rather than leading it, which is the one
     inconsistency with the figures above and is deliberate: on the figures the
     glyph is a label for what follows, and on a link it is the direction the
     link goes. Putting it in front would point back at the sentence. */
  const link = el('a', null, 'see the record');
  link.href = 'record.html';
  link.append(icon(ARROW_RIGHT, 'sc-i sc-go'));
  out.push(link);
  return out;
}

/* Never awaited by the boot and never throws. A missing or unreachable archive
   costs this line and nothing else — the fixtures below it do not depend on the
   record, and a visitor who came for tomorrow's predictions should not lose them
   because a JSON file 404'd. */
export async function mountScorecard({
  node = document.getElementById('scorecard'),
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!node) return null;

  let recent = null;
  try {
    const res = await fetchImpl(SUMMARY, { cache: 'no-cache' });
    if (res.ok) recent = (await res.json())?.recent ?? null;
  } catch { /* nothing to print, which is already a handled state */ }

  const parts = scoreParts(recent, now);
  if (parts.length) setStatus(node, parts);
  return recent;
}
