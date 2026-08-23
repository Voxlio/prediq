/* =============================================================================
   verdicts.js — the boot for the record page.

   Read the archive, pick a day, paint it. The whole page is three static JSON
   files and no model: unlike every other page on the site, nothing here is
   computed from live data, because the point is to show what was computed
   *before* the match rather than what the model thinks now.

   WHY THIS READS THE REPO AND NOT FIRESTORE

   The records are in both places. The repo copy is chosen because it is faster
   (a static file on the same origin, cached by the browser, no SDK to download),
   free at any traffic level, and — the real reason — publicly auditable. A
   visitor who doubts a verdict on this page can open the same JSON in the
   repository and read the commit that put it there. Reading through Firestore
   would hand them a number with no history behind it.

   REQUESTS THIS COSTS

   Two on arrival: index.json and summary.json, both small. Then one per day the
   reader actually looks at, kept in a Map so flipping back to a day already seen
   is free. The day strip is built from index.json, so the page never fetches a
   day to find out whether it has anything in it.
   ========================================================================== */

import { httpSource, loadIndex, loadDay, loadSummary, recentDays } from './store.js';
import { RECORD_DAYS } from './config.js';
import {
  dayStrip, showDay, showLoading, showNoArchive, showNotServed, showFatal,
} from './ledger.js';

const nodes = {
  mount: document.getElementById('ledger'),
  status: document.getElementById('status'),
  strip: document.getElementById('days'),
};

/* Same convention as the ratings page: the view state lives in the query string,
   so a particular day can be linked to or bookmarked, and nothing is written to
   the reader's machine. */
const readDay = () => new URLSearchParams(location.search).get('day');

const today = () => new Date().toISOString().slice(0, 10);

/* Which days the strip offers: the last RECORD_DAYS calendar days, narrowed to
   the ones the archive actually holds a file for. Newest first, which is the
   order recentDays already returns.

   Narrowing matters. Offering a day with no file would mean showing an empty
   page for most of the strip in the archive's first fortnight, and an empty page
   is indistinguishable from a broken one. */
function offeredDays(index) {
  const have = new Set(index.days);
  return recentDays(RECORD_DAYS).filter(d => have.has(d));
}

/* The day the page opens on.

   Not simply the newest. This page is about completed football: today's
   predictions are still in flight, and landing a reader on a column of "not
   played yet" answers a question they did not ask — the fixtures page is where
   an unplayed prediction belongs. So the default is the newest day that is not
   today, and today only when the archive has nothing older. A day is one click
   away either way. */
function defaultDay(offered) {
  const t = today();
  return offered.find(d => d !== t) ?? offered[0];
}

async function boot() {
  /* Before any fetch, because the failure this catches produces a TypeError with
     no useful message and would otherwise read as "the archive is unreachable". */
  if (location.protocol === 'file:') return showNotServed(nodes.mount, nodes.status);

  const read = httpSource();
  showLoading(nodes.mount, nodes.status);

  let index, summary;
  try {
    [index, summary] = await Promise.all([loadIndex(read), loadSummary(read)]);
  } catch (err) {
    showFatal(nodes.mount, nodes.status, err && err.message);
    return;
  }

  const offered = offeredDays(index);
  if (!offered.length) return showNoArchive(nodes.mount, nodes.status);

  /* How many matches have settled *under the current model revision*, which is
     the number the rate gate in ledger.js is asking about. Not the archive's
     total: results produced by a model that has since been retuned are not
     evidence about the one running now, so they must not be what unlocks a
     percentage attributed to it. summarise() draws the same distinction. */
  const totalSettled = summary?.overall?.scored ?? 0;

  const wanted = readDay();
  let current = offered.includes(wanted) ? wanted : defaultDay(offered);

  const cache = new Map();

  async function paint(day) {
    current = day;

    /* Rebuilt rather than mutated, so the strip cannot drift out of step with
       the day on show — there is one place that decides which button is on. */
    nodes.strip.replaceChildren(dayStrip(offered, current, pick));

    let file = cache.get(day);
    if (!file) {
      showLoading(nodes.mount, nodes.status);
      try {
        file = await loadDay(read, day);
      } catch (err) {
        showFatal(nodes.mount, nodes.status, err && err.message);
        return;
      }
      cache.set(day, file);
    }

    /* A slow request for a day the reader has since clicked away from must not
       repaint over the day they are now looking at. */
    if (current !== day) return;
    showDay(nodes.mount, nodes.status, file, totalSettled);
  }

  function pick(day) {
    const url = new URL(location.href);
    if (day === defaultDay(offered)) url.searchParams.delete('day');
    else url.searchParams.set('day', day);
    history.replaceState(null, '', url);
    paint(day);
  }

  paint(current);
}

boot();
