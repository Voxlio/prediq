/* =============================================================================
   vitals.js — the numbers in the footer, and the counter behind two of them.

     users        1,904 visits          ← Firestore, incremented here
     eye         12,481 page views      ← Firestore, incremented here
     check-check     26 matches scored   ← read from data/summary.json

     activity   today 412   Sat 22 388   Fri 21 401   …   ← the last week

   WHAT IS SENT, EXACTLY

   Two requests per page load, both to Firestore. The first adds 1 to a page-view
   counter and, on the first page of a visit, 1 to a visit counter — a total
   document and one for the day, in a single atomic commit. The second reads back
   the last few days so the footer can show the week.

   No account, no session, no referrer collection, no user agent parsing, no
   country, no device, no fingerprint. The documents hold two whole numbers each
   and there is nothing else in them. Firestore sees the request's IP because
   every HTTP request has one, and nothing here records it.

   THE ONE THING KEPT ON THE READER'S MACHINE

   A date, under `prediq:visit` in localStorage. It exists so that clicking from
   fixtures to the record page is one visit rather than two, which is the whole
   difference between a visit count and a page-view count. It is not a cookie —
   it is never attached to a request, never sent anywhere, and unreadable to any
   other site — and it is not an identifier, because a date shared by every
   reader who came today distinguishes nobody. But it IS a mark left on a device,
   so index.html, ratings.html and method.html all say so rather than letting the
   footer imply otherwise.

   It deliberately does not use CACHE.prefix, so `prediq.rebuild()` in the console
   clears every cached ESPN response and leaves this alone. Sharing the prefix
   would make a cache flush read as a new visit, and the one thing worse than an
   approximate number is one that quietly rises whenever a developer debugs.

   WHAT THE COUNTERS ARE WORTH

   Not much, and the method page says so. Firestore rules can constrain the SHAPE
   of a write — they insist this one adds exactly one view and at most one visit —
   but they cannot rate-limit, so anyone who opens a browser console can send the
   same request in a loop. A rough traffic indication, not an audited measurement.

   Both figures also undercount, in three known ways. method.html loads no
   JavaScript at all (asserted by tests/h1.mjs, and the reason that page needs no
   network access to be read), so this file never runs there and reading the
   method page adds nothing. A reader with storage unavailable — private mode,
   storage disabled, a full quota — is never counted as a visit, only as views.
   And two browsers, or two devices, are two visits.

   THE SEAM: every function takes its `fetch`, its clock and its storage from
   arguments, so tests/a1.mjs drives the whole thing with fakes and never touches
   the network or a browser.
   ========================================================================== */

import { FIREBASE, FIRESTORE_VIEWS, FIRESTORE_VIEWS_TOTAL } from './firebase-config.js';
import { VITALS_DAYS } from './config.js';
import { el, icon, clear, USERS, EYE, CHECK_CHECK, ACTIVITY } from './dom.js';

const REST = 'https://firestore.googleapis.com/v1';

/* The same resource-name-versus-URL distinction tools/firestore.mjs spells out at
   length: this is a Firestore resource name, so no scheme and no leading slash,
   and it serves both as the prefix of a document's identity and as part of the
   endpoint. Getting it wrong returns HTTP 200 with a per-write INVALID_ARGUMENT
   buried inside, which is why a1 pins both strings exactly rather than by
   substring. */
const docPath = () =>
  'projects/' + FIREBASE.projectId + '/databases/(default)/documents';

const collection = () => docPath() + '/' + FIRESTORE_VIEWS;

export const endpoint = op => REST + '/' + docPath() + ':' + op + '?key=' + FIREBASE.apiKey;

/* =============================================================================
   1. DAYS

   UTC here, and that is a deliberate exception to the rule dom.js argues for at
   length. Everywhere else a day key is a LOCAL calendar label, because it answers
   a question about one reader: which day will *you* watch this match on.

   Traffic is not a question about one reader. It arrives from every zone at once,
   so there is no local midnight to anchor to, and under any local rule two
   visitors a minute apart could land in different buckets depending only on where
   they were. UTC is the only day boundary all visitors share. It is the wrong
   choice for a fixture list and the right one here, and the two rules live in
   different files so neither looks like a mistake in the other.

   The labels are formatted in UTC for the same reason. Formatted locally, a
   reader in Los Angeles would see "Fri 21" against the bucket keyed 2026-08-22 —
   the label and the thing it labels would disagree by a day.
   ========================================================================== */
export const utcDayKey = (now = new Date()) => now.toISOString().slice(0, 10);

/* The N most recent UTC days, newest first. This is store.js's recentDays(),
   deliberately duplicated: importing store.js would pull record.js into the
   fixtures page's module graph — nineteen kilobytes of scoring logic that page
   has no use for — to obtain nine lines. a1 asserts the two agree over a span
   that crosses a month and a leap day, so the copy cannot drift silently. */
export function recentUtcDays(n, end = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

const fmtDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', timeZone: 'UTC',
});

export function dayTag(key, now = new Date()) {
  if (key === utcDayKey(now)) return 'today';
  const [y, m, d] = key.split('-').map(Number);
  return fmtDay.format(new Date(Date.UTC(y, m - 1, d)));
}

/* =============================================================================
   2. THE VISIT MARK
   ========================================================================== */
export const VISIT_KEY = 'prediq:visit';

/* True at most once per UTC day per browser. Every failure answers false, so a
   reader whose storage is unavailable is counted in views and never in visits:
   undercounting keeps `visits <= views` true, which is a property the rules and
   the tests both lean on, and overcounting would make the smaller number the
   less trustworthy one. */
export function firstOfVisit(now = new Date(), storage = globalThis.localStorage) {
  const key = utcDayKey(now);
  try {
    if (!storage || storage.getItem(VISIT_KEY) === key) return false;
    storage.setItem(VISIT_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/* =============================================================================
   3. THE WRITE

   `update` with an EMPTY updateMask, plus transforms. The empty mask is
   load-bearing and looks like a mistake, so: a mask lists the fields a write may
   touch, and an empty list means "touch none of them, leave the document exactly
   as it is". The increments then run afterwards. Together they are
   `setDoc(ref, { views: increment(1) }, { merge: true })`.

   Drop the mask and the semantics inverts completely: an unmasked `update` with
   `fields: {}` REPLACES the document with an empty one, and since transforms
   apply after the update, both counters would increment from zero every time. It
   would look like a working counter on a site nobody ever visits twice.

   No `currentDocument` precondition, so the first page load creates the document
   and every later one adds to it. That is the opposite of tools/mirror.mjs, which
   pins `exists: false` on every write — there, being refused IS the write-once
   guarantee; here a refusal would just lose a visit.

   BOTH TRANSFORMS ARE ALWAYS SENT, `visits` incrementing by zero when this is not
   the first page of a visit. Sending only `views` would leave `visits` absent on
   a freshly created document, and firestore.rules reads both fields on every
   write — an absent field makes that a rules evaluation error, which denies the
   write. Incrementing by zero is what keeps the rules total rather than making
   them defensive about a case this file could stop producing at any time.
   ========================================================================== */
export function bump(name, visit) {
  return {
    update: { name, fields: {} },
    updateMask: { fieldPaths: [] },
    updateTransforms: [
      { fieldPath: 'views',  increment: { integerValue: '1' } },
      { fieldPath: 'visits', increment: { integerValue: visit ? '1' : '0' } },
    ],
  };
}

/* `:commit` and not `:batchWrite`, again the opposite of mirror.mjs and for the
   opposite reason. `:commit` is atomic: either both documents move or neither
   does. The running total and the sum of the daily documents are meant to be the
   same number, and a non-atomic write would let them drift with no way to tell
   afterwards which one was wrong. mirror.mjs wants per-write status because one
   write failing is normal there; here a failure is a failure, and losing both
   halves of it is cleaner than keeping half. */
export function commitBody(now = new Date(), visit = false) {
  return {
    writes: [
      bump(collection() + '/' + FIRESTORE_VIEWS_TOTAL, visit),
      bump(collection() + '/' + utcDayKey(now), visit),
    ],
  };
}

/* A commit response carries `transformResults` per write: what each field held
   AFTER its transform. So all three numbers this page needs — the two totals and
   today's views — come back from the write itself, with no read at all, and the
   figures in the footer are exactly what this visit just stored.

   `allow read` is granted in firestore.rules anyway, for a different reason: a
   published figure only we can see is not published. Anyone may fetch these
   documents and check the site is not printing something larger than it holds. */
const asInt = v =>
  v && typeof v === 'object' && 'integerValue' in v && Number.isFinite(Number(v.integerValue))
    ? Number(v.integerValue) : null;

export function readCommit(body) {
  const t = body?.writeResults?.[0]?.transformResults;
  const d = body?.writeResults?.[1]?.transformResults;
  const views = asInt(t?.[0]);
  return {
    views: views != null && views > 0 ? views : null,
    visits: asInt(t?.[1]),
    today: asInt(d?.[0]),
  };
}

export async function count({ fetchImpl = fetch, now = new Date(), storage } = {}) {
  const res = await fetchImpl(endpoint('commit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(commitBody(now, firstOfVisit(now, storage))),
  });
  if (!res.ok) throw new Error('counter HTTP ' + res.status);
  return readCommit(await res.json());
}

/* =============================================================================
   4. THE WEEK

   One `:batchGet` for the days before today — today's figure already came back
   from the commit, so asking for it again would be a wasted document read and
   could disagree with the number beside it.

   A day with no document is DROPPED, not shown as zero. Every day before the
   counter existed has no document, and printing "0" against those would be a
   false claim about traffic on a day nobody was counting. The cost is that a
   genuine zero-traffic day is invisible too, which is the right way round: an
   absent figure says nothing, and a fabricated zero says something untrue.
   ========================================================================== */
export function batchGetBody(days) {
  return { documents: days.map(d => collection() + '/' + d) };
}

export function readBatch(body) {
  const out = new Map();
  for (const row of Array.isArray(body) ? body : []) {
    const name = row?.found?.name;
    const v = asInt(row?.found?.fields?.views);
    if (name && v != null) out.set(name.slice(name.lastIndexOf('/') + 1), v);
  }
  return out;
}

export async function week({ fetchImpl = fetch, now = new Date() } = {}) {
  const days = recentUtcDays(VITALS_DAYS, now).slice(1);
  if (!days.length) return new Map();
  const res = await fetchImpl(endpoint('batchGet'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batchGetBody(days)),
  });
  if (!res.ok) throw new Error('day series HTTP ' + res.status);
  return readBatch(await res.json());
}

/* =============================================================================
   5. THE OTHER NUMBER

   store.js owns the archive layout and paths.summary() is its definition of this
   path, repeated for the same reason recentUtcDays is. a1 asserts they match.
   ========================================================================== */
export const SUMMARY = 'data/summary.json';

export async function scored({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(SUMMARY, { cache: 'no-cache' });
  if (!res.ok) return null;
  const body = await res.json();
  /* `overall` is the current model revision only, never a figure pooled across
     revisions — that would credit today's model with a retired one's results.
     store.js's writeSummary() is where that is decided and explained. */
  const n = body?.overall?.scored;
  return Number.isInteger(n) ? n : null;
}

/* =============================================================================
   6. THE STRIP
   ========================================================================== */

const fmt = n => new Intl.NumberFormat().format(n);

/* Deliberately not dom.js's stat(). Same shape — bold number, plain label — but
   this one carries an icon and a thousands separator, and stat() serves three
   status strips whose numbers are small and whose labels have no artwork. Two
   callers wanting slightly different things is how a shared helper grows an
   options bag; a nine-line local function is the cheaper answer. */
function vital(paths, value, one, many) {
  const s = el('span');
  s.append(
    icon(paths, 'foot-i'),
    el('b', null, fmt(value)),
    document.createTextNode(' ' + (value === 1 ? one : many)));
  return s;
}

/* Only what is actually known. A counter that could not be reached shows nothing
   at all — not a zero, not a dash, not a remembered figure. There is no cached
   copy to fall back on, precisely because nothing about these numbers is stored
   on the reader's machine, and inventing a figure to fill a gap in a footer whose
   entire purpose is publishing real ones would be the smallest possible version
   of the dishonesty this site is arranged to avoid.

   With nothing available the node is left genuinely empty, which is what
   `.foot-vitals:empty` and `.foot-days:empty` key on, so the footer closes up
   rather than leaving a band of whitespace. That is also how both lines behave on
   method.html, where nothing ever fills them in. */
export function strip(node, { views = null, visits = null, matches = null } = {}) {
  clear(node);
  if (visits != null) node.append(vital(USERS, visits, 'visit', 'visits'));
  if (views != null) node.append(vital(EYE, views, 'page view', 'page views'));
  if (matches != null) node.append(vital(CHECK_CHECK, matches, 'match scored', 'matches scored'));
  return node;
}

/* The week, as labelled pairs rather than a chart: seven bars would need vertical
   space and an axis to be readable, and seven numbers do not. Newest first, which
   matches store.js's recentDays() and the record page's day strip — and puts the
   figure a reader actually wants nearest the left edge. */
export function days(node, series, now = new Date()) {
  clear(node);
  if (!series || !series.size) return node;
  node.append(icon(ACTIVITY, 'foot-i'));
  for (const key of recentUtcDays(VITALS_DAYS, now)) {
    if (!series.has(key)) continue;
    const s = el('span');
    s.append(
      el('i', null, dayTag(key, now)),
      el('b', null, fmt(series.get(key))));
    node.append(s);
  }
  /* The icon alone is not a day series. If every day was missing — a fresh
     database, or a batchGet that answered nothing — the leading icon would sit in
     the footer on its own, and :empty would not hide it because the node is no
     longer empty. */
  if (node.childNodes.length < 2) clear(node);
  return node;
}

/* =============================================================================
   7. THE ENTRY POINT

   Called once per page load by each boot and never awaited. Nothing here may
   delay a prediction or break a page: the three requests are settled rather than
   awaited in sequence, every failure is swallowed, and the worst outcome is a
   footer with fewer numbers in it or none.

   One paint at the end, so the footer does not reflow three times.
   ========================================================================== */
export async function mountVitals({
  node = document.getElementById('vitals'),
  dayNode = document.getElementById('vitals-days'),
  fetchImpl = fetch,
  now = new Date(),
  storage,
} = {}) {
  if (!node && !dayNode) return null;

  const [c, w, s] = await Promise.allSettled([
    count({ fetchImpl, now, storage }),
    week({ fetchImpl, now }),
    scored({ fetchImpl }),
  ]);

  const got = c.status === 'fulfilled' ? c.value : { views: null, visits: null, today: null };
  const vals = {
    views: got.views,
    visits: got.visits,
    matches: s.status === 'fulfilled' ? s.value : null,
  };
  if (node) strip(node, vals);

  /* Today comes from the commit and the rest from the batchGet, so the row is
     assembled from both — and each contributes only if it succeeded, which is why
     a failed commit costs today's figure rather than the whole week. */
  const series = w.status === 'fulfilled' ? new Map(w.value) : new Map();
  if (got.today != null) series.set(utcDayKey(now), got.today);
  if (dayNode) days(dayNode, series, now);

  return { ...vals, today: got.today, series };
}
