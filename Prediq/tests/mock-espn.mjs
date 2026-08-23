/* =============================================================================
   tests/mock-espn.mjs — a fake ESPN and a fake clock, installed before anything
   else runs.

     node --import ./tests/mock-espn.mjs tools/freeze.mjs

   The other suites import the modules they test and can install their shims
   first. The two writers in tools/ are scripts: they do their work at import
   time, so there is no moment between "loaded" and "running" in which to hand
   them a mock. Node's --import hook runs before the entry module, which is the
   only seam available — and using it means the scripts themselves need no
   test-only branches.

   ENV
     MOCK_BASE     ISO instant everything is generated relative to. Fixed, so two
                   runs produce byte-identical archives.
     MOCK_NOW      what `new Date()` returns. Lets freeze run "before" the
                   matches and settle run "after" them, without either script
                   knowing time was faked.
     MOCK_PLAYED   1 once the fixtures have been played: they then come back as
                   finished, with scores, inside their calendar month.
     MOCK_BREAK    a slug whose every request fails, for the error paths.
   ========================================================================== */

import { LEAGUES, DOMESTIC, FIXTURE_DAYS } from '../assets/js/config.js';

const BASE = new Date(process.env.MOCK_BASE || '2026-08-23T09:00:00.000Z');
const PLAYED = process.env.MOCK_PLAYED === '1';
const BREAK = process.env.MOCK_BREAK || null;

/* --- the clock -------------------------------------------------------------
   A fixed offset rather than a frozen instant: the scripts measure elapsed time
   in places (fetch timeouts), and a Date that never advances would make a
   timeout that never fires look the same as one that fired instantly. */
if (process.env.MOCK_NOW) {
  const skew = +new Date(process.env.MOCK_NOW) - Date.now();
  const Real = Date;
  const Fake = class extends Real {
    constructor(...a) { super(...(a.length ? a : [Real.now() + skew])); }
    static now() { return Real.now() + skew; }
  };
  Fake.parse = Real.parse;
  Fake.UTC = Real.UTC;
  globalThis.Date = Fake;
}

/* --- the fixtures ----------------------------------------------------------
   One per competition, staggered by an hour so kickoff order is observable, and
   derived from BASE so the freeze run and the settle run agree about which
   month a match belongs to.

   The European tie deliberately pits an English side against a Spanish one.
   That is the cross-league path — two clubs rated in different divisions — and
   it is the one thing the archive holds that no single league's data explains. */
const SLUGS = LEAGUES.map(l => l.slug);
const DOM = new Set(DOMESTIC.map(l => l.slug));

const team = (slug, n) => ({
  id: slug + '-' + n,
  displayName: slug + ' ' + n,
  shortDisplayName: 'T' + n,
  logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/' + n + '.png',
});

/* One record per competition, generated once and shared by both handlers so the
   freeze run and the settle run cannot disagree about ids, kickoffs or scores. */
export const FIXTURES = SLUGS.map((slug, i) => {
  const kickoff = new Date(+BASE + (4 + i) * 3600e3);
  const home = slug.startsWith('uefa.') ? team('eng.1', 1) : team(slug, 1);
  const away = slug.startsWith('uefa.') ? team('esp.1', 1) : team(slug, 2);
  return { slug, id: slug + '-fx', kickoff, home, away, hg: i % 3, ag: (i + 1) % 2,
           priced: i % 2 === 0 };
});

/* Europa and the Conference were both idle when ESPN was checked in August
   2026 — zero events, which is normal and not an error. Keeping that in the
   mock means the writers are exercised against a competition that has nothing
   to say. */
const IDLE = new Set(['uefa.europa', 'uefa.europa.conf']);
const live = f => !IDLE.has(f.slug);

const ev = (id, iso, state, home, away, hg, ag, priced = false) => ({
  id, date: iso,
  status: { type: { state } },
  competitions: [{
    venue: { fullName: 'Mock Park' },
    competitors: [
      { homeAway: 'home', team: home, score: hg == null ? undefined : String(hg) },
      { homeAway: 'away', team: away, score: ag == null ? undefined : String(ag) },
    ],
    /* Priced on alternate competitions only. Roughly half of ESPN's fixtures
       carry odds in practice, and a record with no market has to come out as
       ordinary as one that has it. */
    odds: priced ? [{
      provider: { displayName: 'MockBook' },
      homeTeamOdds: { moneyLine: -120 },
      drawOdds: { moneyLine: 260 },
      awayTeamOdds: { moneyLine: 320 },
      overUnder: 2.5,
    }] : undefined,
  }],
});

const entry = (slug, n) => ({
  team: { ...team(slug, n), logos: [{ href: team(slug, n).logo }] },
  stats: [
    { name: 'gamesPlayed', value: 20 }, { name: 'pointsFor', value: 30 - n },
    { name: 'pointsAgainst', value: 20 + n }, { name: 'rank', value: n },
  ],
});

/* --- routing --------------------------------------------------------------- */
const ymdToDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const slugOf = url => SLUGS.find(s => url.includes('/soccer/' + s + '/'));

export const hits = [];

globalThis.fetch = async (url) => {
  hits.push(url);
  const slug = slugOf(url);
  if (!slug) throw new Error('unroutable ' + url);
  if (slug === BREAK) return { ok: false, status: 503, json: async () => ({}) };

  const u = new URL(url);
  const body = () => {
    if (url.includes('/standings?')) {
      return { children: [{ standings: { entries: [1, 2, 3, 4].map(n => entry(slug, n)) } }] };
    }

    const span = u.searchParams.get('dates');
    const [a, b] = span.split('-');
    const from = ymdToDate(a), to = ymdToDate(b);
    const days = Math.round((to - from) / 864e5);

    /* A fixture window and a month of history are the same endpoint with a
       different range. Width is the only thing that distinguishes them, which
       is exactly how api.js uses it. */
    if (days <= FIXTURE_DAYS + 1) {
      if (PLAYED) return { events: [] };        /* played matches are not fixtures */
      return {
        events: FIXTURES.filter(f => f.slug === slug && live(f))
          .map(f => ev(f.id, f.kickoff.toISOString(), 'pre', f.home, f.away,
                       null, null, f.priced)),
      };
    }

    /* A month of results: some invented history so the model has something to
       fit, plus — once the matches have been played — the recorded fixtures
       themselves, which is what lets settle match a score to a prediction. */
    const events = [];
    if (DOM.has(slug)) {
      for (let d = 2; d < 26; d += 7) {
        const when = new Date(+from + d * 864e5);
        if (when > to) break;
        events.push(ev(slug + '-h' + d, when.toISOString(), 'post',
          team(slug, 1), team(slug, 2), 2, 1));
        events.push(ev(slug + '-h' + d + 'b', when.toISOString(), 'post',
          team(slug, 3), team(slug, 4), 1, 1));
      }
    }
    if (PLAYED) {
      for (const f of FIXTURES) {
        if (f.slug !== slug || !live(f)) continue;
        if (f.kickoff < from || f.kickoff > new Date(+to + 864e5)) continue;
        events.push(ev(f.id, f.kickoff.toISOString(), 'post', f.home, f.away, f.hg, f.ag));
      }
    }
    return { events };
  };

  const payload = body();
  return { ok: true, status: 200, json: async () => payload };
};

/* localStorage is absent under Node, and api.js is written to run uncached when
   it is — which is what a scheduled job should do. Left absent on purpose: a
   shim here would hide a regression that made caching mandatory. */
