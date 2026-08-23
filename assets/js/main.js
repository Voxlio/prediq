/* =============================================================================
   main.js — the entry point. Deliberately short.

   Its job is to run the load in two phases and route every possible outcome to
   the right page state:

       fixtures  →  draw the list  →  league tables and results  →  predict

   Phase 1 is one request per competition. Phase 2 is the expensive half: two
   league tables and several months of results for each domestic division. The
   list is drawn between them, so nobody waits through phase 2 to find out what
   is on this week — and because the model is fitted once, at the end, a card
   goes from "working" straight to its final numbers and never shows one
   probability and then a different one.

   Everything that can actually go wrong is handled here, so the other files
   stay free of error plumbing.

   WHY THERE IS A STATE OBJECT AND A SINGLE paint()

   The page has two independent inputs now: how far the load has got, and which
   day the reader picked. Either can change while the other is mid-flight — a
   tab click during phase 2 is the ordinary case, not an edge case. Written as
   straight-line calls, phase 2 finishing would redraw the list from the whole
   week and silently throw away a selection the reader made a second earlier.

   So both inputs live in `state`, and `paint()` is the only function that writes
   to the document. Nothing else touches the mount. That makes the two orderings
   — pick then load, load then pick — produce the same page, because there is
   only one function deciding what the page is.
   ========================================================================== */

import { clearCache, estimateModelJobs, loadFixtures, loadModel } from './api.js';
import { predictAll } from './model.js';
import { FIXTURE_DAYS, LEAGUES } from './config.js';
import { clear, dayStrip } from './dom.js';
import * as view from './render.js';

const nodes = {
  mount: document.getElementById('fixtures'),
  status: document.getElementById('status'),
  /* Optional. Without it the page shows the whole window, exactly as it did
     before the tabs existed — the filter is never applied without a control to
     undo it, or a reader could be stuck on a Tuesday with no way back. */
  strip: document.getElementById('days'),
};

const state = {
  phase: 'loading',
  fixtures: [],
  predictions: null,
  index: null,
  data: null,
  message: null,
  day: null,
};

/* =============================================================================
   THE DAY IN THE URL

   ?day=2026-08-24 makes a day linkable, bookmarkable and reload-proof. Written
   with replaceState rather than pushState on purpose: a tab is a filter on one
   page, not a place, and pushing would fill the history with days so that Back
   walks through six of them instead of leaving the site.
   ========================================================================== */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dayFromURL() {
  try {
    const q = new URLSearchParams(location.search).get('day');
    /* Shape-checked here and existence-checked in paint(), which drops a day the
       fixture list does not hold — so a stale bookmark lands on real football
       rather than on an empty page. */
    return q && DAY_KEY.test(q) ? q : null;
  } catch {
    return null;
  }
}

function syncURL(day) {
  try {
    const url = new URL(location.href);
    if (day) url.searchParams.set('day', day);
    else url.searchParams.delete('day');
    history.replaceState(null, '', String(url));
  } catch {
    /* A URL that cannot be rewritten is not worth failing a render over. */
  }
}

/* =============================================================================
   PAINTING
   ========================================================================== */

function pick(day) {
  state.day = day;
  paint();

  /* Back to the top. The reader asked to see a different day, and the first
     match of it is the answer; without this, clicking a tab from halfway down a
     long Saturday leaves you halfway down a short Tuesday, looking at whatever
     happens to sit at that scroll offset. */
  if (typeof scrollTo === 'function') scrollTo({ top: 0, behavior: 'smooth' });
}

function paintStrip(days) {
  if (!nodes.strip) return;
  clear(nodes.strip);
  /* One day is not a choice. A strip holding a single disabled button reads as
     a broken control rather than as "this is the only day with football". */
  if (days.length > 1) nodes.strip.append(dayStrip(days, state.day, pick));
}

function paint() {
  /* The days on offer come from whatever this paint is about to draw, not from a
     parallel list. Both collections happen to cover the same days today — api.js
     drops a match that has already kicked off, so phase 1 and phase 2 agree —
     but reading them from the thing being rendered means a tab cannot outlive
     the fixtures behind it if that ever stops being true. An empty tab reads as
     breakage rather than as "no football that day". */
  const days = state.predictions
    ? view.fixtureDays(state.predictions, p => p.fixture.date)
    : view.fixtureDays(state.fixtures);

  /* Nothing is decided about the day until there is a fixture list to decide it
     against. In particular the day from the URL is left alone through the whole
     load: reconciling it against an empty list would throw a deep link away
     before the data that justifies it had arrived. */
  if (days.length) {
    /* A day that holds no fixtures is replaced by the nearest one that does —
       a shared link, a bookmark from last week, a page left open past midnight.
       A null day becomes the first day with football, which is the default view:
       today when there is something on, otherwise the next day there is. */
    if (!days.includes(state.day)) state.day = days[0];

    /* Written here rather than in pick(), so the URL describes the page however
       the day was arrived at — clicked, linked, or defaulted to. A link copied
       from the address bar on the opening day should still mean that day
       tomorrow, and a stale ?day= should be corrected to the day actually
       shown rather than left contradicting the page. */
    syncURL(state.day);
  }

  paintStrip(days);

  const day = nodes.strip ? state.day : null;

  switch (state.phase) {
    case 'fatal':
      return view.showFatal(nodes.mount, nodes.status, state.message);
    case 'empty':
      return view.showEmpty(nodes.mount, nodes.status, FIXTURE_DAYS);
    case 'fixtures':
      return view.showFixtureList(nodes.mount, nodes.status, state.fixtures, day);
    case 'fallback':
      return view.showFixtureFallback(nodes.mount, nodes.status, state.fixtures, state.message, day);
    case 'predictions':
      return view.showPredictions(nodes.mount, nodes.status, state.predictions, state.index, state.data, day);
    default:
      return view.showLoading(nodes.mount, nodes.status);
  }
}

/* =============================================================================
   THE LOAD
   ========================================================================== */

async function boot() {
  state.day = dayFromURL();
  paint();

  /* Phase 2's size is known before it starts, which is what lets one bar span
     both phases instead of restarting at the halfway point. */
  const later = estimateModelJobs();
  const first = LEAGUES.length;

  /* Neither loader throws for a failed request — that lands in `errors` — so a
     rejection here means something structural, not a flaky network. */
  let fx;
  try {
    fx = await loadFixtures({
      onProgress: (done, total) =>
        view.showProgress(nodes.status, done, total + later, 'reading fixtures'),
    });
  } catch (err) {
    state.phase = 'fatal';
    state.message = err && err.message;
    return paint();
  }

  if (!fx.fixtures.length) {
    /* No fixtures could mean a genuine quiet week, or that every request
       failed. Those deserve different messages. Three of the fourteen
       competitions are European and sit idle for months at a time, so some
       empty replies are normal and only a total failure is an error. */
    if (fx.errors.length === first) {
      state.phase = 'fatal';
      state.message =
        `Every attempt to reach the football data source failed (${fx.errors.length} requests). ` +
        `Prediq shows nothing rather than inventing numbers. Try again shortly.`;
    } else {
      state.phase = 'empty';
    }
    return paint();
  }

  /* The useful half of the page, as early as it can honestly be drawn. This is
     also where the tabs first appear: the days on offer come from the fixtures,
     so they cannot be known before now, and a strip drawn any earlier would be
     guessing at a calendar. */
  state.phase = 'fixtures';
  state.fixtures = fx.fixtures;
  paint();

  let md;
  try {
    md = await loadModel({
      onProgress: (done, total) =>
        view.showProgress(nodes.status, first + done, first + total, 'building model'),
    });
  } catch (err) {
    /* The fixtures are already on screen and still true. Rather than throw the
       page away, keep the list and say what is missing from it. */
    state.phase = 'fallback';
    state.message = err && err.message;
    return paint();
  }

  const data = {
    ...md,
    fixtures: fx.fixtures,
    errors: [...fx.errors, ...md.errors],
  };

  const { index, predictions } = predictAll(data);

  /* The day the reader is on survives this transition untouched, which is the
     whole reason for the state object: phase 2 typically lands after they have
     already started browsing. */
  state.phase = 'predictions';
  state.predictions = predictions;
  state.index = index;
  state.data = data;
  paint();
}

/* A cache this aggressive needs an escape hatch. From the browser console:
   prediq.rebuild()  — drop everything cached and refit from fresh requests. */
window.prediq = {
  rebuild() {
    const n = clearCache();
    console.log(`Cleared ${n} cached entries. Reloading.`);
    location.reload();
  },
};

boot();
