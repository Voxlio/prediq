/* =============================================================================
   model.js — the prediction engine.

   No network access, no DOM, no side effects: data in, numbers out. That is
   deliberate. Every function here can be run in isolation and checked, which is
   the only way to trust a model you cannot backtest.

   HOW IT WORKS, in one paragraph. Every team gets two numbers: an attack rating
   and a defence rating, both scaled so that 1.00 is exactly average for its
   division. Multiply the league's average goals-per-team-per-game by one side's
   attack, the other side's defence, and a home-advantage factor, and you have
   the goals each team is expected to score. Feed those two expectations into a
   Poisson distribution and you get the probability of every plausible
   scoreline; add the right cells together and out come the odds of a home win,
   a draw, over 2.5 goals, and so on.
   ========================================================================== */

import { DOMESTIC, LEAGUES, MODEL } from './config.js';

/* =============================================================================
   1. MATHS HELPERS
   ========================================================================== */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const sum = a => a.reduce((x, y) => x + y, 0);

/* Factorials up to the largest scoreline we consider. */
const FACT = [1];
for (let k = 1; k <= 24; k++) FACT[k] = FACT[k - 1] * k;

/* Probability of exactly k goals when the expected number is lambda. */
export function poisson(k, lambda) {
  if (!(lambda > 0)) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
}

/* Percentages have to add up to 100 or the card looks broken. Round every
   value down, then hand the leftover points to whichever values were closest
   to rounding up (the largest-remainder method). */
export function roundTo100(fractions) {
  if (!fractions.length) return [];
  const raw = fractions.map(f => f * 100);
  const out = raw.map(Math.floor);
  let left = 100 - sum(out);
  const byRemainder = raw
    .map((v, i) => ({ rem: v - Math.floor(v), i }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; k < byRemainder.length && left > 0; k++, left--) out[byRemainder[k].i]++;
  return out;
}

/* =============================================================================
   2. CLEANING THE MATCH RECORD

   ESPN's league scoreboard includes cup fixtures against opposition from other
   divisions — "Arsenal 3-0 Coventry City" showed up in the Premier League feed,
   and Coventry are a Championship side. Counting those would inflate every big
   club. So a match is kept only if BOTH teams appear in that league's table.
   ========================================================================== */

function leagueMatches(bucket) {
  const roster = new Set((bucket.standingsNow || []).map(t => t.id));
  const seen = new Set();
  const kept = [];

  for (const m of bucket.results || []) {
    if (!roster.has(m.home.id) || !roster.has(m.away.id)) continue;
    /* Month requests could in principle overlap at a boundary. */
    const key = `${m.date}|${m.home.id}|${m.away.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(m);
  }
  kept.sort((a, b) => new Date(a.date) - new Date(b.date));
  return kept;
}

/* Which matches were excluded, and why — surfaced so the site can be honest
   about what it did rather than quietly dropping data. */
function countExcluded(bucket, kept) {
  return Math.max(0, (bucket.results || []).length - kept.length);
}

/* =============================================================================
   3. HOME ADVANTAGE

   Home sides score more than away sides — reliably, across every league. But
   the exact size of the effect drifts, so rather than hardcode it forever we
   measure it from this season's actual matches, pooled across all five leagues
   (one league alone is far too small a sample in August). Until enough matches
   exist, the configured long-run default carries the estimate.

   The two factors always sum to 2, so the pair stays centred on the league
   average no matter how the blend lands.
   ========================================================================== */

export function homeAdvantage(matches) {
  const fallback = { home: MODEL.HOME_ADVANTAGE, away: MODEL.AWAY_PENALTY, matches: 0, measured: false };
  const n = matches.length;
  if (!n) return fallback;

  const homeGoals = sum(matches.map(m => m.home.g));
  const awayGoals = sum(matches.map(m => m.away.g));
  const mean = (homeGoals + awayGoals) / (2 * n);
  if (!(mean > 0)) return fallback;

  const w = n / (n + MODEL.HOME_ADV_PRIOR);
  return {
    home: MODEL.HOME_ADVANTAGE * (1 - w) + ((homeGoals / n) / mean) * w,
    away: MODEL.AWAY_PENALTY   * (1 - w) + ((awayGoals / n) / mean) * w,
    matches: n,
    measured: w > 0.25,
  };
}

/* =============================================================================
   4. FITTING ONE LEAGUE

   The circular problem: a team's attack rating depends on how good the
   defences it faced were, and those depend on their own ratings. The way out
   is repetition — start from last season's ratings, recompute everyone against
   that, and repeat. After a few passes the numbers stop moving.

   Last season enters as PRIOR_WEIGHT "virtual matches" against an average
   opponent at a neutral venue. Early on those dominate; as real matches
   accumulate they take over on their own, with no switch to flip.
   ========================================================================== */

/* League average goals scored by one team in one match (about 1.4 in practice).
   Last season and this season are simply pooled — every team-game counts once,
   which needs no tunable and cannot be gamed. */
function leagueMean(bucket, matches) {
  const prevGoals = sum((bucket.standingsPrev || []).map(t => t.gf));
  const prevGames = sum((bucket.standingsPrev || []).map(t => t.gp));
  const nowGoals = sum(matches.map(m => m.home.g + m.away.g));
  const nowGames = matches.length * 2;

  const goals = prevGoals + nowGoals;
  const games = prevGames + nowGames;
  return games > 0 ? goals / games : 1.35;
}

export function fitLeague(bucket, lg, venue) {
  const matches = leagueMatches(bucket);
  const mean = leagueMean(bucket, matches);

  /* --- last season's ratings, used as the prior --- */
  const prevGoals = sum((bucket.standingsPrev || []).map(t => t.gf));
  const prevGames = sum((bucket.standingsPrev || []).map(t => t.gp));
  const prevMean = prevGames > 0 ? prevGoals / prevGames : null;

  const prior = new Map();
  if (prevMean > 0) {
    for (const t of bucket.standingsPrev) {
      if (t.gp < MODEL.PRIOR_MIN_GAMES) continue;
      prior.set(t.id, {
        attack:  clamp((t.gf / t.gp) / prevMean, MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH),
        defence: clamp((t.ga / t.gp) / prevMean, MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH),
      });
    }
  }

  /* --- everyone currently in the division --- */
  const teams = new Map();
  for (const t of bucket.standingsNow || []) {
    const p = prior.get(t.id);
    teams.set(t.id, {
      id: t.id,
      name: t.name,
      short: t.short || t.name,
      logo: t.logo || null,
      leagueSlug: lg.slug,
      /* No prior-season record in this league means a promoted side. Treating
         that as zero would be nonsense, so they start below average, which is
         where promoted teams historically land. */
      promoted: !p,
      priorAttack:  p ? p.attack  : MODEL.PROMOTED_ATTACK,
      priorDefence: p ? p.defence : MODEL.PROMOTED_DEFENCE,
      attack:  p ? p.attack  : MODEL.PROMOTED_ATTACK,
      defence: p ? p.defence : MODEL.PROMOTED_DEFENCE,
      matches: 0, gf: 0, ga: 0,
      log: [],
    });
  }

  /* --- attach each team's matches, with a recency weight --- */
  for (const m of matches) {
    const h = teams.get(m.home.id), a = teams.get(m.away.id);
    if (!h || !a) continue;
    h.log.push({ opp: a.id, gf: m.home.g, ga: m.away.g, atHome: true, date: m.date });
    a.log.push({ opp: h.id, gf: m.away.g, ga: m.home.g, atHome: false, date: m.date });
    /* Crests arrive under different field names on different endpoints, so
       whichever payload happens to carry one wins. Purely cosmetic — this can
       stay null forever without affecting a single number. */
    if (!h.logo && m.home.logo) h.logo = m.home.logo;
    if (!a.logo && m.away.logo) a.logo = m.away.logo;
  }
  for (const t of teams.values()) {
    const n = t.log.length;
    t.matches = n;
    t.gf = sum(t.log.map(x => x.gf));
    t.ga = sum(t.log.map(x => x.ga));
    /* The list is chronological, so index n-1 is the most recent match and
       gets weight 1. Everything older halves every RECENCY_HALFLIFE matches. */
    t.log.forEach((x, i) => { x.w = Math.pow(0.5, (n - 1 - i) / MODEL.RECENCY_HALFLIFE); });
  }

  /* --- solve --- */
  const P = MODEL.PRIOR_WEIGHT;
  for (let pass = 0; pass < MODEL.ITERATIONS; pass++) {
    /* Read opponents from a frozen copy so the order teams are visited in
       cannot change the answer. */
    const snap = new Map();
    for (const [id, t] of teams) snap.set(id, { attack: t.attack, defence: t.defence });

    for (const t of teams.values()) {
      let scored = P * mean * t.priorAttack;
      let expectedToScore = P * mean;
      let conceded = P * mean * t.priorDefence;
      let expectedToConcede = P * mean;

      for (const x of t.log) {
        const o = snap.get(x.opp);
        if (!o) continue;
        const vMine  = x.atHome ? venue.home : venue.away;
        const vTheirs = x.atHome ? venue.away : venue.home;
        scored            += x.w * x.gf;
        expectedToScore   += x.w * mean * o.defence * vMine;
        conceded          += x.w * x.ga;
        expectedToConcede += x.w * mean * o.attack * vTheirs;
      }

      t.attack  = clamp(scored / expectedToScore,     MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH);
      t.defence = clamp(conceded / expectedToConcede, MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH);
    }
  }

  return { slug: lg.slug, mean, teams, matches, excluded: countExcluded(bucket, matches) };
}

/* =============================================================================
   5. ONE INDEX FOR ALL LEAGUES

   A Champions League tie can pit a Ligue 1 side against a Premier League side,
   and "1.20 attack" does not mean the same thing in both. Two adjustments make
   the ratings comparable:

     quality (q) — a judgement call, documented as one on the method page:
                   how strong the division is relative to the Premier League.
     scale (s)   — the square root of how freely that league scores relative to
                   the global average.

   The square root is not arbitrary. Expected goals multiply one attack by one
   defence, so putting sqrt on each means the two together reproduce the
   league's own scoring rate exactly. Which gives a property worth having: for
   a match between two teams from the SAME league, q cancels out completely and
   this global index returns precisely what the single-league model would. The
   cross-league adjustment only ever bites when the leagues actually differ.
   ========================================================================== */

export function buildIndex(data) {
  /* Home advantage is a league-wide effect, so pool every match we have. */
  const allMatches = [];
  for (const lg of DOMESTIC) {
    const bucket = data.byLeague[lg.slug];
    if (bucket) allMatches.push(...leagueMatches(bucket));
  }
  const venue = homeAdvantage(allMatches);

  const fits = new Map();
  for (const lg of DOMESTIC) {
    const bucket = data.byLeague[lg.slug];
    if (bucket) fits.set(lg.slug, fitLeague(bucket, lg, venue));
  }

  /* Global average goals per team per game. A league that failed to load
     contributes nothing rather than a placeholder — otherwise a network error
     would quietly drag the global baseline around. */
  let gGoals = 0, gGames = 0;
  for (const f of fits.values()) {
    if (!f.teams.size) continue;
    gGoals += f.mean * f.teams.size;
    gGames += f.teams.size;
  }
  const mean = gGames > 0 ? gGoals / gGames : 1.35;

  const teams = new Map();
  for (const [slug, f] of fits) {
    const q = LEAGUES.find(l => l.slug === slug)?.quality ?? 1;
    const s = Math.sqrt(f.mean / mean);
    for (const t of f.teams.values()) {
      teams.set(t.id, {
        ...t,
        leagueMean: f.mean,
        quality: q,
        /* Attack scaled down in a weaker league; defence scaled up, because
           conceding at the same rate against weaker opposition is worse. */
        gAttack:  clamp(t.attack  * q * s, MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH * 1.5),
        gDefence: clamp(t.defence * s / q, MODEL.MIN_STRENGTH, MODEL.MAX_STRENGTH * 1.5),
      });
    }
  }

  return { mean, venue, teams, fits, season: data.season, prevSeason: data.prevSeason };
}

/* --- Recent form ------------------------------------------------------------
   ESPN sends a form string of its own, and we deliberately ignore it. Reading
   form out of the same match log the model fitted guarantees the strip on the
   card can never disagree with the rating beside it, costs no extra request,
   and hands us the scorelines and opponents as well — which ESPN's "WWDLW"
   does not. If the two ever differed, the honest thing to show is the one the
   model actually used.

   The log is chronological, so the tail is the recent end. It is returned
   most-recent-first, because that is how form is read.
-----------------------------------------------------------------------------*/
export function recentForm(team, index, n = 5) {
  if (!team?.log?.length) return [];
  return team.log.slice(-n).reverse().map(x => {
    const o = index.teams.get(x.opp);
    return {
      result: x.gf > x.ga ? 'W' : x.gf === x.ga ? 'D' : 'L',
      gf: x.gf,
      ga: x.ga,
      atHome: x.atHome,
      date: x.date ?? null,
      opp: o?.short || o?.name || 'opponent',
      oppId: x.opp,
      /* Null whenever ESPN did not hand us one. The strip renders a lettered
         fallback in that case rather than a broken image. */
      oppLogo: o?.logo ?? null,
    };
  });
}

/* =============================================================================
   6. THE SCORELINE MATRIX

   Two Poisson distributions, multiplied out into every combination from 0-0 up
   to 9-9. Two corrections matter:

   Truncation. Stopping at 4 goals a side loses 2.6% of the probability at a
   balanced 1.50-1.20, 7.6% at 2.20-1.00, and 18.7% at 3.00-0.95 — worst exactly
   where a mismatch makes it most visible. At 9 it is under 0.12% everywhere we
   operate, and we renormalise what is left. (Measured in tests/h1.mjs.)

   Dixon-Coles. Two INDEPENDENT Poissons are known to under-predict draws and
   low-scoring games, because real matches are not independent — a side that
   scores first changes how both teams play. The standard fix nudges 0-0 and
   1-1 up and 1-0 / 0-1 down.
   ========================================================================== */

function tau(i, j, lamH, lamA) {
  const r = MODEL.DC_RHO;
  let t = 1;
  if (i === 0 && j === 0) t = 1 - lamH * lamA * r;
  else if (i === 0 && j === 1) t = 1 + lamH * r;
  else if (i === 1 && j === 0) t = 1 + lamA * r;
  else if (i === 1 && j === 1) t = 1 - r;
  return Math.max(t, 0.01);      /* a probability can never go negative */
}

export function matrix(lamH, lamA) {
  const N = MODEL.MAX_GOALS;
  const ph = [], pa = [];
  for (let k = 0; k <= N; k++) { ph.push(poisson(k, lamH)); pa.push(poisson(k, lamA)); }

  const grid = [];
  let total = 0;
  for (let i = 0; i <= N; i++) {
    grid[i] = [];
    for (let j = 0; j <= N; j++) {
      const p = ph[i] * pa[j] * tau(i, j, lamH, lamA);
      grid[i][j] = p > 0 ? p : 0;
      total += grid[i][j];
    }
  }
  if (total > 0) {
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) grid[i][j] /= total;
  }
  return grid;
}

/* Add up the cells that make each market. */
export function outcomes(grid) {
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
  let best = { home: 0, away: 0, prob: -1 };

  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const p = grid[i][j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i + j >= 3) over25 += p;
      if (i >= 1 && j >= 1) btts += p;
      if (p > best.prob) best = { home: i, away: j, prob: p };
    }
  }
  return { home, draw, away, over25, btts, score: best };
}

/* =============================================================================
   7. CONFIDENCE

   Two things have to be true for a prediction to deserve confidence: the
   probabilities must be clearly separated, AND there must be enough of this
   season behind them. A 40-point gap in August rests almost entirely on last
   season, so it is capped. The less-observed of the two teams governs.
   ========================================================================== */

export function confidence(probs, seenHome, seenAway) {
  const ordered = [probs.home, probs.draw, probs.away].sort((a, b) => b - a);
  const gap = (ordered[0] - ordered[1]) * 100;

  const tier = MODEL.CONFIDENCE.find(t => gap >= t.min) ?? MODEL.CONFIDENCE[MODEL.CONFIDENCE.length - 1];
  const seen = Math.min(seenHome, seenAway);
  const cap = MODEL.CONFIDENCE_CAP.find(c => seen >= c.minMatches) ?? { level: 2 };

  const level = Math.min(tier.level, cap.level);
  const word = (MODEL.CONFIDENCE.find(t => t.level === level) ?? tier).word;
  return { level, word, gap, capped: level < tier.level };
}

/* =============================================================================
   8. INSIGHT LINES

   Written from the numbers, never around them. Every generator returns null
   when its condition is not met, so a line can only appear if the fact behind
   it is true. Each carries a salience score; the most informative win.

   Key figures are wrapped in *asterisks*. The renderer turns those into real
   <b> elements — it never parses HTML — which keeps this file free of any DOM
   knowledge while preserving the typography of the card.
   ========================================================================== */

const pct = f => Math.round(f * 100);
const pctOf = f => `${Math.round(Math.abs(f - 1) * 100)}%`;

/* Team names arrive from ESPN. An asterisk in one would confuse the emphasis
   convention above, so drop it. Nothing here is ever treated as markup. */
const safe = s => String(s ?? '').replace(/\*/g, '');

function insights(p) {
  const { probs, market, score, over25, btts, teams, conf } = p;
  const homeName = safe(p.home.name), awayName = safe(p.away.name);
  const pickName = probs.pick === 'home' ? homeName : probs.pick === 'away' ? awayName : 'A draw';
  const out = [];
  const add = (weight, text) => out.push({ weight, text });

  /* --- model against the market: the most interesting thing on the card --- */
  if (market) {
    const mine = probs[probs.pick];
    const theirs = market[probs.pick];
    const gap = mine - theirs;
    if (Number.isFinite(theirs) && Math.abs(gap) >= MODEL.EDGE_THRESHOLD) {
      const label = probs.pick === 'draw' ? 'a draw' : pickName;
      add(100, gap > 0
        ? `The model rates ${label} at *${pct(mine)}%* where the bookmaker implies *${pct(theirs)}%* — a *${pct(Math.abs(gap))}-point* disagreement in the model's favour.`
        : `The bookmaker is more confident here than the model: *${pct(theirs)}%* against the model's *${pct(mine)}%* for ${label}.`);
    }
  }

  /* --- the likeliest single score is a draw, but a team is favoured --- */
  if (score.home === score.away && probs.pick !== 'draw') {
    add(88, `The likeliest single scoreline is *${score.home}–${score.away}*, even though ${pickName} are favoured to win — their edge is spread across many different winning scores rather than concentrated in one.`);
  }

  /* --- no meaningful favourite --- */
  const ordered = [probs.home, probs.draw, probs.away].sort((a, b) => b - a);
  const lead = Math.round((ordered[0] - ordered[1]) * 100);
  if ((ordered[0] - ordered[1]) * 100 < 5) {
    add(85, `There is no real favourite in this one — the top two outcomes sit within *${Math.max(1, lead)} point${lead === 1 ? '' : 's'}* of each other.`);
  }

  /* --- promoted side with no prior-season record --- */
  for (const [t, label] of [[teams.home, homeName], [teams.away, awayName]]) {
    if (t.promoted) {
      add(80, `${label} have *no record* in this division from last season, so the model starts them below average and lets real results move them — expect these numbers to shift quickly.`);
    }
  }

  /* --- thin current-season evidence --- */
  const seen = Math.min(teams.home.matches, teams.away.matches);
  if (seen < 4) {
    add(72,
      seen === 0 ? `Neither side has a completed league match this season, so this rests *entirely* on last season's record.`
      : seen === 1 ? `Just *one* league match this season sits behind the less-observed side, so last season is still doing most of the work.`
      : `Only *${seen}* league matches this season sit behind the less-observed side, so last season is still doing most of the work.`);
  }

  /* --- the clearest attack-versus-defence mismatch --- */
  const pairs = [
    { a: teams.home.attack, d: teams.away.defence, at: homeName, dt: awayName },
    { a: teams.away.attack, d: teams.home.defence, at: awayName, dt: homeName },
  ];
  const edge = pairs.sort((x, y) => (y.a * y.d) - (x.a * x.d))[0];
  if (edge.a * edge.d > 1.30) {
    add(65, `${edge.at} score *${pctOf(edge.a)}* ${edge.a >= 1 ? 'more' : 'less'} than an average side in their division, and ${edge.dt} concede *${pctOf(edge.d)}* ${edge.d >= 1 ? 'more' : 'less'} — the largest single edge in this match.`);
  }

  /* --- goals expectation, when it is decisive --- */
  if (over25 >= 0.60) add(55, `Goals look likely: over 2.5 comes in at *${pct(over25)}%*, with both teams scoring at *${pct(btts)}%*.`);
  else if (over25 <= 0.42) add(55, `This projects tight — under 2.5 goals is the stronger side of that line at *${pct(1 - over25)}%*.`);

  /* --- a draw worth noticing --- */
  if (probs.draw >= 0.29 && probs.pick !== 'draw') {
    add(50, `A draw at *${pct(probs.draw)}%* is high even for football, where the long-run rate is nearer a quarter — both expected-goal figures are low and close together.`);
  }

  /* --- confidence was held back on purpose --- */
  if (conf.capped) {
    add(40, `The probability gap here would normally read higher, but confidence is *capped* this early in the season until more matches are played.`);
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, MODEL.INSIGHT_MAX).map(x => x.text);
}

/* =============================================================================
   9. PREDICTING ONE FIXTURE
   ========================================================================== */

/* Why a fixture has no prediction. Four different things can cause this and
   conflating them would be a lie: nothing loaded at all, one league that
   failed, a team missing from a table we did read, or a genuinely untracked
   team. A network error must never be reported as "this team is outside our
   leagues", and nor must a gap in a table for a league we do follow. */
const NUMBER_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function missingReason(fixture, H, A, index) {
  const lg = LEAGUES.find(l => l.slug === fixture.leagueSlug);
  const anyLoaded = [...index.fits.values()].some(f => f.teams.size > 0);

  if (!anyLoaded) {
    return `Prediq could not load the league data behind this fixture, so there is no prediction to show. This is usually temporary — a reload normally fixes it.`;
  }
  if (lg?.domestic && !index.fits.get(lg.slug)?.teams.size) {
    return `${lg.name} data did not load this time, so this fixture has nothing behind it. A reload normally fixes it.`;
  }

  const names = [];
  if (!H) names.push(fixture.home.name);
  if (!A) names.push(fixture.away.name);
  const who = names.join(' and ');
  const many = names.length > 1;

  /* The league loaded, but its table does not list this side. The team is not
     outside our coverage — it is inside this very league, just absent from the
     table strengths are read from. Usually a lag after promotion. */
  if (lg?.domestic) {
    return `${who} ${many ? 'do' : 'does'} not appear in the current ${lg.name} table, which is where Prediq reads team strength from, so this fixture is listed without a prediction.`;
  }

  /* A cup tie against a side from a division Prediq does not follow. */
  const count = NUMBER_WORD[DOMESTIC.length] ?? String(DOMESTIC.length);
  return `${who} ${many ? 'play' : 'plays'} outside the ${count} leagues Prediq tracks, so there is no data behind a prediction here. Rather than guess, this fixture is listed without one.`;
}

export function predict(fixture, index) {
  const league = LEAGUES.find(l => l.slug === fixture.leagueSlug) ?? null;
  const H = index.teams.get(fixture.home.id);
  const A = index.teams.get(fixture.away.id);

  if (!H || !A) {
    return { fixture, league, ok: false, reason: missingReason(fixture, H, A, index) };
  }

  /* Expected goals. Clamped only to keep a pathological input from producing
     an absurd matrix — in normal use these sit between about 0.4 and 3.5. */
  const lamH = clamp(index.mean * H.gAttack * A.gDefence * index.venue.home, 0.05, 6);
  const lamA = clamp(index.mean * A.gAttack * H.gDefence * index.venue.away, 0.05, 6);

  const grid = matrix(lamH, lamA);
  const o = outcomes(grid);

  const probs = { home: o.home, draw: o.draw, away: o.away };
  probs.pick = probs.home >= probs.draw && probs.home >= probs.away ? 'home'
             : probs.away >= probs.draw ? 'away' : 'draw';

  const [ph, pd, pa] = roundTo100([probs.home, probs.draw, probs.away]);
  const conf = confidence(probs, H.matches, A.matches);

  const market = fixture.odds
    ? { home: fixture.odds.home, draw: fixture.odds.draw, away: fixture.odds.away,
        overround: fixture.odds.overround, provider: fixture.odds.provider }
    : null;

  const p = {
    fixture, league, ok: true,
    home: { id: H.id, name: H.name, short: H.short },
    away: { id: A.id, name: A.name, short: A.short },
    lambda: { home: lamH, away: lamA },
    probs,
    pct: { home: ph, draw: pd, away: pa },
    score: o.score,
    over25: o.over25,
    btts: o.btts,
    conf,
    market,
    teams: { home: H, away: A },
    form: { home: recentForm(H, index), away: recentForm(A, index) },
    crossLeague: H.leagueSlug !== A.leagueSlug,
  };
  p.insights = insights(p);
  return p;
}

/* Every fixture we hold, soonest first, predictions attached. */
export function predictAll(data) {
  const index = buildIndex(data);
  const predictions = data.fixtures
    .map(f => predict(f, index))
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  return { index, predictions };
}

/* =============================================================================
   10. POWER RATINGS

   The ratings page needs one number per team that orders them honestly. Goal
   difference would do, but the model already knows how to turn a pair of
   expected-goal figures into a result, so the more useful scalar is the one it
   would actually predict: expected points per game against an average side on
   neutral ground.

   It comes off the same grid the match cards do, through the same matrix() and
   outcomes(), which means a team's power rating can never contradict the
   predictions it appears in. This is a second view of one model, not a second
   model — the same property that stops the four figures on a card disagreeing.

   Two scales exist here and they are not interchangeable:

     'league' — the team's own division is the yardstick. Purely fitted, no
                judgement calls in it, and meaningless across leagues.
     'global' — the quality-adjusted ratings. Comparable between leagues, but
                only as good as the coefficients on the method page, which are
                stated there as an informed guess rather than a measurement.

   The average opponent is measured rather than assumed to be 1.00. It should
   come out at 1.00 by construction and the tests check that it does, but a
   league that half-loaded would shift it, and in that case the honest reference
   is the one actually present in the data.
   ========================================================================== */

function averageOpponent(teams, attackOf, defenceOf) {
  if (!teams.length) return { attack: 1, defence: 1 };
  return {
    attack:  sum(teams.map(attackOf))  / teams.length,
    defence: sum(teams.map(defenceOf)) / teams.length,
  };
}

/* One row. `mean` is the goals-per-team-per-game baseline for whichever scale
   we are on, and `ref` is the average side on that same scale. No venue factor
   is applied to either lambda, which is what "neutral ground" means. */
function powerRow(team, scope, mean, attack, defence, ref) {
  const xgFor     = clamp(mean * attack * ref.defence, 0.05, 6);
  const xgAgainst = clamp(mean * ref.attack * defence, 0.05, 6);

  /* outcomes() names the first lambda "home". Here the first lambda is this
     team, so home is its win and away is its defeat. */
  const o = outcomes(matrix(xgFor, xgAgainst));

  return {
    id: team.id,
    name: team.name,
    short: team.short || team.name,
    leagueSlug: team.leagueSlug,
    scope,
    matches: team.matches,
    promoted: team.promoted,
    attack, defence,
    xgFor, xgAgainst,
    xgd: xgFor - xgAgainst,
    win: o.home, drawP: o.draw, loss: o.away,
    xPoints: 3 * o.home + o.draw,
    score: o.score,
  };
}

/* Sorted strongest first. Ties break on goal difference and then on name, so
   the order is stable rather than dependent on Map insertion. */
function byStrength(a, b) {
  return b.xPoints - a.xPoints || b.xgd - a.xgd || a.name.localeCompare(b.name);
}

export function powerTable(index, scope = 'league') {
  const rows = [];

  if (scope === 'global') {
    const all = [...index.teams.values()];
    const ref = averageOpponent(all, t => t.gAttack, t => t.gDefence);
    for (const t of all) {
      rows.push(powerRow(t, scope, index.mean, t.gAttack, t.gDefence, ref));
    }
  } else {
    /* Each league is fitted on its own scale, so each gets its own baseline
       and its own average opponent. */
    for (const [slug, f] of index.fits) {
      const teams = [...f.teams.keys()].map(id => index.teams.get(id)).filter(Boolean);
      const ref = averageOpponent(teams, t => t.attack, t => t.defence);
      for (const t of teams) {
        rows.push(powerRow(t, scope, f.mean, t.attack, t.defence, ref));
      }
    }
  }

  return rows.sort(byStrength);
}

/* Per-league summary for the table headings: how freely the division scores,
   how many of its matches the fit actually counted, and how many it threw out
   as cup ties. All of it already computed — this just names it. */
export function leagueSummaries(index) {
  const out = [];
  for (const lg of DOMESTIC) {
    const f = index.fits.get(lg.slug);
    if (!f || !f.teams.size) continue;
    out.push({
      slug: lg.slug,
      name: lg.name,
      abbr: lg.abbr,
      quality: lg.quality,
      teams: f.teams.size,
      mean: f.mean,
      matches: f.matches.length,
      excluded: f.excluded,
    });
  }
  return out;
}
