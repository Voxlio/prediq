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
   ========================================================================== */

import { clearCache, estimateModelJobs, loadFixtures, loadModel } from './api.js';
import { predictAll } from './model.js';
import { FIXTURE_DAYS, LEAGUES } from './config.js';
import * as view from './render.js';

const mount = document.getElementById('fixtures');
const statusNode = document.getElementById('status');

async function boot() {
  view.showLoading(mount, statusNode);

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
        view.showProgress(statusNode, done, total + later, 'reading fixtures'),
    });
  } catch (err) {
    view.showFatal(mount, statusNode, err && err.message);
    return;
  }

  if (!fx.fixtures.length) {
    /* No fixtures could mean a genuine quiet week, or that every request
       failed. Those deserve different messages. Three of the fourteen
       competitions are European and sit idle for months at a time, so some
       empty replies are normal and only a total failure is an error. */
    if (fx.errors.length === first) {
      view.showFatal(mount, statusNode,
        `Every attempt to reach the football data source failed (${fx.errors.length} requests). ` +
        `Prediq shows nothing rather than inventing numbers. Try again shortly.`);
    } else {
      view.showEmpty(mount, statusNode, FIXTURE_DAYS);
    }
    return;
  }

  /* The useful half of the page, as early as it can honestly be drawn. */
  view.showFixtureList(mount, statusNode, fx.fixtures);

  let md;
  try {
    md = await loadModel({
      onProgress: (done, total) =>
        view.showProgress(statusNode, first + done, first + total, 'building model'),
    });
  } catch (err) {
    /* The fixtures are already on screen and still true. Rather than throw the
       page away, keep the list and say what is missing from it. */
    view.showFixtureFallback(mount, statusNode, fx.fixtures, err && err.message);
    return;
  }

  const data = {
    ...md,
    fixtures: fx.fixtures,
    errors: [...fx.errors, ...md.errors],
  };

  const { index, predictions } = predictAll(data);
  view.showPredictions(mount, statusNode, predictions, index, data);
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
