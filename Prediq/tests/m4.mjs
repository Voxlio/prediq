/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const { LEAGUES, DOMESTIC } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };

const team = (id, name, gf, ga) => ({ id, name, short: name, gp: 38, gf, ga, rank: null });
const PL = [team('1','Arsenal',69,34), team('2','Chelsea',64,43), team('3','Fulham',54,54),
            team('4','Everton',42,44), team('5','Wolves',54,69), team('6','Brentford',66,57),
            team('7','Brighton',66,59), team('8','Newcastle',68,47), team('9','Spurs',64,65),
            team('10','Palace',51,51)];
const fx = (h, a, hn, an, slug) => ({ id: h + a, leagueSlug: slug, date: '2026-08-29T14:00Z', venue: null,
  home: { id: h, name: hn, short: hn, form: null }, away: { id: a, name: an, short: an, form: null }, odds: null });

function build(engLoaded, espLoaded) {
  const byLeague = {};
  for (const lg of LEAGUES) byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
  if (engLoaded) byLeague['eng.1'] = { standingsNow: PL, standingsPrev: PL, results: [] };
  if (espLoaded) byLeague['esp.1'] = { standingsNow: PL.map(t => ({ ...t, id: 'e' + t.id })),
                                      standingsPrev: PL.map(t => ({ ...t, id: 'e' + t.id })), results: [] };
  return { season: 2026, prevSeason: 2025, months: [], errors: [], byLeague, fixtures: [] };
}
const reason = (d, fixture) => { d.fixtures = [fixture]; return M.predictAll(d).predictions[0]; };

console.log('=== the four reasons a prediction can be absent ===');
console.log('    (each must state its OWN cause — never borrow another’s)');

/* A: nothing loaded at all. The teams are innocent; the network is not. */
let p = reason(build(false, false), fx('1', '2', 'Arsenal', 'Chelsea', 'eng.1'));
console.log('    A  ' + p.reason);
ok('total failure -> blames loading, not the teams',
   /could not load/.test(p.reason) && !/outside/.test(p.reason) && !/does not appear/.test(p.reason), p.reason);

/* B: some league loaded, but not this fixture's. Name the one that failed. */
p = reason(build(false, true), fx('1', '2', 'Arsenal', 'Chelsea', 'eng.1'));
console.log('    B  ' + p.reason);
ok('one league down -> names that league',
   /Premier League data did not load/.test(p.reason) && !/outside/.test(p.reason), p.reason);

/* C: the league loaded, but its table has no row for this side. The team is
      INSIDE our coverage — saying otherwise would be false. */
p = reason(build(true, true), fx('1', '777', 'Arsenal', 'Sunderland', 'eng.1'));
console.log('    C  ' + p.reason);
ok('missing from a table we did read -> does not claim it is untracked',
   /does not appear in the current Premier League table/.test(p.reason) && !/outside/.test(p.reason), p.reason);
ok('C names only the absent side', /^Sunderland/.test(p.reason) && !/Arsenal/.test(p.reason), p.reason);

/* D: a cup tie against a division we genuinely do not follow. */
p = reason(build(true, true), fx('1', '777', 'Arsenal', 'Ajax', 'uefa.champions'));
console.log('    D  ' + p.reason);
ok('untracked team -> says so, names only the missing side',
   /^Ajax plays outside/.test(p.reason) && !/Arsenal/.test(p.reason), p.reason);
/* The count must come from config rather than a numeral typed into the
   sentence. Numbers up to ten are spelled out and larger ones printed as
   digits, which is ordinary English rather than a special case — so the
   invariant is that the number in the sentence IS DOMESTIC.length, in whichever
   form that particular count takes. */
const WORDS = ['no','one','two','three','four','five','six','seven','eight','nine','ten'];
const countWord = WORDS[DOMESTIC.length] ?? String(DOMESTIC.length);
ok('the league count is spelled from config, not hardcoded',
   p.reason.includes('the ' + countWord + ' leagues'),
   [p.reason, countWord, DOMESTIC.length]);

/* both sides missing: plural agreement */
p = reason(build(true, true), fx('776', '777', 'Ajax', 'Porto', 'uefa.champions'));
console.log('    D2 ' + p.reason);
ok('two missing sides -> plural verb', /^Ajax and Porto play outside/.test(p.reason), p.reason);
p = reason(build(true, true), fx('776', '777', 'Luton', 'Hull', 'eng.1'));
console.log('    C2 ' + p.reason);
ok('two missing rows -> plural verb', /^Luton and Hull do not appear/.test(p.reason), p.reason);

/* E: a cross-league tie where BOTH sides are tracked still predicts */
p = reason(build(true, true), fx('1', 'e1', 'Arsenal', 'Real Madrid', 'uefa.champions'));
ok('UCL tie between two tracked sides predicts', p.ok === true, p.reason);
ok('flagged as cross-league', p.ok && p.crossLeague === true);
if (p.ok) console.log('    E  Arsenal v Real Madrid  xG ' + p.lambda.home.toFixed(2) + '-' + p.lambda.away.toFixed(2) +
  '   ' + p.pct.home + '/' + p.pct.draw + '/' + p.pct.away + '   (identical records, La Liga q=0.98)');
ok('quality coefficient tilts it home', p.ok && p.pct.home > p.pct.away, p.ok && p.pct);

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
