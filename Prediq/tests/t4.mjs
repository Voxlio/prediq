/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const { seasonMonths } = await import(base + 'api.js');
const { currentSeason } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(g))); if (!c) fails++; };
const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const show = a => a.map(([y, m]) => names[m] + ' ' + y).join(', ');

console.log('--- currentSeason: July is the rollover ---');
ok('2026-08-22 -> 2026', currentSeason(new Date(2026, 7, 22)) === 2026);
ok('2026-06-30 -> 2025', currentSeason(new Date(2026, 5, 30)) === 2025);
ok('2026-07-01 -> 2026', currentSeason(new Date(2026, 6, 1)) === 2026);
ok('2027-05-15 -> 2026', currentSeason(new Date(2027, 4, 15)) === 2026);

console.log('--- seasonMonths ---');
const now = seasonMonths(2026, new Date(2026, 7, 22));
console.log('    today (Aug 2026):', show(now));
ok('one month so far', now.length === 1 && now[0][1] === 7, now);

const mid = seasonMonths(2026, new Date(2027, 0, 15));
console.log('    mid-season (Jan 2027):', show(mid));
ok('Aug..Jan = 6', mid.length === 6, mid.length);
ok('starts August 2026', mid[0][0] === 2026 && mid[0][1] === 7, mid[0]);
ok('crosses new year', mid[5][0] === 2027 && mid[5][1] === 0, mid[5]);

const full = seasonMonths(2025, new Date(2026, 7, 22));
console.log('    finished season 2025:', show(full));
ok('Aug..May = 10 months', full.length === 10, full.length);
ok('ends May 2026', full[9][0] === 2026 && full[9][1] === 4, full[9]);
ok('no June/July leak', !full.some(([, m]) => m === 5 || m === 6), full);

const early = seasonMonths(2026, new Date(2026, 6, 10));
ok('July: season not started -> 0', early.length === 0, early);

console.log(fails ? fails + ' FAILURE(S)' : 'ALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
