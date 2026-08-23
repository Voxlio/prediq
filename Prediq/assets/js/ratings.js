/* =============================================================================
   ratings.js — the boot for the ratings page.

   Fetch, fit, wire, paint. Every node the view needs is looked up here and
   handed to it, so table.js can be run against a DOM shim in a test without a
   browser anywhere in sight.

   The page fetches no fixtures at all — it has nothing to do with them, and on
   a cold visit that is six requests saved.
   ========================================================================== */

import { loadAll } from './api.js';
import { buildIndex } from './model.js';
import {
  showRatings, showLoading, showProgress, showFatal, nextSort, DEFAULT_SORT,
} from './table.js';

const nodes = {
  mount: document.getElementById('table'),
  status: document.getElementById('status'),
  scope: document.getElementById('scope'),
};

/* Scope lives in the query string rather than in storage, so a particular view
   can be linked to and nothing is written to the reader's machine that they did
   not already get from the cache. */
const readScope = () =>
  new URLSearchParams(location.search).get('scope') === 'global' ? 'global' : 'league';

const state = { scope: readScope(), sort: { ...DEFAULT_SORT } };

async function boot() {
  showLoading(nodes);

  let data;
  try {
    data = await loadAll({
      withFixtures: false,
      onProgress: (done, total) => showProgress(nodes.status, done, total),
    });
  } catch (err) {
    showFatal(nodes.mount, nodes.status, err && err.message);
    return;
  }

  const index = buildIndex(data);
  const paint = () => showRatings(nodes, index, data, state, handlers);

  const handlers = {
    onSort(col) {
      state.sort = nextSort(state.sort, col);
      paint();
    },
    onScope(id) {
      state.scope = id;
      const url = new URL(location.href);
      if (id === 'global') url.searchParams.set('scope', 'global');
      else url.searchParams.delete('scope');
      history.replaceState(null, '', url);
      paint();
    },
  };

  paint();
}

boot();
