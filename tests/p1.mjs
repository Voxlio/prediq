/* =============================================================================
   p1.mjs — powerTable / leagueSummaries, the numbers behind ratings.html

   Split in two on purpose. Part A checks the arithmetic against a hand-built
   index where every rating is a number I chose, so the expected answer can be
   written down. Part B runs it on a fitted index, where the interesting
   question is not "is it exactly 1.00" but "does it behave".

   Part B is where the first draft of this file was wrong twice, and both
   mistakes were mine rather than the model's. They are recorded as assertions
   at the end, because both are properties worth keeping.
   ========================================================================== */

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const { MODEL, DOMESTIC } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* =============================================================================
   PART A — exact arithmetic on a hand-built index
   ========================================================================== */

/* powerTable reads only index.mean, index.teams and index.fits, so an index can
   be written by hand. That removes the fit from the picture entirely and leaves
   only the arithmetic under test. */
function mkIndex(globalMean, leagues) {
  const teams = new Map(), fits = new Map();
  for (const [slug, mean, list] of leagues) {
    const inLeague = new Map();
    for (const s of list) {
      const t = {
        id: s.id, name: s.name, short: s.name, leagueSlug: slug,
        matches: s.matches ?? 10, promoted: !!s.promoted,
        attack: s.a, defence: s.d,
        gAttack: s.ga ?? s.a, gDefence: s.gd ?? s.d,
      };
      teams.set(t.id, t);
      inLeague.set(t.id, t);
    }
    fits.set(slug, { slug, mean, teams: inLeague, matches: [], excluded: 0 });
  }
  return { mean: globalMean, teams, fits, venue: { home: 1.11, away: 0.89 } };
}

console.log('=== A. one exactly average team ===');
/* Three teams whose attack and defence both average to exactly 1.00, so the
   measured reference opponent is 1.00 and the middle team is average. */
const A = mkIndex(1.4, [['eng.1', 1.4, [
  { id: 'hi',  name: 'Strong', a: 1.30, d: 0.80 },
  { id: 'mid', name: 'Middle', a: 1.00, d: 1.00 },
  { id: 'lo',  name: 'Weak',   a: 0.70, d: 1.20 },
]]]);
const tabA = M.powerTable(A, 'league');
const mid = tabA.find(r => r.id === 'mid');

ok('the average side is rated against exactly the league mean',
   near(mid.xgFor, 1.4) && near(mid.xgAgainst, 1.4), [mid.xgFor, mid.xgAgainst]);
ok('so its goal difference is zero', near(mid.xgd, 0), mid.xgd);
ok('it wins exactly as often as it loses', near(mid.win, mid.loss, 1e-12), [mid.win, mid.loss]);

/* The identity a reader can check by hand: for a side rated exactly average,
   W = L, so 3W + D collapses to 1.5 - 0.5D. Which is also the actual average
   points per team per game in any 3-1-0 league with that draw rate — so this
   number is not an abstraction, it is the league's own points average. */
ok('xPoints is exactly 1.5 - 0.5*draw',
   near(mid.xPoints, 1.5 - 0.5 * mid.drawP, 1e-12), [mid.xPoints, 1.5 - 0.5 * mid.drawP]);
ok('which puts an average side below 1.5 points, always',
   mid.xPoints < 1.5, mid.xPoints);

/* And independently: the same grid, computed straight from matrix/outcomes. */
const gridA = M.outcomes(M.matrix(1.4, 1.4));
ok('every figure matches the grid computed independently',
   near(mid.win, gridA.home, 1e-12) && near(mid.drawP, gridA.draw, 1e-12) &&
   near(mid.loss, gridA.away, 1e-12) && near(mid.xPoints, 3 * gridA.home + gridA.draw, 1e-12),
   [mid.win, gridA.home]);
console.log(`    average side: W ${(mid.win*100).toFixed(1)}%  D ${(mid.drawP*100).toFixed(1)}%  L ${(mid.loss*100).toFixed(1)}%  =  ${mid.xPoints.toFixed(3)} pts`);

console.log('\n=== A. a strong and a weak side ===');
const hi = tabA.find(r => r.id === 'hi'), lo = tabA.find(r => r.id === 'lo');
ok('lambdas are mean x rating x reference, exactly',
   near(hi.xgFor, 1.4 * 1.30 * 1.0) && near(hi.xgAgainst, 1.4 * 1.0 * 0.80),
   [hi.xgFor, hi.xgAgainst]);
ok('the strong side is ordered first', tabA[0].id === 'hi', tabA.map(r => r.id));
ok('the weak side is ordered last', tabA[2].id === 'lo', tabA.map(r => r.id));
ok('strong > average > weak on xPoints',
   hi.xPoints > mid.xPoints && mid.xPoints > lo.xPoints, tabA.map(r => +r.xPoints.toFixed(3)));
ok('xgd equals xgFor - xgAgainst on every row',
   tabA.every(r => near(r.xgd, r.xgFor - r.xgAgainst)), tabA.map(r => r.xgd));
ok('W+D+L sums to 1 on every row',
   tabA.every(r => near(r.win + r.drawP + r.loss, 1, 1e-9)), tabA.map(r => r.win + r.drawP + r.loss));
ok('xPoints stays inside 0..3 on every row',
   tabA.every(r => r.xPoints >= 0 && r.xPoints <= 3), tabA.map(r => r.xPoints));
ok('the likeliest scoreline comes through', hi.score && hi.score.prob > 0, hi.score);
console.log('    ' + tabA.map(r => `${r.name} ${r.xgFor.toFixed(2)}-${r.xgAgainst.toFixed(2)} ${r.xPoints.toFixed(2)}pts`).join('  |  '));

console.log('\n=== A. the reference opponent is measured, not assumed ===');
/* A league whose ratings do NOT average to 1.00 — which is what a half-loaded
   league looks like. Assuming 1.00 would rate everyone against a side that is
   not in the data. */
const B = mkIndex(1.4, [['eng.1', 1.4, [
  { id: 'x', name: 'X', a: 1.40, d: 0.60 },
  { id: 'y', name: 'Y', a: 1.20, d: 0.80 },
]]]);
const tabB = M.powerTable(B, 'league');
const refA = (1.40 + 1.20) / 2, refD = (0.60 + 0.80) / 2;
ok('the average of what is actually present is used',
   near(tabB[0].xgFor, 1.4 * 1.40 * refD) && near(tabB[0].xgAgainst, 1.4 * refA * 0.60),
   [tabB[0].xgFor, 1.4 * 1.40 * refD]);
ok('two above-average sides do not both look world-beating',
   tabB.every(r => r.xPoints < 2.4), tabB.map(r => +r.xPoints.toFixed(2)));
console.log(`    reference opponent measured at ${refA.toFixed(2)} attack / ${refD.toFixed(2)} defence`);

console.log('\n=== A. each league keeps its own scale ===');
const C = mkIndex(1.5, [
  ['eng.1', 1.0, [{ id: 'p', name: 'Poor scorers', a: 1.00, d: 1.00 }]],
  ['esp.1', 3.0, [{ id: 'q', name: 'Free scorers', a: 1.00, d: 1.00 }]],
]);
const tabC = M.powerTable(C, 'league');
const p = tabC.find(r => r.id === 'p'), q = tabC.find(r => r.id === 'q');
ok('a 1.00 side is rated at its own league mean, not the global one',
   near(p.xgFor, 1.0) && near(q.xgFor, 3.0), [p.xgFor, q.xgFor]);
ok('both are average, so both sit below 1.5 pts',
   p.xPoints < 1.5 && q.xPoints < 1.5, [p.xPoints, q.xPoints]);
ok('the free-scoring league draws less often', q.drawP < p.drawP, [q.drawP, p.drawP]);
ok('so its average side is worth more points — the scales are NOT comparable',
   q.xPoints > p.xPoints, [q.xPoints, p.xPoints]);
console.log(`    1.00 goals a game: ${p.xPoints.toFixed(3)} pts | 3.00 goals a game: ${q.xPoints.toFixed(3)} pts`);

console.log('\n=== A. global scope uses the adjusted ratings ===');
const D = mkIndex(1.4, [
  ['eng.1', 1.4, [{ id: 'e', name: 'English', a: 1.00, d: 1.00, ga: 1.00, gd: 1.00 }]],
  ['fra.1', 1.4, [{ id: 'f', name: 'French',  a: 1.00, d: 1.00, ga: 0.92, gd: 1.09 }]],
]);
const glD = M.powerTable(D, 'global');
ok('global scope reads gAttack / gDefence',
   near(glD.find(r => r.id === 'f').attack, 0.92), glD.find(r => r.id === 'f').attack);
ok('league scope reads the unadjusted attack',
   near(M.powerTable(D, 'league').find(r => r.id === 'f').attack, 1.00),
   M.powerTable(D, 'league').find(r => r.id === 'f').attack);
ok('the two are identical within a league and only differ across one',
   glD[0].id === 'e' && glD[1].id === 'f', glD.map(r => r.id));
ok('scope is recorded on every row',
   glD.every(r => r.scope === 'global') && tabA.every(r => r.scope === 'league'), glD[0].scope);

console.log('\n=== A. sorting ===');
const E = mkIndex(1.4, [['eng.1', 1.4, [
  { id: 'z', name: 'Zebra', a: 1.00, d: 1.00 },
  { id: 'a', name: 'Aardvark', a: 1.00, d: 1.00 },
  { id: 'm', name: 'Marmot', a: 1.00, d: 1.00 },
]]]);
ok('exact ties break on name, so the order cannot depend on Map insertion',
   M.powerTable(E, 'league').map(r => r.id).join() === 'a,m,z',
   M.powerTable(E, 'league').map(r => r.id));

console.log('\n=== A. nothing to rate ===');
const empty = mkIndex(1.4, []);
ok('an empty index returns no rows rather than throwing',
   M.powerTable(empty, 'league').length === 0 && M.powerTable(empty, 'global').length === 0, 0);
const zero = mkIndex(1.4, [['eng.1', 1.4, []]]);
ok('a league with no teams returns no rows', M.powerTable(zero, 'league').length === 0, 0);
ok('and does not divide by zero', M.powerTable(zero, 'league').every(r => Number.isFinite(r.xPoints)), true);

/* =============================================================================
   PART B — on a real fit
   ========================================================================== */

console.log('\n=== B. a fitted league of identical records ===');
/* Full double round robin, every match 1-1, so all ten teams have exactly the
   same record and the same number of home and away games. */
const flatTeams = Array.from({ length: 10 }, (_, i) => ({
  id: 'F' + i, name: 'Flat ' + i, short: 'F' + i, gp: 18, gf: 18, ga: 18, rank: i + 1,
}));
function roundRobin(ids, goals, prefix) {
  const out = [];
  let d = 0;
  for (const h of ids) for (const a of ids) {
    if (h === a) continue;
    const day = new Date(Date.UTC(2025, 8, 1) + (d++) * 6 * 3600e3);
    out.push({ date: day.toISOString(), home: { id: h, name: '', g: goals }, away: { id: a, name: '', g: goals } });
  }
  return out;
}
const flatResults = roundRobin(flatTeams.map(t => t.id), 1);
const richTeams = Array.from({ length: 10 }, (_, i) => ({
  id: 'R' + i, name: 'Rich ' + i, short: 'R' + i, gp: 18, gf: 36, ga: 36, rank: i + 1,
}));
const richResults = roundRobin(richTeams.map(t => t.id), 2);

const blank = { standingsNow: [], standingsPrev: [], results: [] };
const twoLeagues = {
  season: 2025, prevSeason: 2024, fixtures: [], errors: [],
  byLeague: {
    'eng.1': { standingsNow: flatTeams, standingsPrev: flatTeams, results: flatResults },
    'esp.1': { standingsNow: richTeams, standingsPrev: richTeams, results: richResults },
    'ita.1': { ...blank }, 'ger.1': { ...blank }, 'fra.1': { ...blank },
    'uefa.champions': { ...blank },
  },
};
const idx = M.buildIndex(twoLeagues);
const lg = M.powerTable(idx, 'league');
const flats = lg.filter(r => r.leagueSlug === 'eng.1');

ok('every team in the index gets a row', lg.length === 20, lg.length);
ok('the flat league mean is 1.00 goals a side', near(idx.fits.get('eng.1').mean, 1), idx.fits.get('eng.1').mean);
ok('the rich league mean is 2.00', near(idx.fits.get('esp.1').mean, 2), idx.fits.get('esp.1').mean);

/* Identical records land within a hair of 1.00 but not exactly on it, and the
   reason is real: see the venue-sequence check below. */
const spread = Math.max(...flats.map(r => Math.abs(r.attack - 1)));
ok('identical records rate within 1.5% of 1.00', spread < 0.015, spread);
const meanAtt = flats.reduce((s, r) => s + r.attack, 0) / flats.length;
ok('and their mean is 1.00 to three decimals', near(meanAtt, 1, 5e-4), meanAtt);
ok('every one of them lands in the 1.2-1.5 pts band an average side occupies',
   flats.every(r => r.xPoints > 1.2 && r.xPoints < 1.5), flats.map(r => +r.xPoints.toFixed(3)));
console.log(`    ten identical records: ${flats.map(r => r.xPoints.toFixed(3)).join(' ')}`);

console.log('\n=== B. why identical records are not identical ratings ===');
/* This is the finding that broke two drafts of this file. The recency weight
   halves every RECENCY_HALFLIFE matches, so WHEN a match was played changes how
   much it counts — and a match played away is worth more than the same result
   at home. A side whose recent games were away therefore rates above one whose
   recent games were at home, on the same goals. That is the model working, not
   a bug, and it is the reason the ratings page shows matches played beside
   every rating. */
const seq = (id, pattern) => {
  /* pattern is a string of H and A: one 1-1 draw per character, in order. */
  const out = [];
  pattern.split('').forEach((venue, i) => {
    const opp = 'O' + i;
    const day = new Date(Date.UTC(2025, 8, 1) + i * 864e5).toISOString();
    out.push(venue === 'H'
      ? { date: day, home: { id, name: '', g: 1 }, away: { id: opp, name: '', g: 1 } }
      : { date: day, home: { id: opp, name: '', g: 1 }, away: { id, name: '', g: 1 } });
  });
  return out;
};
const HOME_LAST = 'AAAAAAAAHHHHHHHH', AWAY_LAST = 'HHHHHHHHAAAAAAAA';
const opps = Array.from({ length: 16 }, (_, i) => ({ id: 'O' + i, name: 'Opp ' + i, short: 'O' + i, gp: 16, gf: 16, ga: 16, rank: i + 3 }));
const vTeams = [
  { id: 'homeLast', name: 'Recent games at home', short: 'HL', gp: 16, gf: 16, ga: 16, rank: 1 },
  { id: 'awayLast', name: 'Recent games away',    short: 'AL', gp: 16, gf: 16, ga: 16, rank: 2 },
  ...opps,
];
const vIdx = M.buildIndex({
  season: 2025, prevSeason: 2024, fixtures: [], errors: [],
  byLeague: {
    'eng.1': { standingsNow: vTeams, standingsPrev: vTeams,
               results: [...seq('homeLast', HOME_LAST), ...seq('awayLast', AWAY_LAST)] },
    'esp.1': { ...blank }, 'ita.1': { ...blank }, 'ger.1': { ...blank },
    'fra.1': { ...blank }, 'uefa.champions': { ...blank },
  },
});
const vTab = M.powerTable(vIdx, 'league');
const hl = vTab.find(r => r.id === 'homeLast'), al = vTab.find(r => r.id === 'awayLast');
ok('both sides have the same record', hl.matches === al.matches, [hl.matches, al.matches]);
ok('the side whose recent games were away rates higher on identical goals',
   al.xPoints > hl.xPoints, [al.xPoints, hl.xPoints]);
ok('and the gap is small enough to be a nuance, not a distortion',
   al.xPoints - hl.xPoints < 0.2, al.xPoints - hl.xPoints);
console.log(`    recent games away ${al.xPoints.toFixed(3)} pts vs recent games at home ${hl.xPoints.toFixed(3)} pts`);

console.log('\n=== B. a dominant side and a beaten one ===');
const beat = (m, w, l, g) =>
    m.home.id === w ? { ...m, home: { ...m.home, g }, away: { ...m.away, g: 0 } }
  : m.away.id === w ? { ...m, home: { ...m.home, g: 0 }, away: { ...m.away, g } }
  : m.home.id === l ? { ...m, home: { ...m.home, g: 0 }, away: { ...m.away, g } }
  : m.away.id === l ? { ...m, home: { ...m.home, g }, away: { ...m.away, g: 0 } }
  : m;
const skewed = {
  ...twoLeagues,
  byLeague: { ...twoLeagues.byLeague,
    'eng.1': { standingsNow: flatTeams, standingsPrev: flatTeams,
               results: flatResults.map(m => beat(m, 'F0', 'F1', 4)) } },
};
const sTab = M.powerTable(M.buildIndex(skewed), 'league').filter(r => r.leagueSlug === 'eng.1');
ok('the unbeaten side tops its league', sTab[0].id === 'F0', sTab[0].id);
ok('its attack is above 1.00', sTab[0].attack > 1, sTab[0].attack);
ok('its defence is below 1.00 — lower is better', sTab[0].defence < 1, sTab[0].defence);
ok('and it earns well above the average band', sTab[0].xPoints > 2, sTab[0].xPoints);
ok('the beaten side finishes bottom', sTab[sTab.length - 1].id === 'F1', sTab[sTab.length - 1].id);
ok('and well below it', sTab[sTab.length - 1].xPoints < 1, sTab[sTab.length - 1].xPoints);
ok('nothing escapes 0..3 points', sTab.every(r => r.xPoints >= 0 && r.xPoints <= 3), sTab.map(r => r.xPoints));
ok('rows come back strongest first',
   sTab.every((r, i) => i === 0 || sTab[i - 1].xPoints >= r.xPoints), sTab.map(r => +r.xPoints.toFixed(2)));
console.log('    ' + sTab.map(r => `${r.id} ${r.xPoints.toFixed(2)}`).join('  '));

console.log('\n=== B. global scope across two fitted leagues ===');
const gl = M.powerTable(idx, 'global');
ok('same rows, different scale', gl.length === lg.length, gl.length);
ok('the global table is sorted', gl.every((r, i) => i === 0 || gl[i - 1].xPoints >= r.xPoints), true);
/* The identity from the method page: within one league q and s cancel, so the
   ORDER inside a league must be identical under both scopes. */
const order = (t, s) => t.filter(r => r.leagueSlug === s).map(r => r.id).join(',');
ok('within eng.1 the global order equals the league order',
   order(gl, 'eng.1') === order(lg, 'eng.1'), [order(gl, 'eng.1'), order(lg, 'eng.1')]);
ok('within esp.1 too', order(gl, 'esp.1') === order(lg, 'esp.1'), [order(gl, 'esp.1'), order(lg, 'esp.1')]);
/* eng.1 quality 1.00 beats esp.1 quality 0.98 on records this similar. */
ok('the higher-quality league ranks above the lower on comparable records',
   gl.find(r => r.leagueSlug === 'eng.1').xPoints > gl.find(r => r.leagueSlug === 'esp.1').xPoints,
   [gl.find(r => r.leagueSlug === 'eng.1').xPoints, gl.find(r => r.leagueSlug === 'esp.1').xPoints]);

console.log('\n=== B. league summaries ===');
const sums = M.leagueSummaries(idx);
ok('only leagues that loaded are summarised', sums.length === 2, sums.map(s => s.slug));
ok('and in config order', sums.map(s => s.slug).join() === 'eng.1,esp.1', sums.map(s => s.slug));
ok('team counts are right', sums.every(s => s.teams === 10), sums.map(s => s.teams));
ok('match counts are right', sums.every(s => s.matches === 90), sums.map(s => s.matches));
ok('means are carried through', near(sums[0].mean, 1) && near(sums[1].mean, 2), sums.map(s => s.mean));
ok('quality comes from config, not a copy',
   sums[0].quality === DOMESTIC[0].quality && sums[1].quality === DOMESTIC[1].quality, sums.map(s => s.quality));
ok('names and abbreviations come from config',
   sums[0].name === DOMESTIC[0].name && sums[0].abbr === DOMESTIC[0].abbr, [sums[0].name, sums[0].abbr]);
ok('a clean feed excludes nothing', sums.every(s => s.excluded === 0), sums.map(s => s.excluded));
ok('every summarised league has rows in the table',
   sums.every(s => lg.some(r => r.leagueSlug === s.slug)), true);
ok('and every row belongs to a summarised league',
   lg.every(r => sums.some(s => s.slug === r.leagueSlug)), true);

const emptyIdx = M.buildIndex({ season: 2025, prevSeason: 2024, fixtures: [], errors: [],
  byLeague: Object.fromEntries(['eng.1','esp.1','ita.1','ger.1','fra.1','uefa.champions'].map(s => [s, { ...blank }])) });
ok('an all-failed load summarises nothing rather than showing empty tables',
   M.leagueSummaries(emptyIdx).length === 0, 0);

console.log(fails ? `\n${fails} FAILED` : '\nALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
