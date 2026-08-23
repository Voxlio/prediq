/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const { MODEL } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const f2 = n => (+n).toFixed(3);

console.log('=== poisson ===');
// P(0; 1) = e^-1 = 0.367879...
ok('P(0;1) = e^-1',      near(M.poisson(0, 1), Math.exp(-1)), M.poisson(0, 1));
// P(2; 1.5) = e^-1.5 * 1.5^2 / 2
ok('P(2;1.5) closed form', near(M.poisson(2, 1.5), Math.exp(-1.5) * 2.25 / 2), M.poisson(2, 1.5));
ok('lambda 0 -> all mass at 0', M.poisson(0, 0) === 1 && M.poisson(1, 0) === 0);
let tail = 0; for (let k = 0; k <= 24; k++) tail += M.poisson(k, 2.0);
ok('sums to ~1 over 0..24', near(tail, 1, 1e-12), tail);
// how much mass does truncating at 4 lose, for a 1.75 xG side?
let t4 = 0, t9 = 0;
for (let k = 0; k <= 4; k++) t4 += M.poisson(k, 1.75);
for (let k = 0; k <= 9; k++) t9 += M.poisson(k, 1.75);
console.log('    lambda 1.75: mass kept to 4 goals = ' + f2(t4) + ', to 9 = ' + f2(t9));
ok('MAX_GOALS=9 keeps >99.9%', t9 > 0.9999, t9);

console.log('=== roundTo100 ===');
const cases = [[0.538,0.236,0.226],[1/3,1/3,1/3],[0.005,0.005,0.99],[0.5,0.5],[1],[0.111,0.111,0.111,0.667]];
let allSum = true;
for (const c of cases) {
  const r = M.roundTo100(c);
  const s = r.reduce((a,b)=>a+b,0);
  if (s !== 100) { allSum = false; console.log('      ' + JSON.stringify(c) + ' -> ' + JSON.stringify(r) + ' = ' + s); }
}
ok('every case sums to exactly 100', allSum);
ok('[]  -> []', M.roundTo100([]).length === 0);
console.log('    54/23/23 check:', JSON.stringify(M.roundTo100([0.538,0.236,0.226])));

console.log('=== matrix + outcomes ===');
const g = M.matrix(1.75, 1.05);
let gs = 0; for (const row of g) for (const p of row) gs += p;
ok('matrix sums to exactly 1', near(gs, 1, 1e-12), gs);
ok('grid is 10x10', g.length === 10 && g[0].length === 10, [g.length, g[0].length]);
const o = M.outcomes(g);
ok('1X2 sums to 1',       near(o.home + o.draw + o.away, 1, 1e-12), o.home+o.draw+o.away);
ok('over25 in (0,1)',     o.over25 > 0 && o.over25 < 1, o.over25);
ok('btts in (0,1)',       o.btts > 0 && o.btts < 1, o.btts);
console.log('    1.75 v 1.05 ->  H ' + f2(o.home) + '  D ' + f2(o.draw) + '  A ' + f2(o.away) +
            '  | o2.5 ' + f2(o.over25) + '  btts ' + f2(o.btts) + '  score ' + o.score.home + '-' + o.score.away);

// symmetry: identical expectations must give identical win probabilities
const sym = M.outcomes(M.matrix(1.4, 1.4));
ok('equal lambdas -> H == A', near(sym.home, sym.away, 1e-12), [sym.home, sym.away]);

// monotonic: raising home xG must raise home win prob
let mono = true, prev = -1;
for (const lh of [0.8, 1.0, 1.4, 1.8, 2.4, 3.0]) {
  const p = M.outcomes(M.matrix(lh, 1.2)).home;
  if (p <= prev) mono = false;
  prev = p;
}
ok('home win rises with home xG', mono);

console.log('=== Dixon-Coles correction ===');
// with rho at 0 the matrix is plain independent Poisson; compare draw rates
const rho = MODEL.DC_RHO;
MODEL.DC_RHO = 0;
const plain = M.outcomes(M.matrix(1.75, 1.05));
MODEL.DC_RHO = rho;
const dc = M.outcomes(M.matrix(1.75, 1.05));
console.log('    draw: independent ' + f2(plain.draw) + '  ->  corrected ' + f2(dc.draw));
ok('correction raises draws', dc.draw > plain.draw, [plain.draw, dc.draw]);
ok('shift is modest (<4 pts)', dc.draw - plain.draw < 0.04, dc.draw - plain.draw);
ok('still sums to 1', near(dc.home + dc.draw + dc.away, 1, 1e-12));
// tau must never let a cell go negative even at extreme xG
let neg = false;
for (const [a, b] of [[6,6],[0.05,0.05],[6,0.05],[3.2,2.8]]) {
  const gg = M.matrix(a, b);
  for (const row of gg) for (const p of row) if (!(p >= 0)) neg = true;
}
ok('no negative cells at extreme xG', !neg);

console.log('=== homeAdvantage ===');
const hv0 = M.homeAdvantage([]);
ok('no matches -> config default', hv0.home === MODEL.HOME_ADVANTAGE && !hv0.measured, hv0);
const mk = (hg, ag) => ({ date: '2026-08-01', home: { id: 'a', g: hg }, away: { id: 'b', g: ag } });
const hv1 = M.homeAdvantage(Array.from({ length: 40 }, () => mk(2, 1)));
ok('factors always sum to 2', near(hv1.home + hv1.away, 2, 1e-12), hv1.home + hv1.away);
ok('home > away when home scores more', hv1.home > hv1.away, hv1);
const hv2 = M.homeAdvantage(Array.from({ length: 4000 }, () => mk(2, 1)));
console.log('    40 matches at 2-1: ' + f2(hv1.home) + '/' + f2(hv1.away) +
            '   4000 matches: ' + f2(hv2.home) + '/' + f2(hv2.away));
ok('large sample converges on observed', near(hv2.home, 4/3, 0.02), hv2.home);
ok('small sample stays near prior', Math.abs(hv1.home - MODEL.HOME_ADVANTAGE) < 0.06, hv1.home);
ok('zero-zero matches -> fallback', M.homeAdvantage([mk(0,0)]).measured === false);

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
