/* =============================================================================
   store.js — reading and writing the frozen record archive.

   Shared between the browser and the scheduled writer, which is why it does no
   network access of its own beyond one plain fetch, and touches no Node APIs.
   The writer passes in its own file-backed adapter; the browser uses the
   default, which fetches the JSON that the writer committed.

   THE LAYOUT

     data/index.json          { updatedAt, days: ["2026-08-23", ...], revs }
     data/2026-08-23.json     { day, updatedAt, records: [ ... ] }
     data/summary.json        { at, byRev: { "1.0": {...} }, overall }

   One file per UTC day, because that is the unit the site reads: a visitor
   looking at yesterday's results wants one request, not one per match. A day in
   the busiest week of a season holds around sixty records — roughly 30 KB, well
   inside a single cached response.

   `index.json` exists so the browser can know which days are available without
   probing for 404s. `summary.json` is precomputed because an accuracy page over
   two seasons would otherwise have to download every record to add them up.

   WHY THE SUMMARY IS ALLOWED TO BE PRECOMPUTED

   record.js insists that judgements are derived rather than stored, and a stored
   summary looks like a violation. The distinction that makes it safe: the
   summary is produced by the same summarise() the browser would call, so the
   two cannot disagree about *method* — only about *freshness*. It therefore
   carries `at` and `n`, and the page states both, so a stale figure is visible
   as staleness rather than passing as a current one.
   ========================================================================== */

import { dayKey, summarise } from './record.js';

export const DATA_DIR = 'data';
export const paths = {
  index: () => DATA_DIR + '/index.json',
  day: d => DATA_DIR + '/' + d + '.json',
  summary: () => DATA_DIR + '/summary.json',
};

/* --- the default source: files the writer committed -------------------------
   A missing day is not an error. Most days before the site existed have no
   file, and so does tomorrow. `null` means "nothing recorded", which the caller
   must be able to show as an empty state rather than a failure.

   404 is separated from every other failure on purpose. A missing file is a
   fact about the archive; a 500 or a dropped connection is a fact about the
   network, and the page should say different things about them.
--------------------------------------------------------------------------- */
export function httpSource({ base = '', fetchImpl = fetch } = {}) {
  return async function read(path) {
    const res = await fetchImpl(base + path, { cache: 'no-cache' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status + ' reading ' + path);
    return res.json();
  };
}

/* =============================================================================
   READING
   ========================================================================== */
export async function loadIndex(read) {
  const idx = await read(paths.index());
  if (!idx) return { updatedAt: null, days: [], revs: {} };
  return { updatedAt: idx.updatedAt ?? null, days: idx.days ?? [], revs: idx.revs ?? {} };
}

export async function loadDay(read, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('not a day key: ' + day);
  const file = await read(paths.day(day));
  if (!file) return { day, records: [], updatedAt: null };
  return { day, records: file.records ?? [], updatedAt: file.updatedAt ?? null };
}

export async function loadSummary(read) {
  return (await read(paths.summary())) ?? null;
}

/* Several days at once, for a rolling window. Days that have no file come back
   as empty rather than being dropped, so the caller can tell "no matches that
   day" from "that day is not in the range". */
export async function loadDays(read, days) {
  const out = [];
  for (const day of days) out.push(await loadDay(read, day));
  return out;
}

/* The N calendar days ending at `end`, most recent first — the shape a "recent
   results" view wants. UTC throughout, to match the day keys. */
export function recentDays(n, end = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/* =============================================================================
   WRITING

   Only the scheduled writer calls these, and it passes its own `write`. They
   live here rather than in the writer so that the file layout is defined in one
   place — a reader and a writer that each described the layout separately would
   eventually describe it differently.
   ========================================================================== */

/* --- merging a day ---------------------------------------------------------
   The one rule that matters: A RECORD IS WRITTEN ONCE AND NEVER OVERWRITTEN.

   The writer runs several times a day and will see the same fixture repeatedly.
   Re-freezing it each time would keep moving `predicted.at` closer to kickoff,
   quietly shrinking the lead time the archive appears to show — and the earliest
   honest prediction is the one worth keeping, because it is the one made with
   the least information.

   The single exception is attaching a result to a record that has none. That is
   new information about a finished match, not a revised prediction, and it is
   the only field this function will ever change on an existing record.
--------------------------------------------------------------------------- */
export function mergeDay(existing, incoming) {
  const byId = new Map((existing || []).map(r => [r.id, r]));
  const added = [], settled = [], kept = [];

  for (const rec of incoming) {
    const prior = byId.get(rec.id);
    if (!prior) {
      byId.set(rec.id, rec);
      added.push(rec.id);
      continue;
    }
    if (!prior.result && rec.result) {
      byId.set(rec.id, { ...prior, result: rec.result });
      settled.push(rec.id);
      continue;
    }
    kept.push(rec.id);
  }

  const records = [...byId.values()]
    .sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : a.id < b.id ? -1 : 1));

  return { records, added, settled, kept };
}

/* --- stable serialisation --------------------------------------------------
   Every write lands in a git commit, so the diff has to mean something. Keys go
   out in a fixed order and the file ends with a newline, which makes a real
   change show as a real change instead of as a reshuffle. `updatedAt` is the
   one field that moves on every run; it is at the top so it never obscures a
   line that matters.
--------------------------------------------------------------------------- */
export function serialise(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/* --- writing only when something actually changed --------------------------
   index.json and summary.json are both derived: run the writer twice with no
   new matches and they come out identical except for their timestamp. Writing
   them anyway would put a commit in the history for every scheduled run, and a
   history where most commits say nothing is not an audit trail — it is a place
   an audit trail used to be.

   So the timestamp is excluded from the comparison and restored on the way out.
   `at` and `updatedAt` are still accurate when they move; they just stop moving
   on their own.
--------------------------------------------------------------------------- */
async function writeIfChanged(io, path, payload, stampKey) {
  const before = await io.read(path);
  if (before) {
    const strip = o => { const { [stampKey]: _, ...rest } = o; return serialise(rest); };
    if (strip(before) === strip(payload)) return { path, changed: false, payload: before };
  }
  await io.write(path, serialise(payload));
  return { path, changed: true, payload };
}

export async function writeDay(io, day, records, now = new Date()) {
  const before = await io.read(paths.day(day));
  const merge = mergeDay(before?.records ?? [], records);
  const changed = merge.added.length > 0 || merge.settled.length > 0;

  /* Not writing an unchanged file is not an optimisation — it stops the archive
     accumulating commits that only bump a timestamp, which would make the git
     history useless as the audit trail it is supposed to be. */
  if (!changed) return { ...merge, changed: false, day };

  await io.write(paths.day(day), serialise({
    day,
    updatedAt: now.toISOString(),
    records: merge.records,
  }));
  return { ...merge, changed: true, day };
}

export async function writeIndex(io, now = new Date()) {
  const days = (await io.list()).sort();
  const revs = {};
  for (const day of days) {
    const file = await io.read(paths.day(day));
    for (const r of file?.records ?? []) {
      const k = r.model?.rev ?? 'unknown';
      revs[k] = (revs[k] || 0) + 1;
    }
  }
  const res = await writeIfChanged(
    io, paths.index(), { updatedAt: now.toISOString(), days, revs }, 'updatedAt');
  return { days, revs, changed: res.changed };
}

/* --- the summary ----------------------------------------------------------
   Computed over every record in the archive, grouped by model revision, using
   the same summarise() the browser has. `overall` is the current revision only:
   a figure pooled across revisions would credit today's model with the results
   of one that no longer exists.
--------------------------------------------------------------------------- */
export async function writeSummary(io, currentRev, now = new Date()) {
  const days = (await io.list()).sort();
  const all = [];
  for (const day of days) {
    const file = await io.read(paths.day(day));
    all.push(...(file?.records ?? []));
  }

  const revs = [...new Set(all.map(r => r.model?.rev ?? 'unknown'))].sort();
  const byRev = {};
  for (const rev of revs) byRev[rev] = summarise(all, { rev });

  const payload = {
    at: now.toISOString(),
    n: all.length,
    days: days.length,
    currentRev,
    /* Stated rather than left implicit, because it is the caveat the accuracy
       page has to print: how much of the archive the headline figure covers. */
    coverage: all.length ? (byRev[currentRev]?.n ?? 0) / all.length : null,
    overall: byRev[currentRev] ?? null,
    byRev,
  };
  const res = await writeIfChanged(io, paths.summary(), payload, 'at');
  /* The stored payload, not the one just computed. They differ only in `at`, but
     a caller printing "as of" should print what a reader would see. */
  return { ...res.payload, changed: res.changed };
}

/* --- which days still need results ----------------------------------------
   A day is unsettled if it holds a record whose kickoff has passed and which
   has no result yet. Kickoff plus a margin, not kickoff itself: a match is not
   over when it starts, and asking ESPN for a final score at half time gets a
   score that is not final.
--------------------------------------------------------------------------- */
export async function unsettledDays(io, now = new Date(), graceHours = 3) {
  const cutoff = +now - graceHours * 3600e3;
  const out = [];
  for (const day of (await io.list()).sort()) {
    const file = await io.read(paths.day(day));
    const pending = (file?.records ?? []).filter(r => !r.result && +new Date(r.kickoff) < cutoff);
    if (pending.length) out.push({ day, pending: pending.map(r => r.id) });
  }
  return out;
}

export { dayKey };
