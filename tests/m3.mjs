/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const M = await import(base + 'model.js');
const { LEAGUES } = await import(base + 'config.js');
const byLeague = {};
for (const lg of LEAGUES) byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
const data = { season: 2026, prevSeason: 2025, months: [], errors: [], fixtures: [
  { id: 'x', leagueSlug: 'eng.1', date: '2026-08-29T14:00Z', venue: null,
    home: { id: '1', name: 'Arsenal', short: 'ARS', form: null },
    away: { id: '2', name: 'Chelsea', short: 'CHE', form: null }, odds: null },
], byLeague };
const { index, predictions } = M.predictAll(data);
console.log('  global mean fallback:', index.mean);
console.log('  predictions:', predictions.length, '| ok:', predictions[0].ok);
console.log('  reason: "' + predictions[0].reason + '"');
const bad = index.mean !== 1.35 || predictions[0].ok !== false;
console.log(bad ? '  FAIL' : '  pass  degrades to an honest refusal, no crash, no invented numbers');
process.exit(bad ? 1 : 0);
