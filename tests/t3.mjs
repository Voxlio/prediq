/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const { americanToProb, parseOdds, parseResults, parseStandings } = await import(base + 'api.js');

let fails = 0;
const ok = (label, cond, got) => {
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (cond ? '' : '   got: ' + JSON.stringify(got)));
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('--- americanToProb ---');
ok('+400 -> 0.20',        near(americanToProb(400), 0.20), americanToProb(400));
ok('-150 -> 0.60',        near(americanToProb(-150), 0.60), americanToProb(-150));
ok('+250 -> 0.285714',    near(americanToProb(250), 100/350), americanToProb(250));
ok('-110 -> 0.523810',    near(americanToProb(-110), 110/210), americanToProb(-110));
ok('string "400" works',  near(americanToProb('400'), 0.20), americanToProb('400'));
ok('0 -> null',           americanToProb(0) === null, americanToProb(0));
ok('undefined -> null',   americanToProb(undefined) === null, americanToProb(undefined));

console.log('--- parseOdds (realistic Hull v Man Utd lines) ---');
const comp = { odds: [{ overUnder: 2.5, provider: { displayName: 'DraftKings' },
  homeTeamOdds: { moneyLine: 260 }, drawOdds: { moneyLine: 400 }, awayTeamOdds: { moneyLine: -125 } }] };
const o = parseOdds(comp);
console.log('   ', JSON.stringify(o, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));
ok('sums to exactly 1',   near(o.home + o.draw + o.away, 1), o.home + o.draw + o.away);
ok('away is favourite',   o.away > o.home && o.away > o.draw);
ok('overround > 1',       o.overround > 1, o.overround);
ok('overround plausible', o.overround > 1.005 && o.overround < 1.15, o.overround);
ok('overUnder kept',      o.overUnder === 2.5);
ok('provider kept',       o.provider === 'DraftKings');
ok('no odds -> null',     parseOdds({}) === null);
ok('partial -> null',     parseOdds({ odds: [{ homeTeamOdds: { moneyLine: 100 } }] }) === null);

console.log('--- parseResults: state filtering ---');
const mk = (state, hg, ag, hn, an) => ({ id: '1', date: '2026-08-21T14:00Z',
  status: { type: { state } }, competitions: [{ competitors: [
    { homeAway: 'home', score: hg, team: { id: '359', displayName: hn } },
    { homeAway: 'away', score: ag, team: { id: '999', displayName: an } }] }] });
const res = parseResults({ events: [
  mk('post', '3', '0', 'Arsenal', 'Coventry City'),
  mk('pre',  '0', '0', 'Everton', 'Crystal Palace'),
  mk('in',   '1', '1', 'Fulham',  'Spurs'),
  mk('post', undefined, undefined, 'Broken', 'Match')] });
ok('only completed kept',        res.length === 1, res.length);
ok('goals parsed as numbers',    res[0].home.g === 3 && res[0].away.g === 0, res[0]);
ok('names kept for cup filter',  res[0].away.name === 'Coventry City');

console.log('--- parseStandings: pointsFor/Against are GOALS ---');
const std = parseStandings({ standings: { entries: [
  { team: { id: '359', displayName: 'Arsenal' }, stats: [
    { name: 'gamesPlayed', value: 38 }, { name: 'pointsFor', value: 71 },
    { name: 'pointsAgainst', value: 27 }, { name: 'rank', value: 1 }] },
  { team: { id: '306', displayName: 'Hull City' }, stats: [
    { name: 'gamesPlayed', value: 0 }] }] } });
ok('two entries',                std.length === 2, std.length);
ok('GF=71 GA=27 GP=38',          std[0].gf === 71 && std[0].ga === 27 && std[0].gp === 38, std[0]);
ok('missing stats -> 0 not NaN', std[1].gf === 0 && std[1].ga === 0, std[1]);

console.log('--- parseStandings: grouped shape (children) ---');
const grouped = parseStandings({ children: [
  { standings: { entries: [{ team: { id: '1', displayName: 'A' }, stats: [{ name: 'pointsFor', value: 5 }] }] } },
  { standings: { entries: [{ team: { id: '2', displayName: 'B' }, stats: [{ name: 'pointsFor', value: 8 }] }] } }] });
ok('flattens groups', grouped.length === 2, grouped.length);

console.log(fails ? fails + ' FAILURE(S)' : 'ALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
