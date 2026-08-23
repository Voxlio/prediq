/* rec1.mjs — the frozen prediction record.

   This is the only part of Prediq whose output outlives the page, so the things
   worth asserting are different from every other suite here. A render bug shows
   up the next time someone looks. A schema bug is written into thousands of
   documents and discovered a season later.

   What that means in practice:
     - a record must survive JSON round-tripping unchanged, exactly
     - it must never be written after kickoff, because nothing downstream could
       detect that it had been
     - the derived judgements must be derived, not stored — so re-scoring an old
       record with fixed code must give the corrected answer
     - the fingerprint must actually change when the model does

   The predictions fed in come from the real model via predictAll, not from
   hand-written objects. Hand-feeding a shape another module produces is how a
   seam bug survives the test meant to catch it.
*/

const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const R = await import(base + 'record.js');
const C = await import(base + 'config.js');
const { MODEL, MODEL_REV, LEAGUES } = C;

let fails = 0;
const ok = (l, c, g) => {
  console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g)));
  if (!c) fails++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---------- the same Premier League data the model suites use ---------- */
const PREV = [
  ['1','Liverpool',86,41], ['2','Arsenal',69,34], ['3','Man City',72,44], ['4','Chelsea',64,43],
  ['5','Newcastle',68,47], ['6','Aston Villa',58,51], ['7','Nottm Forest',58,46], ['8','Brighton',66,59],
  ['9','Bournemouth',58,46], ['10','Brentford',66,57], ['11','Fulham',54,54], ['12','Crystal Palace',51,51],
  ['13','Everton',42,44], ['14','West Ham',46,62], ['15','Man United',44,54], ['16','Wolves',54,69],
  ['17','Tottenham',64,65], ['18','Leicester',33,80], ['19','Ipswich',36,82], ['20','Southampton',26,86],
].map(([id, name, gf, ga]) => ({ id, name, short: name, gp: 38, gf, ga, rank: +id }));

const NOW = PREV.slice(0, 17).map(t => ({ ...t, gp: 6, gf: 9, ga: 8 }))
  .concat([['21','Leeds'], ['22','Burnley'], ['23','Sunderland']]
    .map(([id, name]) => ({ id, name, short: name, gp: 6, gf: 5, ga: 11, rank: null })));

const RES = (h, a, hg, ag, date) => ({
  date, home: { id: h, name: '', g: hg }, away: { id: a, name: '', g: ag },
});
const RESULTS = [
  RES('2','12',3,0,'2026-08-15'), RES('1','21',2,1,'2026-08-15'), RES('4','22',1,1,'2026-08-16'),
  RES('3','23',4,0,'2026-08-16'), RES('5','13',2,2,'2026-08-16'), RES('15','8',0,2,'2026-08-17'),
];

/* One frozen instant. Two freezes of the same fixture must be byte-identical
   apart from `predicted.at`, and a clock that moved would hide the difference. */
const T0 = new Date('2026-08-23T09:00:00.000Z');
const hrs = h => new Date(+T0 + h * 3600e3).toISOString();
const nameOf = id => (NOW.find(t => t.id === id) || { name: 'Unknown FC' }).name;
const F = (id, h, a, out, odds = null, slug = 'eng.1') => ({
  id, leagueSlug: slug, date: hrs(out), venue: null,
  home: { id: h, name: nameOf(h), short: '', form: null },
  away: { id: a, name: nameOf(a), short: '', form: null },
  odds,
});

const FIXTURES = [
  F('701', '1', '16', 5),                                     /* strong home side */
  F('702', '11', '12', 8, { home: 0.40, draw: 0.28, away: 0.32,
                            overround: 1.06, overUnder: 2.5, provider: 'DraftKings' }),
  F('703', '21', '2', 30),                                    /* promoted vs strong */
  F('704', '999', '1', 52),                                   /* model will refuse */
];

const data = {
  season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: +T0,
  fixtures: FIXTURES,
  byLeague: { 'eng.1': { standingsNow: NOW, standingsPrev: PREV, results: RESULTS } },
};
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) {
  data.byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
}
const { predictions } = M.predictAll(data);
const byId = id => predictions.find(p => p.fixture.id === id);

/* =============================================================================
   1. THE FINGERPRINT
   ========================================================================== */
console.log('=== the model fingerprint ===');
const hash = R.modelHash();
console.log('    rev ' + MODEL_REV + ', hash ' + hash);

ok('a hash is produced', /^[0-9a-f]{8}$/.test(hash), hash);
ok('and it is stable across calls', R.modelHash() === hash);
ok('a rev is set in config', typeof MODEL_REV === 'string' && MODEL_REV.length > 0, MODEL_REV);

/* The hash has to notice a retune. Mutating MODEL in place is safe here because
   nothing after this point re-reads the changed key, and it is restored. */
const restore = MODEL.DC_RHO;
MODEL.DC_RHO = restore - 0.01;
const retuned = R.modelHash();
MODEL.DC_RHO = restore;
ok('retuning a parameter changes the hash', retuned !== hash, [hash, retuned]);
ok('and restoring it changes the hash back', R.modelHash() === hash);

/* The non-obvious one. Adding a league shifts every rating, because home
   advantage is fitted from all domestic leagues pooled — so the hash must move
   even though no tuning parameter did. */
LEAGUES.push({ slug: 'test.1', name: 'Test', quality: 0.5, domestic: true });
const expanded = R.modelHash();
LEAGUES.pop();
ok('adding a league changes the hash too, since it shifts home advantage',
  expanded !== hash, [hash, expanded]);
ok('and removing it restores the hash', R.modelHash() === hash);

/* =============================================================================
   2. FREEZING
   ========================================================================== */
console.log('');
console.log('=== a frozen record, in full ===');
const { record: rec } = R.freeze(byId('702'), T0);
console.log(JSON.stringify(rec, null, 2).replace(/^/gm, '    '));
const bytes = JSON.stringify(rec).length;
console.log('    ' + bytes + ' bytes');

ok('the record is small enough to store thousands of', bytes < 900, bytes);
ok('the schema version is stamped on it', rec.v === R.SCHEMA, rec.v);
ok('the id is the ESPN event id, as a string',
  rec.id === '702' && typeof rec.id === 'string', rec.id);
ok('the league is recorded', rec.league === 'eng.1', rec.league);
ok('both team ids and names are recorded',
  rec.home.id === '11' && rec.away.id === '12' && rec.home.name && rec.away.name, [rec.home, rec.away]);

ok('probabilities are stored as [home, draw, away]', rec.predicted.probs.length === 3);
ok('and they sum to 1 within rounding',
  near(rec.predicted.probs.reduce((a, b) => a + b, 0), 1, 2e-4),
  rec.predicted.probs);
ok('every stored probability is quantised to 4dp — no float noise',
  [...rec.predicted.probs, rec.predicted.over25, rec.predicted.btts]
    .every(p => Number(p.toFixed(4)) === p),
  rec.predicted.probs);
ok('expected goals are quantised to 3dp',
  rec.predicted.lambda.every(l => Number(l.toFixed(3)) === l), rec.predicted.lambda);
ok('the pick is one of the three outcomes',
  ['home', 'draw', 'away'].includes(rec.predicted.pick), rec.predicted.pick);
ok('the likeliest scoreline is stored with its probability',
  Number.isInteger(rec.predicted.score[0]) && Number.isInteger(rec.predicted.score[1]) &&
  rec.predicted.score[2] > 0 && rec.predicted.score[2] < 1, rec.predicted.score);
ok('confidence is stored as both level and word',
  rec.predicted.conf.level >= 1 && typeof rec.predicted.conf.word === 'string', rec.predicted.conf);
ok('how much of the season each side had been seen in is recorded',
  rec.predicted.seen.length === 2 && rec.predicted.seen.every(Number.isInteger), rec.predicted.seen);
ok('the model rev and hash are both stamped on',
  rec.model.rev === MODEL_REV && rec.model.hash === hash, rec.model);
ok('result is present and null, not absent',
  'result' in rec && rec.result === null);

console.log('');
console.log('=== the frozen price ===');
ok('the bookmaker price is frozen, since ESPN deletes it after kickoff',
  rec.market && rec.market.probs.length === 3, rec.market);
ok('the frozen price is normalised the same way the card showed it',
  near(rec.market.probs.reduce((a, b) => a + b, 0), 1, 2e-4), rec.market.probs);
ok('the overround is kept, so the raw price can be recovered',
  rec.market.overround > 1, rec.market.overround);
ok('and the provider is named', rec.market.provider === 'DraftKings', rec.market.provider);

const unpriced = R.freeze(byId('701'), T0).record;
ok('an unpriced match stores market as null, not as even money',
  unpriced.market === null, unpriced.market);

/* =============================================================================
   3. WHAT IT REFUSES TO FREEZE

   Each of these would produce a record that looks valid to a reader a year
   later and is not. That is the whole reason they are refusals.
   ========================================================================== */
console.log('');
console.log('=== refusals ===');
const refusals = [
  ['a fixture with no id', { ...byId('701'), fixture: { ...byId('701').fixture, id: null } }, T0],
  ['a match the model declined', byId('704'), T0],
  ['an unreadable kickoff time', { ...byId('701'), fixture: { ...byId('701').fixture, date: 'soon' } }, T0],
  ['a kickoff that has already passed', byId('701'), new Date(+T0 + 6 * 3600e3)],
  ['a kickoff happening exactly now', byId('701'), new Date(byId('701').fixture.date)],
  ['a kickoff further out than the stated lead time',
    byId('701'), new Date(+new Date(byId('701').fixture.date) - (C.FREEZE_WITHIN_HOURS + 1) * 3600e3)],
];
for (const [label, pred, when] of refusals) {
  const out = R.freeze(pred, when);
  ok('refuses ' + label, !out.record && typeof out.skip === 'string' && out.skip.length > 0, out);
}
console.log('    reasons: ' + refusals.map(([, p, w]) => R.freeze(p, w).skip).join(' / '));

/* The lead-time window is the one refusal with a boundary worth pinning down.
   Off by an hour in one direction and every fixture is archived a week early;
   off in the other and matches inside the window are silently never recorded. */
{
  const ko = +new Date(byId('701').fixture.date);
  const at = h => R.freeze(byId('701'), new Date(ko - h * 3600e3));
  ok('a fixture exactly at the window edge is recorded',
    !!at(C.FREEZE_WITHIN_HOURS).record, at(C.FREEZE_WITHIN_HOURS).skip);
  ok('a minute outside it is not',
    !at(C.FREEZE_WITHIN_HOURS + 1 / 60).record);
  ok('and the window is short enough to mean something',
    C.FREEZE_WITHIN_HOURS < C.FIXTURE_DAYS * 24, C.FREEZE_WITHIN_HOURS);
}

ok('freeze never throws, so one bad fixture cannot take a whole day down',
  (() => { try { R.freeze(null); R.freeze({}); R.freeze(undefined, NaN); return true; }
           catch { return false; } })());
ok('the prediction is always stamped before the kickoff it predicts',
  new Date(rec.predicted.at) < new Date(rec.kickoff), [rec.predicted.at, rec.kickoff]);

/* =============================================================================
   4. IT SURVIVES BEING STORED

   The record spends its life as JSON in a file or a document. Anything that
   does not survive that trip identically is not really in the schema.
   ========================================================================== */
console.log('');
console.log('=== round trip ===');
const trip = JSON.parse(JSON.stringify(rec));
ok('a record round-trips through JSON byte for byte',
  JSON.stringify(trip) === JSON.stringify(rec));
ok('and two freezes of the same fixture differ only in when they were made',
  JSON.stringify({ ...R.freeze(byId('702'), new Date(+T0 + 60000)).record, predicted: null }) ===
  JSON.stringify({ ...rec, predicted: null }));
ok('no undefined anywhere — it would vanish silently in JSON',
  !JSON.stringify(rec).includes('undefined') &&
  (function deep(o) {
    if (o === null) return true;
    if (Array.isArray(o)) return o.every(deep);
    if (typeof o === 'object') return Object.values(o).every(v => v !== undefined && deep(v));
    return o !== undefined;
  })(rec));

console.log('');
console.log('=== the day key ===');
ok('the day key is UTC, not local',
  R.dayKey('2026-08-23T23:30:00.000Z') === '2026-08-23',
  R.dayKey('2026-08-23T23:30:00.000Z'));
ok('a kickoff just after midnight UTC belongs to the next day',
  R.dayKey('2026-08-24T00:10:00.000Z') === '2026-08-24');
ok('an offset timestamp is converted, not truncated',
  R.dayKey('2026-08-24T00:30:00+02:00') === '2026-08-23',
  R.dayKey('2026-08-24T00:30:00+02:00'));
ok('an unreadable date gives null rather than a wrong day',
  R.dayKey('whenever') === null);

/* =============================================================================
   5. SCORING

   Hand-computed, because these are the numbers the site's whole credibility
   claim rests on. Log loss of a probability p assigned to what happened is
   -ln(p); the summed three-class Brier is the sum of squared errors over all
   three outcomes.
   ========================================================================== */
console.log('');
console.log('=== scoring, against numbers computed by hand ===');
const synthetic = (probs, opts = {}) => ({
  v: 1, id: 's', kickoff: '2026-08-23T12:00:00.000Z', league: 'eng.1',
  home: { id: 'h', name: 'H' }, away: { id: 'a', name: 'A' },
  predicted: {
    at: '2026-08-23T09:00:00.000Z',
    lambda: [1.5, 1.1], probs,
    pick: ['home', 'draw', 'away'][probs.indexOf(Math.max(...probs))],
    score: opts.score ?? [2, 1, 0.09],
    over25: opts.over25 ?? 0.55, btts: opts.btts ?? 0.52,
    conf: { level: 2, word: 'medium' }, seen: [10, 10],
  },
  market: opts.market ?? null,
  model: { rev: MODEL_REV, hash },
  result: null,
});

ok('an unplayed record scores as null, not as a loss',
  R.score(synthetic([0.5, 0.3, 0.2])) === null);

const half = R.attachResult(synthetic([0.5, 0.3, 0.2]), { home: 2, away: 0 }).record;
const vHalf = R.score(half);
console.log('    p=0.50 on the outcome → log loss ' + vHalf.logLoss.toFixed(6) +
            ' (ln 2 = ' + Math.LN2.toFixed(6) + '), brier ' + vHalf.brier.toFixed(4));
ok('log loss of a 0.50 call that came in is ln 2', near(vHalf.logLoss, Math.LN2), vHalf.logLoss);
ok('the summed three-class brier is 0.38 for [.5,.3,.2] with home winning',
  near(vHalf.brier, 0.38), vHalf.brier);
ok('a no-knowledge model scores ln 3 — the number to beat',
  near(R.NO_KNOWLEDGE.logLoss, Math.log(3)) && near(R.NO_KNOWLEDGE.brier, 2 / 3),
  R.NO_KNOWLEDGE);

ok('the outcome is read off the goals', vHalf.outcome === 'home', vHalf.outcome);
ok('a correct pick is a hit', vHalf.hit === true);
ok('the probability we gave the actual outcome is surfaced',
  near(vHalf.assigned, 0.5), vHalf.assigned);

const drew = R.attachResult(synthetic([0.5, 0.3, 0.2]), { home: 1, away: 1 }).record;
const vDrew = R.score(drew);
ok('a draw is recognised', vDrew.outcome === 'draw' && vDrew.hit === false);
ok('and a miss on our second choice is marked as such', vDrew.runnerUp === true);
const lost = R.score(R.attachResult(synthetic([0.5, 0.3, 0.2]), { home: 0, away: 3 }).record);
ok('a miss on our third choice is not', lost.runnerUp === false, lost);
ok('a hit is never also a runner-up', vHalf.runnerUp === false);

const exact = R.score(R.attachResult(synthetic([0.5, 0.3, 0.2], { score: [2, 1, 0.1] }),
  { home: 2, away: 1 }).record);
ok('the exact scoreline is checked in the right order',
  exact.exact === true && R.score(R.attachResult(
    synthetic([0.5, 0.3, 0.2], { score: [2, 1, 0.1] }), { home: 1, away: 2 }).record).exact === false);

console.log('');
console.log('=== the either-way calls ===');
const ou = (prob, h, a) => R.score(R.attachResult(
  synthetic([0.5, 0.3, 0.2], { over25: prob }), { home: h, away: a }).record).over25;
ok('over 2.5 called and hit', ou(0.6, 2, 1) === true);
ok('over 2.5 called and missed', ou(0.6, 1, 0) === false);
ok('under 2.5 called and hit', ou(0.4, 1, 0) === true);
ok('three goals is over, exactly', ou(0.6, 2, 1) === true && ou(0.6, 1, 1) === false);
ok('an exact 50/50 is not scored at all — it was never a call',
  ou(0.5, 3, 3) === null && ou(0.5, 0, 0) === null);

const bt = (prob, h, a) => R.score(R.attachResult(
  synthetic([0.5, 0.3, 0.2], { btts: prob }), { home: h, away: a }).record).btts;
ok('both teams to score, hit', bt(0.6, 1, 1) === true);
ok('a 0-0 is not both scoring', bt(0.6, 0, 0) === false);
ok('a 3-0 is not both scoring', bt(0.6, 3, 0) === false);
ok('no-BTTS called on a goalless draw is a hit', bt(0.3, 0, 0) === true);

console.log('');
console.log('=== an unusable result is refused ===');
for (const [label, goals] of [
  ['a missing score', {}], ['a negative score', { home: -1, away: 0 }],
  ['a fractional score', { home: 1.5, away: 0 }], ['a string score', { home: '2', away: '0' }],
]) {
  const out = R.attachResult(synthetic([0.5, 0.3, 0.2]), goals);
  ok('refuses ' + label, !out.record && !!out.skip, out);
}

/* =============================================================================
   6. THE MARKET COMPARISON

   Only meaningful on records where a price was frozen, and only informative
   where the two disagreed.
   ========================================================================== */
console.log('');
console.log('=== model against market, on one match ===');
const withMkt = R.attachResult(
  synthetic([0.5, 0.3, 0.2], { market: { provider: 'DraftKings', probs: [0.3, 0.3, 0.4], overround: 1.05 } }),
  { home: 2, away: 0 }).record;
const vm = R.score(withMkt);
console.log('    model gave the outcome ' + vm.assigned + ', market gave it ' + vm.market.assigned);
ok('the market is graded on the same outcome', vm.market.pick === 'away', vm.market.pick);
ok('and its own pick is judged separately', vm.market.hit === false);
ok('its log loss is computed from the price we froze',
  near(vm.market.logLoss, -Math.log(0.3)), vm.market.logLoss);
ok('a disagreement is flagged', vm.market.disagreed === true);
ok('and beating the market is only claimed on the actual figures',
  vm.market.beatMarket === true && vm.logLoss < vm.market.logLoss);
ok('an unpriced match reports no market verdict at all',
  R.score(half).market === null);

/* =============================================================================
   7. THE AGGREGATE
   ========================================================================== */
console.log('');
console.log('=== the summary the accuracy page will print ===');
/* Twelve matches with a known answer: home wins six, draws three, away wins
   three, and the model always says [0.5, 0.3, 0.2] — so the hit rate must be
   exactly 6/12, and the calibration bin holding 0.5 must observe 0.5.

   Half of them carry a price, and the priced half is split deliberately: some
   agree with the model and some pick away instead. An earlier version of this
   corpus had the market agreeing every time, which made the "who was right when
   they disagreed" assertion pass without ever exercising the code. A test that
   only passes because the situation never arose is not a test. */
const corpus = [];
const outcomes = [[2, 0], [1, 0], [3, 1], [2, 1], [4, 0], [1, 0],
                  [1, 1], [0, 0], [2, 2], [0, 1], [0, 2], [1, 3]];
const AGREES = [0.45, 0.30, 0.25];   /* picks home, as the model does */
const DIFFERS = [0.25, 0.30, 0.45];  /* picks away */
outcomes.forEach(([h, a], i) => {
  const s = synthetic([0.5, 0.3, 0.2], {
    market: i % 2 === 0
      ? { provider: 'DraftKings', probs: i % 4 === 0 ? DIFFERS : AGREES, overround: 1.04 }
      : null,
  });
  s.id = 'c' + i;
  corpus.push(R.attachResult(s, { home: h, away: a }).record);
});
corpus.push(synthetic([0.6, 0.25, 0.15]));   /* not played yet */

const sum = R.summarise(corpus);
console.log('    ' + sum.n + ' records, ' + sum.scored + ' scored, ' + sum.pending + ' pending');
console.log('    hit rate ' + (sum.hitRate * 100).toFixed(1) + '%, log loss ' +
            sum.logLoss.toFixed(4) + ' vs baseline ' + sum.baseline.logLoss.toFixed(4));
console.log('    market coverage ' + (sum.market.coverage * 100).toFixed(0) + '% of scored, ' +
            sum.market.disagreed + ' disagreements');
console.log('    calibration: ' + sum.calibration
  .map(b => b.from.toFixed(1) + '-' + b.to.toFixed(1) + ' n=' + b.n +
            ' pred ' + b.predicted.toFixed(2) + ' obs ' + b.observed.toFixed(2)).join(' | '));

ok('pending records are counted, not scored', sum.pending === 1 && sum.scored === 12, [sum.scored, sum.pending]);
ok('the hit rate is the six home wins out of twelve', near(sum.hitRate, 0.5), sum.hitRate);
ok('log loss is a mean over scored records only', sum.logLoss > 0 && sum.logLoss < 3, sum.logLoss);
ok('the no-knowledge baseline is reported alongside it',
  near(sum.baseline.logLoss, Math.log(3)), sum.baseline);

ok('calibration pools all three outcomes, not just our pick',
  sum.calibration.reduce((t, b) => t + b.n, 0) === 36,
  sum.calibration.reduce((t, b) => t + b.n, 0));
const bin5 = sum.calibration.find(b => b.from === 0.5);
ok('the 0.5 bin predicted 0.5 and observed 0.5, as constructed',
  near(bin5.predicted, 0.5) && near(bin5.observed, 0.5), bin5);
ok('every calibration bin reports its own size, so a tiny one can be labelled',
  sum.calibration.every(b => Number.isInteger(b.n) && b.n > 0));

ok('the market comparison runs only over records that had a price',
  sum.market.n === 6 && near(sum.market.coverage, 0.5), [sum.market.n, sum.market.coverage]);
ok('both sides of the comparison are measured on that same subset',
  sum.market.modelLogLoss > 0 && sum.market.marketLogLoss > 0,
  [sum.market.modelLogLoss, sum.market.marketLogLoss]);

/* Priced records are i = 0,2,4,6,8,10, with outcomes home, home, home, draw,
   draw, away. The model picks home every time, so 3 of 6. The market picks away
   on i = 0,4,8 (outcomes home, home, draw → 0 right) and home on i = 2,6,10
   (outcomes home, draw, away → 1 right), so 1 of 6. The three disagreements are
   i = 0,4,8, and the model was right on the first two. */
ok('the market is judged on its own picks, not the model\'s',
  near(sum.market.marketHitRate, 1 / 6) && near(sum.market.modelHitRate, 0.5),
  [sum.market.marketHitRate, sum.market.modelHitRate]);
ok('disagreements are counted', sum.market.disagreed === 3, sum.market.disagreed);
ok('and "who was right when they disagreed" uses only those three',
  near(sum.market.wonDisagreements, 2 / 3), sum.market.wonDisagreements);
ok('that figure is not just the overall hit rate wearing a different name',
  !near(sum.market.wonDisagreements, sum.market.modelHitRate),
  [sum.market.wonDisagreements, sum.market.modelHitRate]);
ok('with no disagreements at all it reports null rather than a made-up rate',
  R.summarise(corpus.filter((r, i) => i % 4 !== 0)).market.wonDisagreements === null,
  R.summarise(corpus.filter((r, i) => i % 4 !== 0)).market);

console.log('');
console.log('=== grouping by model revision ===');
const mixed = corpus.map((r, i) => (i < 4 ? { ...r, model: { rev: '0.9', hash: 'deadbeef' } } : r));
const all = R.summarise(mixed);
const only = R.summarise(mixed, { rev: MODEL_REV });
console.log('    revs present: ' + JSON.stringify(all.revs));
ok('every revision present is counted separately',
  all.revs['0.9'] === 4 && all.revs[MODEL_REV] === 9, all.revs);
ok('filtering to one revision narrows the population',
  only.n === 9 && only.rev === MODEL_REV, [only.n, only.rev]);
ok('two hashes under one revision is reported as inconsistent',
  all.revConsistent === false && only.revConsistent === true,
  [all.revConsistent, only.revConsistent]);
ok('an empty population summarises to nulls rather than NaN',
  (() => { const e = R.summarise([]); return e.n === 0 && e.hitRate === null && e.logLoss === null; })(),
  R.summarise([]));

console.log('');
console.log('=== breakdown by stated confidence ===');
console.log('    ' + sum.byConfidence.map(c => c.word + ' n=' + c.n).join(', '));
ok('every confidence tier appears, even at zero, so none can be quietly dropped',
  sum.byConfidence.length === MODEL.CONFIDENCE.length, sum.byConfidence.length);
ok('the tiers partition the scored records',
  sum.byConfidence.reduce((t, c) => t + c.n, 0) === sum.scored,
  sum.byConfidence.map(c => c.n));
ok('a tier with no records reports null rather than 0%',
  sum.byConfidence.every(c => (c.n === 0 ? c.hitRate === null : c.hitRate !== null)),
  sum.byConfidence);

/* =============================================================================
   8. JUDGEMENTS ARE DERIVED, NOT STORED

   The point of the whole schema. If a verdict were stored, fixing the scoring
   code would leave thousands of documents carrying the old answer.
   ========================================================================== */
console.log('');
console.log('=== nothing derived is stored ===');
const stored = JSON.stringify(rec);
for (const word of ['hit', 'correct', 'logLoss', 'brier', 'verdict', 'outcome', 'runnerUp', 'assigned']) {
  ok('the record does not store "' + word + '"', !stored.includes('"' + word + '"'), word);
}
ok('a record re-scored gives the same verdict every time',
  JSON.stringify(R.score(half)) === JSON.stringify(R.score(JSON.parse(JSON.stringify(half)))));
ok('and scoring never mutates the record it was given',
  (() => { const before = JSON.stringify(half); R.score(half); return JSON.stringify(half) === before; })());
ok('attaching a result does not mutate the original either',
  (() => { const r = synthetic([0.5, 0.3, 0.2]); const before = JSON.stringify(r);
           R.attachResult(r, { home: 1, away: 0 }); return JSON.stringify(r) === before; })());

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
