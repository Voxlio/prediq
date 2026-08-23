/* =============================================================================
   config.js — every setting Prediq has, in one place.
   Change values here to retune the site. No logic lives in this file.
   ========================================================================== */

/* --- Model revision ----------------------------------------------------------
   Stamped onto every stored prediction, and what the accuracy page groups by.

   Bump this whenever a change would make a prediction come out differently:
   anything in MODEL, any `quality` coefficient, adding or removing a league
   (home advantage is fitted from every domestic league pooled, so the league
   list changes every rating slightly). Fixing a bug in the maths counts too.

   Why it is hand-set rather than derived: only a person can say whether a
   change was meaningful. `record.js` also stores an automatic hash of the same
   inputs, so if one rev ever shows two hashes, that is the record telling you
   the model was retuned and this line was not updated. Do not renumber an
   existing rev — the stored history refers to it.
-------------------------------------------------------------------------------*/
export const MODEL_REV = '1.0';

/* --- Leagues -----------------------------------------------------------------
   `domestic: true`  → we load standings and results for this league, and its
                       teams go into the global strength index.
   `domestic: false` → we show its fixtures, but team strength is looked up from
                       whichever domestic league that team plays in. The
                       Champions League works this way.

   `quality` is a cross-league strength coefficient, used only when comparing
   teams from different leagues (i.e. Champions League ties). A goal scored in
   Ligue 1 is not worth the same as one in the Premier League. These numbers are
   an informed judgement call, not a measurement — they are documented as such
   on the method page. Premier League is the 1.00 baseline.

   The order below is the order the ratings page prints its tables in, so it
   runs roughly by prominence rather than alphabetically.

   Every slug here was checked against ESPN from a browser on 2026-08-22:
   fixtures, three seasons of standings, and a month of last season's results
   all came back for each domestic league, with goals under pointsFor /
   pointsAgainst throughout. Do not add a slug that has not been through that
   check — a league that half-answers is worse than one that is absent, because
   it produces ratings rather than an error.
-------------------------------------------------------------------------------*/
export const LEAGUES = [
  /* --- the five Prediq launched with ------------------------------------- */
  { slug: 'eng.1',          abbr: 'PL',   name: 'Premier League',       domestic: true,  quality: 1.00 },
  { slug: 'esp.1',          abbr: 'LAL',  name: 'La Liga',              domestic: true,  quality: 0.98 },
  { slug: 'ita.1',          abbr: 'SA',   name: 'Serie A',              domestic: true,  quality: 0.96 },
  { slug: 'ger.1',          abbr: 'BUN',  name: 'Bundesliga',           domestic: true,  quality: 0.96 },
  { slug: 'fra.1',          abbr: 'L1',   name: 'Ligue 1',              domestic: true,  quality: 0.92 },

  /* --- added 2026-08-22, after the slugs were verified in a browser -------
     Belgium plays a split season: ESPN returns its table in three groups and
     a team's games-played runs past the 30 of the regular season. Both are
     handled — parseStandings flattens groups, and every rate the model uses is
     per game rather than per season. */
  { slug: 'por.1',          abbr: 'PRI',  name: 'Primeira Liga',        domestic: true,  quality: 0.86 },
  { slug: 'ned.1',          abbr: 'ERE',  name: 'Eredivisie',           domestic: true,  quality: 0.85 },
  { slug: 'eng.2',          abbr: 'CHA',  name: 'Championship',         domestic: true,  quality: 0.82 },
  { slug: 'bel.1',          abbr: 'BEL',  name: 'Belgian Pro League',   domestic: true,  quality: 0.81 },
  { slug: 'tur.1',          abbr: 'SUP',  name: 'Süper Lig',            domestic: true,  quality: 0.80 },
  { slug: 'sco.1',          abbr: 'SPL',  name: 'Scottish Premiership', domestic: true,  quality: 0.76 },

  /* --- European ties: fixtures only, strengths come from the domestic fits.
     `quality` is unused for these and stays at the baseline: a Champions
     League match is scored using the two clubs' own leagues, not the
     competition's. All three sit idle between about June and September, so an
     empty fixture list from them is normal and not an error. */
  { slug: 'uefa.champions',   abbr: 'UCL',  name: 'Champions League',   domestic: false, quality: 1.00 },
  { slug: 'uefa.europa',      abbr: 'UEL',  name: 'Europa League',      domestic: false, quality: 1.00 },
  { slug: 'uefa.europa.conf', abbr: 'UECL', name: 'Conference League',  domestic: false, quality: 1.00 },
];

export const DOMESTIC = LEAGUES.filter(l => l.domestic);

/* --- API paths -------------------------------------------------------------
   Verified working from a browser. Note that standings sits on a DIFFERENT
   base path than the scoreboard — no `site/` segment. The `/teams` endpoint
   fails CORS entirely, so team names are read off the scoreboard instead.
-----------------------------------------------------------------------------*/
export const API = {
  scoreboard: 'https://site.api.espn.com/apis/site/v2/sports/soccer/',
  standings:  'https://site.api.espn.com/apis/v2/sports/soccer/',
};

/* --- Season ----------------------------------------------------------------
   European seasons straddle two calendar years. ESPN labels the 2026-27 season
   as `season=2026`, so the label is the year the season STARTED.
   From July onward we are in a new season; before July we are still in the one
   that began last year.
-----------------------------------------------------------------------------*/
export function currentSeason(now = new Date()) {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

/* How many days of upcoming fixtures to show. */
export const FIXTURE_DAYS = 7;

/* --- When a prediction gets written down ------------------------------------
   The archive records a fixture the first time the scheduled writer sees it
   inside this window, and never again. So this number IS the lead time of every
   figure on the accuracy page, and it settles a real trade-off.

   The fixture list runs seven days out. Recording at first sight would give a
   seven-day lead time — a harder and more impressive test of the model, since it
   would be calling matches before the intervening round had even been played.
   But it would not be the prediction anyone saw. The page refits on every visit,
   so a visitor on match day reads numbers computed from a week more data, and an
   archive full of week-old figures could not answer the question it exists to
   answer: was the prediction I looked at right?

   24 hours is the compromise, and it is stated on the method page rather than
   left to be inferred: close enough to kickoff that the archived numbers are
   what match-day visitors read, far enough out that the writer has many chances
   to catch every fixture before it starts.

   It must stay comfortably larger than the gap between workflow runs. At 24
   hours with a three-hourly cron, every fixture is offered to the writer eight
   times before kickoff, so a run has to fail eight times in a row to lose one.
-------------------------------------------------------------------------------*/
export const FREEZE_WITHIN_HOURS = 24;

/* --- How much record is enough to quote a rate ------------------------------
   The record page shows counts from the first settled match — 8 right out of 12
   is a fact, and hiding it would be worse than showing it. What it will not do
   is turn a handful of matches into a percentage, because a percentage invites
   being read as the model's accuracy and a small one is mostly noise.

   Twelve coin tosses land 8-or-better about one time in five. At fifty matches
   the same fluke needs a run that happens under one time in a hundred, which is
   roughly where a number starts carrying information rather than mood. It is a
   judgement, not a theorem, which is exactly why it is a named constant on this
   page rather than an inline `> 50` somewhere in a render function.

   Calibration — whether calls made at 70% actually land near 70% — needs far
   more than this, and lives on the accuracy page rather than here.
-------------------------------------------------------------------------------*/
export const MIN_FOR_RATE = 50;

/* How many days back the record page offers. Matches FIXTURE_DAYS forward, so
   the site covers a fortnight centred on today. */
export const RECORD_DAYS = 7;

/* --- Model tunables --------------------------------------------------------*/
export const MODEL = {
  /* Scoreline matrix runs 0..MAX_GOALS for each side, then gets normalized.
     Do not lower this to 4 — measured in tests/h1.mjs, truncating there loses
     2.6% of the probability in a balanced match and 18.7% in a mismatch, which
     is exactly where the skew would show. At 9 it is under 0.12% everywhere. */
  MAX_GOALS: 9,

  /* Last season counts for this many "virtual matches" when blended with the
     current season. Early in a season the prior dominates; by ~20 games played
     the current season does. Higher = slower to react to real form. */
  PRIOR_WEIGHT: 6,

  /* Recent matches count for more. Weight decays by half every N matches. */
  RECENCY_HALFLIFE: 8,

  /* How many calendar months of this season's results to read, counting back
     from now. Results are fetched a month at a time (ESPN caps a wide date
     range at 100 events), so this is also the main thing setting how many
     requests a first visit costs: eleven divisions times this many months.

     Why capping is defensible rather than lazy: with RECENCY_HALFLIFE at 8, a
     match played 30 matches ago carries 2^-3.75 — about a fourteenth — of the
     weight of the most recent one. By May, fetching August would add 60-odd
     requests to move a rating in the third decimal place. The season-long
     picture is not lost either way, because last season's full table and this
     season's league table are both read in full and neither is truncated. */
  RESULT_MONTHS: 5,

  /* Team strength depends on opponent strength, which depends on team
     strength — so we solve it by repetition: guess, refine, repeat. Five
     passes is well past the point where the numbers stop moving. */
  ITERATIONS: 5,

  /* Home advantage, as a multiplier on each side's expected goals. Defaults
     reflect the long-run big-five average (home sides score about 11% above
     the league mean, away sides about 11% below). We re-derive this from the
     season's actual matches once enough have been played — HOME_ADV_PRIOR is
     how many virtual matches the default above counts for while we wait. */
  HOME_ADVANTAGE: 1.11,
  AWAY_PENALTY:   0.89,
  HOME_ADV_PRIOR: 150,

  /* Two independent Poisson distributions slightly under-predict draws and
     low-scoring games — a real, well-documented flaw. This is the Dixon–Coles
     correction, which nudges 0-0 and 1-1 up and 1-0 / 0-1 down. A fitted
     value is usually near -0.13; we use a deliberately conservative one
     because we have no backtest to fit it against. */
  DC_RHO: -0.06,

  /* Newly promoted teams have no prior-season record in the league. Rather than
     treat that as zero, start them below average: historically promoted sides
     score less and concede more than the division mean. */
  PROMOTED_ATTACK:  0.85,
  PROMOTED_DEFENCE: 1.15,

  /* Strengths are clamped to keep one freak result from producing absurd
     expected-goal figures. */
  MIN_STRENGTH: 0.35,
  MAX_STRENGTH: 2.60,

  /* A prior-season record is only trusted as a full prior if the team actually
     played this many games in that league. Fewer than this (a mid-season
     arrival, a partial record) and we fall back to the promoted defaults. */
  PRIOR_MIN_GAMES: 10,

  /* Confidence tiers, keyed on the gap between the likeliest and second
     likeliest outcome, in percentage points. */
  CONFIDENCE: [
    { min: 30, level: 4, word: 'high' },
    { min: 18, level: 3, word: 'moderate' },
    { min:  8, level: 2, word: 'medium' },
    { min:  0, level: 1, word: 'low' },
  ],

  /* …but capped by how much of THIS season we have actually seen, using the
     less-observed of the two teams. A wide probability gap in August rests
     almost entirely on last season, so it does not earn "high". */
  CONFIDENCE_CAP: [
    { minMatches: 12, level: 4 },
    { minMatches:  6, level: 3 },
    { minMatches:  0, level: 2 },
  ],

  /* How far the model must sit from the bookmaker before that gap is worth
     remarking on, in probability points. */
  EDGE_THRESHOLD: 0.06,

  /* Most insight lines to print under one match. */
  INSIGHT_MAX: 3,
};

/* --- Cache -----------------------------------------------------------------
   Everything is cached in localStorage. Data that can never change again gets
   a long life; anything still moving gets a short one. This is what keeps a
   repeat visit to roughly zero network requests.
-----------------------------------------------------------------------------*/
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const CACHE = {
  /* Bump this whenever a parser's output shape changes. Cached entries are
     parsed objects, not raw responses, so an old entry is missing whatever
     field was just added — and monthPast sits in storage for 90 days, which is
     far too long to wait for a shape change to work itself out. v2 added the
     crest URL to standings, fixtures and results; v3 added the ESPN event id to
     parsed results, which the scheduled writer needs to match a final score to
     a stored prediction. */
  prefix: 'prediq:v3:',
  ttl: {
    fixtures:      30 * MIN,   /* kickoff times and odds drift */
    monthCurrent:   3 * HOUR,  /* this month is still being played */
    monthPast:     90 * DAY,   /* a finished month never changes */
    standingsPrev: 30 * DAY,   /* last season is final */
    standingsNow:   6 * HOUR,
  },
  /* Never fire more than this many requests at once. */
  concurrency: 4,
};
