/* l1.mjs — the two-phase load, tested at the api.js seam.

   e1.mjs already boots the whole page end to end. This suite covers the
   contract underneath it, which is where the expansion to fourteen
   competitions actually lives:

     - phase 1 reads fixtures and NOTHING else
     - phase 2 reads tables and results, and never asks a cup for a table
     - the two phases compose to exactly what loadAll used to return on its own,
       because ratings.js still calls loadAll and must not have changed meaning
     - the history cap bounds a cold visit for every month of a season
     - the progress bar is sized once, never moves backwards, and ends full

   That last one is not cosmetic. The first draft of loadAll carried its own
   offset bookkeeping, and the failure it invited was a bar that reset halfway
   through the load. Nothing else in the suite would have caught it.
*/

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const root = new URL('../assets/js/', import.meta.url).href;
const { LEAGUES, DOMESTIC, MODEL, FIXTURE_DAYS, CACHE, currentSeason } =
  await import(root + 'config.js');

let fails = 0;
const ok = (l, c, g) => {
  console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g)));
  if (!c) fails++;
};

/* ---------- shims ---------- */
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: i => [...store.keys()][i] ?? null,
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};

const SLUGS = LEAGUES.map(l => l.slug);
const DOM_SLUGS = new Set(DOMESTIC.map(l => l.slug));
/* The two competitions that were idle when this was verified against ESPN in
   August 2026: both answered with zero events. */
const IDLE = new Set(['uefa.europa', 'uefa.europa.conf']);

let hits = [];
let broken = null;                 /* slug whose every request fails */

/* One frozen instant for every generated date. Two identical loads must produce
   byte-identical data, and a mock that stamped kickoffs with Date.now() at
   fetch time would differ between runs by a millisecond and make the
   composition check below meaningless. */
const T0 = Date.now();

const ymdToDate = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const slugOf = url => SLUGS.find(s => url.includes('/soccer/' + s + '/'));
const spanOf = url => {
  const p = new URL(url).searchParams.get('dates');
  if (!p) return null;
  const [a, b] = p.split('-');
  return Math.round((ymdToDate(b) - ymdToDate(a)) / 864e5);
};
const isFixtureReq = url => spanOf(url) !== null && spanOf(url) <= FIXTURE_DAYS + 1;
const isStandingsReq = url => url.includes('/standings?');

const team = (slug, n) => ({ id: slug + '-' + n, displayName: slug + ' ' + n, shortDisplayName: 'T' + n });

const ev = (id, iso, state, home, away, hg, ag) => ({
  id, date: iso,
  status: { type: { state } },
  competitions: [{
    competitors: [
      { homeAway: 'home', team: home, score: hg == null ? undefined : String(hg) },
      { homeAway: 'away', team: away, score: ag == null ? undefined : String(ag) },
    ],
  }],
});

const entry = (slug, n) => ({
  team: team(slug, n),
  stats: [
    { name: 'gamesPlayed', value: 10 }, { name: 'pointsFor', value: 15 },
    { name: 'pointsAgainst', value: 12 }, { name: 'rank', value: n },
  ],
});

globalThis.fetch = async (url) => {
  hits.push(url);
  const slug = slugOf(url);
  if (!slug) throw new Error('unroutable ' + url);
  if (slug === broken) return { ok: false, status: 503, json: async () => ({}) };
  const body = () => {
    if (isStandingsReq(url)) {
      return { children: [{ standings: { entries: [1, 2, 3, 4].map(n => entry(slug, n)) } }] };
    }
    if (isFixtureReq(url)) {
      if (IDLE.has(slug)) return { events: [] };
      /* Kickoffs staggered by league so the sort order is observable. */
      const hrs = 3 + SLUGS.indexOf(slug);
      return { events: [ev(slug + '-fx', new Date(T0 + hrs * 3600e3).toISOString(),
                          'pre', team(slug, 1), team(slug, 2))] };
    }
    return { events: [ev(slug + '-r', new Date(T0 - 5 * 864e5).toISOString(),
                        'post', team(slug, 1), team(slug, 2), 2, 1)] };
  };
  const b = body();
  return { ok: true, status: 200, json: async () => b };
};

const api = await import(root + 'api.js');
const reset = () => { store.clear(); hits = []; broken = null; };

/* =============================================================================
   1. PHASE SEPARATION
   ========================================================================== */
console.log('=== phase 1 reads fixtures and nothing else ===');
reset();
const fx = await api.loadFixtures();
console.log('    ' + hits.length + ' requests for ' + LEAGUES.length + ' competitions, ' +
            fx.fixtures.length + ' fixtures');

ok('one request per competition, no more', hits.length === LEAGUES.length, hits.length);
ok('every competition is asked, cups included',
  new Set(hits.map(slugOf)).size === LEAGUES.length);
ok('no league table is read in phase 1', !hits.some(isStandingsReq));
ok('no month of results is read in phase 1', hits.every(isFixtureReq));
ok('an idle cup that returns nothing is not an error', fx.errors.length === 0, fx.errors);
ok('and contributes no fixtures rather than a placeholder',
  fx.fixtures.length === LEAGUES.length - IDLE.size, fx.fixtures.length);
ok('fixtures come back in kickoff order',
  fx.fixtures.every((f, i) => i === 0 || new Date(f.date) >= new Date(fx.fixtures[i - 1].date)));
ok('each fixture is stamped with the competition it came from',
  fx.fixtures.every(f => SLUGS.includes(f.leagueSlug)));

console.log('');
console.log('=== phase 2 reads tables and results ===');
reset();
const md = await api.loadModel();
const predicted = api.estimateModelJobs();
console.log('    ' + hits.length + ' requests, ' + predicted + ' predicted, months: ' +
            md.months.map(([y, m]) => (m + 1) + '/' + y).join(', '));

ok('phase 2 fires exactly the number of requests it predicted in advance',
  hits.length === predicted, [hits.length, predicted]);
ok('two tables per domestic league',
  hits.filter(isStandingsReq).length === DOMESTIC.length * 2);
ok('no cup is asked for a league table',
  hits.filter(isStandingsReq).every(u => DOM_SLUGS.has(slugOf(u))));
ok('no cup is asked for a month of results',
  hits.filter(u => !isStandingsReq(u)).every(u => DOM_SLUGS.has(slugOf(u))));
ok('phase 2 reads no fixtures — that was phase 1', !hits.some(isFixtureReq));
ok('every competition has a bucket, so nothing downstream can hit undefined',
  LEAGUES.every(l => md.byLeague[l.slug]));
ok('a cup bucket is empty rather than absent',
  ['uefa.champions', 'uefa.europa', 'uefa.europa.conf'].every(s => {
    const b = md.byLeague[s];
    return Array.isArray(b.standingsNow) && Array.isArray(b.standingsPrev) &&
           Array.isArray(b.results) && b.results.length === 0;
  }));
ok('the season it fitted is the one config names', md.season === currentSeason());
ok('and last season is the one before it', md.prevSeason === md.season - 1);

/* =============================================================================
   2. HOW MUCH HISTORY IS READ

   seasonMonths() must stay uncapped: it is the honest description of the season
   so far, and the ratings page prints from it. resultMonths() is where the cap
   belongs, and the months it keeps must be the RECENT ones — dropping the tail
   instead of the head would quietly weight a rating on August alone by May.
   ========================================================================== */
console.log('');
console.log('=== the history cap, month by month through a season ===');
const season = 2026;
let worstCold = 0, worstAll = 0, suffixOk = true, capOk = true;
for (const [y, m] of [[2026, 7], [2026, 9], [2026, 11], [2027, 0], [2027, 2], [2027, 4]]) {
  const now = new Date(y, m, 15);
  const all = api.seasonMonths(season, now);
  const kept = api.resultMonths(season, now);
  const cold = LEAGUES.length + api.estimateModelJobs(now);
  worstAll = Math.max(worstAll, all.length);
  worstCold = Math.max(worstCold, cold);
  if (kept.length !== Math.min(all.length, MODEL.RESULT_MONTHS)) capOk = false;
  if (JSON.stringify(kept) !== JSON.stringify(all.slice(all.length - kept.length))) suffixOk = false;
  console.log('    ' + String(m + 1).padStart(2) + '/' + y +
              '  season so far ' + String(all.length).padStart(2) +
              ' months, read ' + kept.length +
              ', cold visit ' + String(cold).padStart(3) + ' requests');
}
ok('seasonMonths stays uncapped, so the season is still described honestly',
  worstAll === 10, worstAll);
ok('resultMonths never reads more months than configured', capOk, MODEL.RESULT_MONTHS);
ok('the months kept are the most recent ones, never the earliest', suffixOk);
ok('the cap binds at all — otherwise it is decoration',
  MODEL.RESULT_MONTHS < 10, MODEL.RESULT_MONTHS);
ok('a cold visit costs exactly the stated budget at its worst',
  worstCold === LEAGUES.length + DOMESTIC.length * (2 + MODEL.RESULT_MONTHS),
  worstCold);
ok('and that budget stays under a hundred requests',
  worstCold <= 100, worstCold);

/* =============================================================================
   3. THE TWO PHASES COMPOSE

   ratings.js still calls loadAll. Splitting the loader must not have changed
   what loadAll means, or the ratings page silently reads different data than
   the fixtures page does.
   ========================================================================== */
console.log('');
console.log('=== loadAll is its two phases, composed ===');
const shape = o => JSON.stringify({
  fixtures: o.fixtures, byLeague: o.byLeague, errors: o.errors,
  season: o.season, prevSeason: o.prevSeason, months: o.months,
});

reset();
const whole = await api.loadAll();
const wholeHits = hits.length;

reset();
const p1 = await api.loadFixtures();
const p2 = await api.loadModel();
const partsHits = hits.length;
const parts = { ...p2, fixtures: p1.fixtures, errors: [...p1.errors, ...p2.errors] };

ok('the same data, field for field', shape(whole) === shape(parts),
  shape(whole) === shape(parts) ? null : { whole: shape(whole).slice(0, 300), parts: shape(parts).slice(0, 300) });
ok('and the same number of requests', wholeHits === partsHits, [wholeHits, partsHits]);
ok('which is phase 1 plus phase 2',
  wholeHits === LEAGUES.length + api.estimateModelJobs(), wholeHits);

console.log('');
console.log('=== the ratings page skips phase 1 entirely ===');
reset();
const ratings = await api.loadAll({ withFixtures: false });
console.log('    ' + hits.length + ' requests instead of ' + (LEAGUES.length + api.estimateModelJobs()));
ok('not one fixture request is made', !hits.some(isFixtureReq));
ok('it costs exactly phase 2 and nothing more',
  hits.length === api.estimateModelJobs(), hits.length);
ok('fixtures comes back as an empty array, not undefined',
  Array.isArray(ratings.fixtures) && ratings.fixtures.length === 0);
ok('the model data is all there', DOMESTIC.every(l => ratings.byLeague[l.slug].standingsNow.length > 0));

/* =============================================================================
   4. THE PROGRESS BAR

   One bar spans both phases. It must be sized once, advance monotonically, and
   finish full — a bar that resets at the halfway point reads as a stall.
   ========================================================================== */
console.log('');
console.log('=== the progress bar across both phases ===');
reset();
const seen = [];
await api.loadAll({ onProgress: (done, total) => seen.push([done, total]) });
const totals = new Set(seen.map(s => s[1]));
console.log('    ' + seen.length + ' updates, total always ' + [...totals].join('/') +
            ', done ran ' + seen[0][0] + ' to ' + seen[seen.length - 1][0]);

ok('the bar is sized once and never resized mid-load', totals.size === 1, [...totals]);
ok('that single total is the real request count',
  seen[0][1] === LEAGUES.length + api.estimateModelJobs(), seen[0][1]);
ok('progress never goes backwards',
  seen.every((s, i) => i === 0 || s[0] >= seen[i - 1][0]));
ok('it starts empty', seen[0][0] === 0, seen[0]);
ok('and ends exactly full', seen[seen.length - 1][0] === seen[0][1], seen[seen.length - 1]);
ok('phase 2 picks up where phase 1 stopped, with no gap and no repeat',
  seen.some(s => s[0] === LEAGUES.length), LEAGUES.length);

/* =============================================================================
   5. FAILURE IS RECORDED, NOT THROWN
   ========================================================================== */
console.log('');
console.log('=== one league fails ===');
reset();
broken = 'ger.1';
let threw = null;
let bad;
try {
  bad = await api.loadAll();
} catch (err) {
  threw = err.message;
}
console.log('    ' + (bad ? bad.errors.length : '-') + ' errors: ' +
            (bad ? [...new Set(bad.errors.map(e => e.what))].join(', ') : threw));

ok('a failing league never throws out of the loader', threw === null, threw);
ok('every failure is attributed to that league alone',
  bad.errors.every(e => e.league === 'ger.1'), bad.errors);
ok('one failure recorded per request attempted, not one per league',
  bad.errors.length === 1 + 2 + api.resultMonths(currentSeason()).length, bad.errors.length);
ok('each says what was being read, from a known vocabulary',
  bad.errors.every(e => ['fixtures', 'standingsNow', 'standingsPrev', 'month'].includes(e.what)),
  bad.errors.map(e => e.what));
ok('and carries the underlying message',
  bad.errors.every(e => typeof e.message === 'string' && e.message.length > 0));
ok('the failure spans both phases, so neither hides its own errors',
  bad.errors.some(e => e.what === 'fixtures') && bad.errors.some(e => e.what !== 'fixtures'));
ok('no German fixture is invented in its place',
  !bad.fixtures.some(f => f.leagueSlug === 'ger.1'));
ok('the other leagues are untouched',
  bad.fixtures.length === LEAGUES.length - IDLE.size - 1 &&
  DOMESTIC.filter(l => l.slug !== 'ger.1').every(l => bad.byLeague[l.slug].standingsNow.length > 0));
ok('the failed league still has a bucket, empty',
  bad.byLeague['ger.1'].standingsNow.length === 0 && bad.byLeague['ger.1'].results.length === 0);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
