/* =============================================================================
   record.js — the frozen prediction

   Everything else in Prediq is computed fresh in your browser and forgotten.
   This file defines the one thing that gets written down and kept: what we
   predicted, before the match, and what then happened.

   THE RULE THAT DECIDES THE WHOLE SCHEMA

   Store what we claimed, and store what happened. Derive every judgement about
   whether we were right.

   So a record holds the probabilities we showed, the scoreline we called, the
   bookmaker's price at the time, and — later — the final score. It does NOT
   hold "correct: true", or a hit rate, or a log loss. Those are computed by
   score() on read, every time.

   Two reasons, both practical. A scoring bug can be fixed and the entire
   history re-scored, instead of being baked into thousands of documents that
   would then need rewriting. And the per-match verdict and the site-wide
   accuracy figure come from one function, so they cannot drift apart — the same
   property that stops the four numbers on a match card disagreeing.

   WHY THE ODDS ARE IN HERE AT ALL

   ESPN deletes bookmaker prices the moment a match finishes. Verified against a
   full month of last season across all fourteen competitions: every result
   intact, not one priced fixture. So model-versus-market accuracy cannot be
   reconstructed after the fact by anyone, including us. Freezing the price
   before kickoff is the only honest route to that comparison, and it is why
   this file exists rather than a nightly scrape of results.

   WHAT A RECORD DELIBERATELY DOES NOT CONTAIN

   No team match logs, no ratings, no form strips, no crests, no insight prose.
   All of it is derivable from data we can fetch again, and a record that
   embedded the ratings would be a second copy of the model drifting out of step
   with the first. A record is about one match: roughly 700 bytes of JSON.
   ========================================================================== */

import { MODEL, MODEL_REV, LEAGUES, FREEZE_WITHIN_HOURS } from './config.js';

export const SCHEMA = 1;

/* --- quantising -------------------------------------------------------------
   Probabilities are stored to four decimal places and expected goals to three.
   Not for size — for stability. Floating point makes two runs of the same
   arithmetic differ in the sixteenth decimal, and a stored record that changes
   without meaning anything defeats the point of freezing it: you could no
   longer tell an edit from noise.
--------------------------------------------------------------------------- */
const q4 = n => Math.round(n * 1e4) / 1e4;
const q3 = n => Math.round(n * 1e3) / 1e3;

/* --- the day key ------------------------------------------------------------
   Records are grouped by calendar day, and that day is UTC, always.

   If the key came from local time, the same match would belong to different
   days depending on who was asking — a 23:00 UTC kickoff is Saturday in London
   and Sunday in Lagos — so the writer and the reader would disagree about which
   file a prediction is in. Display is a separate concern and stays local.
--------------------------------------------------------------------------- */
export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return null;
  return d.toISOString().slice(0, 10);
}

/* --- the model fingerprint --------------------------------------------------
   A record has to say which model made it. Without this, retuning a parameter
   would let the new model inherit the old one's track record, or be blamed for
   it — either way the accuracy page would be quoting a number about nothing.

   Two fields, doing different jobs. `rev` is set by hand in config.js and is
   what the accuracy page groups by. `hash` is computed from the parameters that
   actually change a prediction, so it catches a change made without bumping the
   rev. If a rev ever shows two hashes, the record is telling you someone
   retuned the model and forgot to say so.

   FNV-1a, because it needs no dependency and does not need to be secure. It is
   a change detector, not a signature.

   The league list is inside the hash on purpose, and it is the non-obvious
   entry. Home advantage is fitted from every domestic league pooled together,
   so adding a competition shifts every existing rating slightly. Predictions
   made before and after that change are genuinely not from the same model, and
   the hash should say so even though no tuning parameter moved.
--------------------------------------------------------------------------- */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function modelHash() {
  return fnv1a(canonical({
    schema: SCHEMA,
    model: MODEL,
    leagues: LEAGUES.map(l => [l.slug, l.quality ?? null, !!l.domestic]),
  })).slice(0, 8);
}

/* =============================================================================
   FREEZING

   Returns either { record } or { skip: reason }. Never throws, because the
   scheduled writer processes a whole day and one unusable fixture must not take
   the rest down with it — but every skip carries a reason, so a day that
   silently froze nothing is distinguishable from a day with no fixtures.

   The refusals, and why each is a refusal rather than a stored blank:

     the model declined      — a record whose prediction is "we don't know" has
                               nothing to score and would dilute the hit rate
                               with matches we never called
     kickoff already passed  — the entire claim of this file is that the
                               prediction predates the match. A record written
                               after kickoff cannot be told apart from one
                               written before it by anyone reading the data
                               later, so it must not be written at all
     no kickoff time         — nothing to compare `at` against, so the property
                               above becomes unverifiable
     kickoff too far off     — the lead time of the archive is a stated constant,
                               not whatever the fixture window happens to be. See
                               FREEZE_WITHIN_HOURS in config.js: recording a
                               match a week out would archive a figure no visitor
                               ever saw
   ========================================================================== */
export function freeze(prediction, now = new Date()) {
  const f = prediction?.fixture;
  if (!f?.id) return { skip: 'no fixture id' };
  if (!prediction.ok) return { skip: 'model declined: ' + (prediction.reason || 'no reason given') };

  const kickoff = new Date(f.date);
  if (Number.isNaN(+kickoff)) return { skip: 'unreadable kickoff time' };
  if (+now >= +kickoff) return { skip: 'kickoff already passed' };
  if (+kickoff - +now > FREEZE_WITHIN_HOURS * 3600e3) {
    return { skip: 'kickoff more than ' + FREEZE_WITHIN_HOURS + 'h away' };
  }

  const record = {
    v: SCHEMA,
    id: String(f.id),
    kickoff: kickoff.toISOString(),
    league: f.leagueSlug,
    home: { id: String(prediction.home.id), name: prediction.home.name },
    away: { id: String(prediction.away.id), name: prediction.away.name },

    predicted: {
      at: new Date(now).toISOString(),
      /* [home, away] throughout this file. Named pairs would be clearer to read
         and about 40% larger, and this is the shape that repeats thousands of
         times. The order is fixed and documented; nothing infers it. */
      lambda: [q3(prediction.lambda.home), q3(prediction.lambda.away)],
      probs: [q4(prediction.probs.home), q4(prediction.probs.draw), q4(prediction.probs.away)],
      pick: prediction.probs.pick,
      score: [prediction.score.home, prediction.score.away, q4(prediction.score.prob)],
      over25: q4(prediction.over25),
      btts: q4(prediction.btts),
      conf: { level: prediction.conf.level, word: prediction.conf.word },
      /* How many matches of this season each side had been seen in when we
         called it. The single most useful field for judging a wrong prediction
         after the fact, and it cannot be recovered later — by then both teams
         have played a full season. */
      seen: [prediction.teams.home.matches, prediction.teams.away.matches],
    },

    /* Null when nobody had priced it. An absent price and a price of even money
       are different facts, and the market comparison must only ever be computed
       over the subset where a real price was frozen. */
    market: prediction.market ? {
      provider: prediction.market.provider,
      probs: [q4(prediction.market.home), q4(prediction.market.draw), q4(prediction.market.away)],
      overround: q4(prediction.market.overround),
    } : null,

    model: { rev: MODEL_REV, hash: modelHash() },

    /* Filled in by attachResult after the match. Present and null rather than
       absent, so "not played yet" and "we never scored this one" look the same
       to a reader and neither can be mistaken for a missing field. */
    result: null,
  };

  return { record };
}

/* --- the result ------------------------------------------------------------
   Two numbers and a timestamp. Everything a reader wants to know beyond that —
   who won, whether we called it, how badly we missed — is score()'s job.
--------------------------------------------------------------------------- */
export function attachResult(record, { home, away, at = new Date() } = {}) {
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
    return { skip: 'unusable final score' };
  }
  return {
    record: { ...record, result: { at: new Date(at).toISOString(), goals: [home, away] } },
  };
}

/* =============================================================================
   SCORING — every judgement, derived on read

   Log loss is the headline because it is the only one of these that grades the
   probability rather than the pick. A model that says 51% and one that says 99%
   both "get it right", and a hit rate cannot tell them apart; log loss can, and
   punishes the confident miss hardest. Its reference point is a model that
   knows nothing and says one-third to everything: ln 3 = 1.0986. Anything above
   that is worse than useless.

   Brier is reported alongside it in the summed three-class form, which runs 0
   to 2 with a no-knowledge baseline of 0.667. It is bounded where log loss is
   not, so one catastrophic miss cannot dominate the average — the two together
   say more than either alone.
   ========================================================================== */
const LOG_FLOOR = 1e-9;
export const NO_KNOWLEDGE = { logLoss: Math.log(3), brier: 2 / 3 };

const outcomeOf = ([h, a]) => (h > a ? 'home' : h === a ? 'draw' : 'away');
const INDEX = { home: 0, draw: 1, away: 2 };

function grade(probs, outcome) {
  const y = [0, 0, 0];
  y[INDEX[outcome]] = 1;
  return {
    logLoss: -Math.log(Math.max(probs[INDEX[outcome]], LOG_FLOOR)),
    brier: probs.reduce((t, p, i) => t + (p - y[i]) ** 2, 0),
    pick: probs.indexOf(Math.max(...probs)),
  };
}

export function score(record) {
  if (!record?.result?.goals) return null;

  const goals = record.result.goals;
  const outcome = outcomeOf(goals);
  const total = goals[0] + goals[1];
  const p = record.predicted;

  const model = grade(p.probs, outcome);

  /* Outcomes in the order the model ranked them, so "was it our second choice?"
     is a lookup rather than an argument. */
  const ranked = ['home', 'draw', 'away'].sort((a, b) => p.probs[INDEX[b]] - p.probs[INDEX[a]]);

  /* The three either-way calls are graded the way they were shown: as a claim
     that the thing is more likely than not. A 50/50 counts as no call, because
     asserting it went either way would be scoring a coin toss as a prediction. */
  const call = (prob, happened) => (prob === 0.5 ? null : (prob > 0.5) === happened);

  const verdict = {
    outcome,
    goals,
    hit: p.pick === outcome,
    /* Distinguishing these two matters when reading a run of losses. A draw we
       made second-favourite is a different kind of miss from one we had third,
       and lumping them together hides whether the model is wrong about the match
       or just wrong about the order. */
    runnerUp: p.pick !== outcome && ranked[1] === outcome,
    exact: p.score[0] === goals[0] && p.score[1] === goals[1],
    over25: call(p.over25, total >= 3),
    btts: call(p.btts, goals[0] >= 1 && goals[1] >= 1),
    logLoss: model.logLoss,
    brier: model.brier,
    /* What the model assigned to what actually happened. The rawest possible
       statement of how the prediction did, and the one worth showing on a card:
       "we gave this 24%". */
    assigned: p.probs[INDEX[outcome]],
    market: null,
  };

  if (record.market?.probs) {
    const m = grade(record.market.probs, outcome);
    const marketPick = ['home', 'draw', 'away'][m.pick];
    verdict.market = {
      pick: marketPick,
      hit: marketPick === outcome,
      logLoss: m.logLoss,
      brier: m.brier,
      assigned: record.market.probs[INDEX[outcome]],
      /* Both agreed and both wrong is the common case and says nothing about
         which is better. The informative subset is where they disagreed. */
      disagreed: marketPick !== p.pick,
      beatMarket: model.logLoss < m.logLoss,
    };
  }

  return verdict;
}

/* =============================================================================
   THE AGGREGATE

   One function behind the accuracy page, so the site-wide figure and the
   per-match verdicts cannot disagree.

   Three things here are deliberate and each is a place where an accuracy page
   could flatter itself without technically lying:

   Records are grouped by model rev, not pooled. A record made by a model that
   no longer exists is not evidence about the current one, and pooling them
   quietly credits today's model with yesterday's results.

   The market comparison runs only over records where a price was frozen. Any
   larger denominator would be comparing the model on all matches against the
   bookmaker on some of them.

   Calibration pools all three probabilities from every match, not just the one
   we picked. Grading only your own picks measures a self-selected sample, and a
   model that is well calibrated on favourites and hopeless on draws would look
   fine.
   ========================================================================== */
export function summarise(records, { rev = null } = {}) {
  const all = (records || []).filter(r => r?.predicted?.probs);
  const pool = rev ? all.filter(r => r.model?.rev === rev) : all;

  const scored = [];
  for (const r of pool) {
    const v = score(r);
    if (v) scored.push({ record: r, verdict: v });
  }

  const revs = {};
  for (const r of pool) {
    const k = r.model?.rev ?? 'unknown';
    revs[k] = (revs[k] || 0) + 1;
  }
  const hashes = new Set(pool.map(r => r.model?.hash).filter(Boolean));

  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rate = (n, d) => (d ? n / d : null);

  /* Ten buckets by predicted probability. Each is honest about its own size,
     because a bucket holding four matches is not evidence and the page has to
     be able to say so rather than drawing a confident line through it. */
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10, to: (i + 1) / 10, n: 0, predicted: 0, happened: 0,
  }));
  for (const { record, verdict } of scored) {
    for (const key of ['home', 'draw', 'away']) {
      const p = record.predicted.probs[INDEX[key]];
      const b = bins[Math.min(9, Math.floor(p * 10))];
      b.n++;
      b.predicted += p;
      if (verdict.outcome === key) b.happened++;
    }
  }
  const calibration = bins.filter(b => b.n > 0).map(b => ({
    from: b.from, to: b.to, n: b.n,
    predicted: b.predicted / b.n,
    observed: b.happened / b.n,
  }));

  const priced = scored.filter(s => s.verdict.market);
  const ou = scored.filter(s => s.verdict.over25 !== null);
  const bt = scored.filter(s => s.verdict.btts !== null);

  return {
    rev,
    revs,
    /* More than one hash under one rev means the model was changed without the
       rev being bumped. The page should say so plainly rather than quietly
       averaging across two models. */
    revConsistent: hashes.size <= 1,
    n: pool.length,
    scored: scored.length,
    pending: pool.length - scored.length,

    hitRate: rate(scored.filter(s => s.verdict.hit).length, scored.length),
    exactRate: rate(scored.filter(s => s.verdict.exact).length, scored.length),
    logLoss: mean(scored.map(s => s.verdict.logLoss)),
    brier: mean(scored.map(s => s.verdict.brier)),
    baseline: NO_KNOWLEDGE,

    over25Rate: rate(ou.filter(s => s.verdict.over25).length, ou.length),
    bttsRate: rate(bt.filter(s => s.verdict.btts).length, bt.length),

    byConfidence: MODEL.CONFIDENCE.map(t => {
      const set = scored.filter(s => s.record.predicted.conf.level === t.level);
      return {
        level: t.level, word: t.word, n: set.length,
        hitRate: rate(set.filter(s => s.verdict.hit).length, set.length),
        logLoss: mean(set.map(s => s.verdict.logLoss)),
      };
    }),

    calibration,

    market: {
      n: priced.length,
      /* Stated so the page can be explicit about it: this is the fraction of
         scored matches the comparison could use at all. A low number is itself
         the finding. */
      coverage: rate(priced.length, scored.length),
      modelLogLoss: mean(priced.map(s => s.verdict.logLoss)),
      marketLogLoss: mean(priced.map(s => s.verdict.market.logLoss)),
      modelBrier: mean(priced.map(s => s.verdict.brier)),
      marketBrier: mean(priced.map(s => s.verdict.market.brier)),
      modelHitRate: rate(priced.filter(s => s.verdict.hit).length, priced.length),
      marketHitRate: rate(priced.filter(s => s.verdict.market.hit).length, priced.length),
      disagreed: priced.filter(s => s.verdict.market.disagreed).length,
      /* Where they disagreed, who was right. The only figure here that is
         actually about the model beating the market rather than tracking it. */
      wonDisagreements: rate(
        priced.filter(s => s.verdict.market.disagreed && s.verdict.hit).length,
        priced.filter(s => s.verdict.market.disagreed).length,
      ),
    },
  };
}
