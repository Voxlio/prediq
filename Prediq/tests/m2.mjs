/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const { MODEL, LEAGUES } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };
const near = (a, b, eps) => Math.abs(a - b) < eps;
const f2 = n => (+n).toFixed(3);

/* Real 2024-25 Premier League goals for / against, used as last season. */
const PREV = [
  ['1','Liverpool',86,41], ['2','Arsenal',69,34], ['3','Man City',72,44], ['4','Chelsea',64,43],
  ['5','Newcastle',68,47], ['6','Aston Villa',58,51], ['7','Nottm Forest',58,46], ['8','Brighton',66,59],
  ['9','Bournemouth',58,46], ['10','Brentford',66,57], ['11','Fulham',54,54], ['12','Crystal Palace',51,51],
  ['13','Everton',42,44], ['14','West Ham',46,62], ['15','Man United',44,54], ['16','Wolves',54,69],
  ['17','Tottenham',64,65], ['18','Leicester',33,80], ['19','Ipswich',36,82], ['20','Southampton',26,86],
].map(([id, name, gf, ga]) => ({ id, name, short: name, gp: 38, gf, ga, rank: +id }));

/* This season: the 17 who stayed, plus 3 promoted sides with no prior record. */
const NOW = PREV.slice(0, 17).map(t => ({ ...t, gp: 0, gf: 0, ga: 0 }))
  .concat([['21','Leeds'], ['22','Burnley'], ['23','Sunderland']]
    .map(([id, name]) => ({ id, name, short: name, gp: 0, gf: 0, ga: 0, rank: null })));

const R = (h, a, hg, ag, date) => ({ date, home: { id: h, name: '', g: hg }, away: { id: a, name: '', g: ag } });
const RESULTS = [
  R('2','12',3,0,'2026-08-15'), R('1','21',2,1,'2026-08-15'), R('4','22',1,1,'2026-08-16'),
  R('3','23',4,0,'2026-08-16'), R('5','13',2,2,'2026-08-16'), R('15','8',0,2,'2026-08-17'),
  /* a cup fixture against a team outside the division — must be discarded */
  R('2','999',3,0,'2026-08-21'),
];

const bucket = { standingsNow: NOW, standingsPrev: PREV, results: RESULTS };
const data = { season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: Date.now(),
  fixtures: [], byLeague: { 'eng.1': bucket } };
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) data.byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };

console.log('=== cup-match filter ===');
const venue = { home: MODEL.HOME_ADVANTAGE, away: MODEL.AWAY_PENALTY };
const fit = M.fitLeague(bucket, LEAGUES[0], venue);
ok('7 results in, 6 kept', fit.matches.length === 6, fit.matches.length);
ok('1 excluded, reported',  fit.excluded === 1, fit.excluded);
ok('team 999 never indexed', !fit.teams.has('999'));
ok('Arsenal counted 1 match not 2', fit.teams.get('2').matches === 1, fit.teams.get('2').matches);
console.log('    league mean goals per team per game: ' + f2(fit.mean));
ok('mean is realistic (1.2-1.7)', fit.mean > 1.2 && fit.mean < 1.7, fit.mean);

console.log('=== the fit ===');
const attacks = [...fit.teams.values()].map(t => t.attack);
const defs = [...fit.teams.values()].map(t => t.defence);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('    mean attack ' + f2(avg(attacks)) + '   mean defence ' + f2(avg(defs)));
ok('mean attack near 1.0',  near(avg(attacks), 1, 0.12), avg(attacks));
ok('mean defence near 1.0', near(avg(defs), 1, 0.12), avg(defs));
ok('all within clamps', attacks.every(a => a >= MODEL.MIN_STRENGTH && a <= MODEL.MAX_STRENGTH));

const T = id => fit.teams.get(id);
console.log('    Liverpool   a=' + f2(T('1').attack) + ' d=' + f2(T('1').defence));
console.log('    Fulham      a=' + f2(T('11').attack) + ' d=' + f2(T('11').defence) + '   (mid-table last season)');
console.log('    Everton     a=' + f2(T('13').attack) + ' d=' + f2(T('13').defence) + '   (weakest attack still up)');
console.log('    Wolves      a=' + f2(T('16').attack) + ' d=' + f2(T('16').defence) + '   (leakiest defence still up)');
console.log('    Leeds       a=' + f2(T('21').attack) + ' d=' + f2(T('21').defence) + '   (promoted)');
ok('strong attack > weak attack', T('1').attack > T('13').attack);
ok('strong defence < weak defence', T('2').defence < T('16').defence);
ok('mid-table sits near 1.0', near(T('11').attack, 1, 0.2) && near(T('11').defence, 1, 0.2), [T('11').attack, T('11').defence]);
ok('promoted flagged', T('21').promoted && T('22').promoted && !T('1').promoted);
ok('promoted uses config defaults', near(T('22').priorAttack, MODEL.PROMOTED_ATTACK, 1e-12));

/* convergence: more passes must not move the answer */
const saved = MODEL.ITERATIONS;
MODEL.ITERATIONS = 40;
const deep = M.fitLeague(bucket, LEAGUES[0], venue);
MODEL.ITERATIONS = saved;
const drift = Math.max(...[...fit.teams.keys()].map(id =>
  Math.abs(fit.teams.get(id).attack - deep.teams.get(id).attack)));
console.log('    largest drift, 5 passes vs 40: ' + drift.toExponential(2));
ok('converged by 5 passes', drift < 5e-4, drift);

console.log('=== cross-league index: q must cancel within a league ===');
const idx = M.buildIndex(data);
/* Compare inside ONE index: buildIndex measures home advantage from the pooled
   matches, so a standalone fitLeague with the config default is a different fit. */
const inner = idx.fits.get('eng.1');
const H = idx.teams.get('1'), A = idx.teams.get('16');
const viaGlobal  = idx.mean   * H.gAttack * A.gDefence;
const viaLeague  = inner.mean * inner.teams.get('1').attack * inner.teams.get('16').defence;
console.log('    global path ' + f2(viaGlobal) + '   single-league path ' + f2(viaLeague));
ok('identical to 1e-9', near(viaGlobal, viaLeague, 1e-9), [viaGlobal, viaLeague]);

console.log('=== end to end ===');
const fx = (id, h, a, hn, an, slug, odds) => ({ id, leagueSlug: slug, date: '2026-08-29T14:00Z', venue: null,
  home: { id: h, name: hn, short: hn, form: null }, away: { id: a, name: an, short: an, form: null }, odds });
data.fixtures = [
  fx('f1', '1', '16', 'Liverpool', 'Wolves', 'eng.1', null),
  fx('f2', '11', '12', 'Fulham', 'Crystal Palace', 'eng.1',
     { home: 0.40, draw: 0.28, away: 0.32, overround: 1.05, overUnder: 2.5, provider: 'DraftKings' }),
  fx('f3', '21', '2', 'Leeds', 'Arsenal', 'eng.1', null),
  fx('f4', '2', '777', 'Arsenal', 'Ajax', 'uefa.champions', null),
];
const { predictions } = M.predictAll(data);
console.log('    home advantage in use: ' + f2(idx.venue.home) + '/' + f2(idx.venue.away) +
            ' (measured=' + idx.venue.measured + ', ' + idx.venue.matches + ' matches)');

let sane = true;
for (const p of predictions) {
  if (!p.ok) { console.log('\n    ' + p.fixture.home.name + ' v ' + p.fixture.away.name + '  ->  NO PREDICTION');
               console.log('      "' + p.reason + '"'); continue; }
  console.log('\n    ' + p.home.name + ' v ' + p.away.name +
    '   xG ' + f2(p.lambda.home) + '-' + f2(p.lambda.away) +
    '   ' + p.pct.home + '/' + p.pct.draw + '/' + p.pct.away +
    '   pick=' + p.probs.pick + '  conf=' + p.conf.word + '(' + p.conf.level + ')' +
    '   score ' + p.score.home + '-' + p.score.away +
    '   o2.5 ' + Math.round(p.over25 * 100) + '%  btts ' + Math.round(p.btts * 100) + '%');
  p.insights.forEach(s => console.log('        - ' + s));
  if (p.pct.home + p.pct.draw + p.pct.away !== 100) sane = false;
  if (!(p.lambda.home > 0.2 && p.lambda.home < 5)) sane = false;
  if (p.insights.length === 0 || p.insights.length > MODEL.INSIGHT_MAX) sane = false;
}
console.log('');
ok('all displayed percentages sum to 100', sane);
ok('Ajax fixture refused, not guessed', predictions.find(p => p.fixture.id === 'f4').ok === false);
ok('refusal names the team', /Ajax/.test(predictions.find(p => p.fixture.id === 'f4').reason));
const lp = predictions.find(p => p.fixture.id === 'f1');
ok('Liverpool favoured over Wolves', lp.probs.pick === 'home' && lp.pct.home > 55, lp.pct);
ok('confidence capped in August', lp.conf.level <= 2 && lp.conf.capped, lp.conf);
const leeds = predictions.find(p => p.fixture.id === 'f3');
/* Insights carry *emphasis* markers for the renderer. Assert on the prose with
   them stripped, so the wording is tested and the markup is not. */
const prose = p => p.insights.map(s => s.replace(/\*/g, ''));
ok('grammar: singular match', prose(leeds).some(s => /Just one league match this season sits/.test(s)) || Math.min(leeds.teams.home.matches, leeds.teams.away.matches) !== 1, prose(leeds));
ok('promoted note appears', prose(leeds).some(s => /no record in this division/.test(s)), prose(leeds));
ok('every emphasis marker is balanced',
   predictions.filter(p => p.ok).every(p => p.insights.every(s => (s.match(/\*/g) || []).length % 2 === 0)),
   predictions.filter(p => p.ok).flatMap(p => p.insights).filter(s => (s.match(/\*/g) || []).length % 2));
const ful = predictions.find(p => p.fixture.id === 'f2');
ok('market comparison stored', ful.market && ful.market.provider === 'DraftKings');

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
