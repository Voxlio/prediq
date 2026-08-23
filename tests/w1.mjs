/* w1.mjs — the archive: store.js, and both writers run end to end.

   This is the suite that has to be trusted, because it guards the one property
   the whole accuracy record rests on: A PREDICTION IS WRITTEN ONCE AND NEVER
   REWRITTEN. If that breaks, nothing else in the project reports it. The site
   still renders, the numbers still look plausible, and the measured record
   quietly improves because every prediction got recorded closer to kickoff than
   it was actually made.

   Part A tests store.js directly with an in-memory adapter, which is the only
   way to count writes and see the bytes.

   Part B runs tools/freeze.mjs and tools/settle.mjs as real processes against a
   temp directory and a fake ESPN. Not because integration tests are fashionable
   but because those two files are scripts: they do their work at import time,
   and there is no function to call. Running them is the only way to test them.
*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../assets/js/', import.meta.url).href;
const S = await import(root + 'store.js');
const R = await import(root + 'record.js');
const { MODEL_REV } = await import(root + 'config.js');

let fails = 0;
const ok = (l, c, g) => {
  console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g)));
  if (!c) fails++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* =============================================================================
   PART A — store.js

   An in-memory adapter with the same three methods tools/io.mjs supplies, plus
   a write log. The log is the point: "did not write" is a distinct outcome from
   "wrote the same bytes", and only a counter can tell them apart.
   ========================================================================== */
function memIO(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  return {
    files, writes,
    async read(p) { return files.has(p) ? JSON.parse(files.get(p)) : null; },
    async write(p, text) { files.set(p, text); writes.push(p); return p; },
    async list() {
      return [...files.keys()]
        .filter(p => /^data\/\d{4}-\d{2}-\d{2}\.json$/.test(p))
        .map(p => p.slice(5, 15)).sort();
    },
  };
}

/* A minimal record, hand-built rather than run through freeze(). rec1.mjs
   already proves freeze() produces this shape; here the shape is the fixture,
   and building it by hand keeps a change in the model from breaking a test
   about file writes. */
const rec = (id, kickoff, over = {}) => ({
  v: 1, id, kickoff, league: 'eng.1',
  home: { id: 'h' + id, name: 'Home ' + id },
  away: { id: 'a' + id, name: 'Away ' + id },
  predicted: {
    at: '2026-08-23T09:00:00.000Z',
    lambda: [1.5, 1.1], probs: [0.5, 0.28, 0.22], pick: 'home',
    score: [1, 1, 0.12], over25: 0.5, btts: 0.52,
    conf: { level: 2, word: 'medium' }, seen: [10, 10],
  },
  market: null,
  model: { rev: MODEL_REV, hash: 'abcd1234' },
  result: null,
  ...over,
});

const A = rec('1', '2026-08-23T14:00:00.000Z');
const B = rec('2', '2026-08-23T12:00:00.000Z');
const C = rec('3', '2026-08-23T14:00:00.000Z');

console.log('=== a record is written once and never rewritten ===');

const fresh = S.mergeDay([], [A, B]);
ok('a day that did not exist takes both records', eq(fresh.added.sort(), ['1', '2']), fresh.added);
ok('and nothing is reported as kept or settled',
  fresh.kept.length === 0 && fresh.settled.length === 0);

/* The attack this guards against is not malice, it is the scheduled job doing
   exactly what it was told, six times a day. Each run re-freezes the same
   fixture with a later `predicted.at`. */
const later = rec('1', '2026-08-23T14:00:00.000Z', {
  predicted: { ...A.predicted, at: '2026-08-23T13:30:00.000Z', probs: [0.7, 0.2, 0.1] },
});
const again = S.mergeDay(fresh.records, [later]);
const stillA = again.records.find(r => r.id === '1');
ok('offering the same fixture again changes nothing', eq(again.kept, ['1']), again);
ok('predicted.at stays at the first, earliest reading',
  stillA.predicted.at === '2026-08-23T09:00:00.000Z', stillA.predicted.at);
ok('and so do the probabilities', eq(stillA.predicted.probs, [0.5, 0.28, 0.22]),
  stillA.predicted.probs);

console.log('');
console.log('=== attaching a result is the one permitted change ===');
const settledA = R.attachResult(A, { home: 2, away: 0, at: '2026-08-23T16:00:00.000Z' }).record;
const withResult = S.mergeDay(fresh.records, [settledA]);
const got = withResult.records.find(r => r.id === '1');
ok('a result lands on a record that had none', eq(withResult.settled, ['1']), withResult);
ok('the goals are the ones supplied', eq(got.result.goals, [2, 0]), got.result);
ok('and NOTHING else about the record moved',
  eq({ ...got, result: null }, A), { ...got, result: null });

/* A result is write-once too. ESPN has been seen to correct a scoreline; taking
   the correction silently would mean the archive says one thing today and
   another tomorrow with no record of the change. Refusing it means a wrong score
   stays wrong and visible, which is recoverable. */
const rewritten = { ...settledA, result: { at: '2026-08-24T00:00:00.000Z', goals: [9, 9] } };
const refused = S.mergeDay(withResult.records, [rewritten]);
ok('a result already recorded is not replaced', eq(refused.kept, ['1']), refused);
ok('the first score stands',
  eq(refused.records.find(r => r.id === '1').result.goals, [2, 0]));

console.log('');
console.log('=== ordering is by kickoff, and stable ===');
const shuffled = S.mergeDay([], [C, A, B]).records.map(r => r.id);
const other = S.mergeDay([], [B, C, A]).records.map(r => r.id);
ok('earliest kickoff first', shuffled[0] === '2', shuffled);
ok('ties broken by id, so two 14:00 kickoffs have a fixed order',
  eq(shuffled, ['2', '1', '3']), shuffled);
ok('and input order cannot change the output order', eq(shuffled, other), [shuffled, other]);

console.log('');
console.log('=== serialisation is diffable ===');
ok('every file ends with a newline', S.serialise({ a: 1 }).endsWith('\n'));
ok('indented, so a one-field change is a one-line diff',
  S.serialise({ a: 1 }) === '{\n  "a": 1\n}\n', S.serialise({ a: 1 }));
ok('equal values serialise to identical bytes',
  S.serialise({ a: [1, 2] }) === S.serialise({ a: [1, 2] }));

console.log('');
console.log('=== an unchanged file is not rewritten ===');
{
  /* Counted as we go. Reading io.writes.length after all three calls would
     compare against a number that had already moved on — which is how the first
     draft of this block managed to fail while the code was correct. */
  const io = memIO();
  const first = await S.writeDay(io, '2026-08-23', [A, B]);
  const afterFirst = io.writes.length;
  const second = await S.writeDay(io, '2026-08-23', [A, B]);
  const afterSecond = io.writes.length;
  const third = await S.writeDay(io, '2026-08-23', [A, B, C]);
  const afterThird = io.writes.length;

  ok('the first write happens', first.changed && afterFirst === 1, afterFirst);
  ok('the second does not, at all', second.changed === false && afterSecond === 1, afterSecond);
  ok('a genuinely new record does write', third.changed && afterThird === 2, afterThird);
  ok('and the day file holds all three', (await io.read('data/2026-08-23.json')).records.length === 3);
}

console.log('');
console.log('=== the index is rebuilt from the files, not from itself ===');
{
  /* Deliberately wrong: a day that does not exist, a day that does but is
     missing, and counts that are nonsense. A writer that trusted the index
     could never recover from this. */
  const io = memIO({
    'data/index.json': S.serialise({ updatedAt: 'old', days: ['1999-01-01'], revs: { '0.1': 400 } }),
  });
  await S.writeDay(io, '2026-08-23', [A, B]);
  await S.writeDay(io, '2026-08-24', [C]);
  const idx = await S.writeIndex(io, new Date('2026-08-25T00:00:00Z'));
  ok('the phantom day is gone', !idx.days.includes('1999-01-01'), idx.days);
  ok('the real days are listed, sorted', eq(idx.days, ['2026-08-23', '2026-08-24']), idx.days);
  ok('records are counted per model revision', eq(idx.revs, { [MODEL_REV]: 3 }), idx.revs);
  ok('the index reports that it changed', idx.changed === true);

  const before = io.writes.length;
  const rerun = await S.writeIndex(io, new Date('2026-08-26T00:00:00Z'));
  ok('rebuilding an unchanged index writes nothing, even a day later',
    rerun.changed === false && io.writes.length === before, io.writes.length - before);
}

console.log('');
console.log('=== the summary is grouped by revision, never pooled ===');
{
  /* Two revisions, and the older one is deliberately much better. If `overall`
     pooled them, today's model would be credited with a predecessor's results —
     the exact flattery this whole design exists to prevent. */
  const old = (id, probs, goals) => rec(id, '2026-08-20T14:00:00.000Z', {
    model: { rev: '0.9', hash: 'old00000' },
    predicted: { ...A.predicted, probs, pick: 'home' },
    result: { at: '2026-08-20T16:00:00.000Z', goals },
  });
  const now = (id, probs, goals) => rec(id, '2026-08-23T14:00:00.000Z', {
    predicted: { ...A.predicted, probs, pick: 'home' },
    result: { at: '2026-08-23T16:00:00.000Z', goals },
  });

  const io = memIO();
  await S.writeDay(io, '2026-08-20',
    [old('10', [0.9, 0.05, 0.05], [3, 0]), old('11', [0.9, 0.05, 0.05], [2, 1])]);
  await S.writeDay(io, '2026-08-23',
    [now('20', [0.5, 0.3, 0.2], [3, 0]), now('21', [0.5, 0.3, 0.2], [0, 2])]);

  const sum = await S.writeSummary(io, MODEL_REV, new Date('2026-08-24T00:00:00Z'));
  console.log('    rev 0.9 hit ' + sum.byRev['0.9'].hitRate.toFixed(2) +
              ', rev ' + MODEL_REV + ' hit ' + sum.byRev[MODEL_REV].hitRate.toFixed(2) +
              ', overall ' + sum.overall.hitRate.toFixed(2) +
              ', coverage ' + sum.coverage.toFixed(2));

  ok('both revisions appear', eq(Object.keys(sum.byRev).sort(), ['0.9', MODEL_REV]));
  ok('the old revision scored 2 of 2', sum.byRev['0.9'].hitRate === 1, sum.byRev['0.9'].hitRate);
  ok('the current one scored 1 of 2', sum.byRev[MODEL_REV].hitRate === 0.5);
  ok('overall is the current revision, not the average of both',
    sum.overall.hitRate === 0.5, sum.overall.hitRate);
  ok('and coverage says how much of the archive that is',
    sum.coverage === 0.5, sum.coverage);
  ok('n counts every record, so coverage can be checked', sum.n === 4, sum.n);
  ok('the current revision is named, not just implied', sum.currentRev === MODEL_REV);

  const before = io.writes.length;
  await S.writeSummary(io, MODEL_REV, new Date('2026-09-01T00:00:00Z'));
  ok('an unchanged summary is not rewritten a week later',
    io.writes.length === before, io.writes.length - before);
}

console.log('');
console.log('=== which days still need results ===');
{
  const now = new Date('2026-08-23T18:00:00.000Z');
  const io = memIO();
  await S.writeDay(io, '2026-08-23', [
    rec('p1', '2026-08-23T12:00:00.000Z'),                            /* 6h ago, pending */
    rec('p2', '2026-08-23T17:00:00.000Z'),                            /* 1h ago, in play */
    rec('p3', '2026-08-23T20:00:00.000Z'),                            /* not started */
    rec('p4', '2026-08-23T12:00:00.000Z',
      { result: { at: '2026-08-23T14:00:00.000Z', goals: [1, 0] } }),  /* done */
  ]);
  const pend = await S.unsettledDays(io, now, 3);
  ok('one day needs attention', pend.length === 1 && pend[0].day === '2026-08-23', pend);
  ok('only the match finished long enough ago', eq(pend[0].pending, ['p1']), pend[0].pending);
  ok('a match kicked off an hour ago is left alone — half time is not a result',
    !pend[0].pending.includes('p2'));
  ok('a match not yet played is not pending', !pend[0].pending.includes('p3'));
  ok('a settled match is not pending', !pend[0].pending.includes('p4'));

  await S.writeDay(io, '2026-08-23', [
    R.attachResult(rec('p1', '2026-08-23T12:00:00.000Z'), { home: 1, away: 1 }).record]);
  ok('once settled, the day drops off the list',
    (await S.unsettledDays(io, now, 3)).length === 0);
}

console.log('');
console.log('=== a postponed fixture, recorded twice ===');
{
  /* freeze() files a record under its kickoff day. A postponed match reappears
     with a new kickoff, so it is written again under the new day — the same id
     in two files. That is not a bug to be fixed: we did claim the first one, and
     deleting it would be rewriting history. What matters is that the abandoned
     claim cannot touch any accuracy figure. */
  const io = memIO();
  const orphan = rec('99', '2026-08-23T14:00:00.000Z');
  const replayed = R.attachResult(
    rec('99', '2026-09-05T14:00:00.000Z'), { home: 2, away: 1 }).record;
  await S.writeDay(io, '2026-08-23', [orphan]);
  await S.writeDay(io, '2026-09-05', [replayed]);
  const sum = await S.writeSummary(io, MODEL_REV, new Date('2026-09-06T00:00:00Z'));
  ok('both claims are kept', sum.n === 2, sum.n);
  ok('only the played one is scored', sum.overall.scored === 1, sum.overall.scored);
  ok('the abandoned one is reported as pending, not as a miss',
    sum.overall.pending === 1, sum.overall.pending);
  ok('so the hit rate is over played matches only', sum.overall.hitRate === 1, sum.overall.hitRate);

  const pend = await S.unsettledDays(io, new Date('2026-09-20T00:00:00Z'), 3);
  ok('and it stays visible as unresolved rather than disappearing',
    pend.length === 1 && pend[0].day === '2026-08-23', pend);
}

console.log('');
console.log('=== reading an archive that is not there ===');
{
  const empty = async () => null;
  const idx = await S.loadIndex(empty);
  ok('a missing index reads as empty, not as a crash',
    eq(idx, { updatedAt: null, days: [], revs: {} }), idx);
  const day = await S.loadDay(empty, '2026-08-23');
  ok('a missing day reads as zero records', eq(day, { day: '2026-08-23', records: [], updatedAt: null }));
  ok('a missing summary reads as null', (await S.loadSummary(empty)) === null);

  let threw = null;
  try { await S.loadDay(empty, 'yesterday'); } catch (e) { threw = e.message; }
  ok('a day key that is not a date is rejected outright', /not a day key/.test(threw || ''), threw);

  const holes = await S.loadDays(async p =>
    p.includes('2026-08-23') ? { records: [A] } : null, ['2026-08-22', '2026-08-23']);
  ok('a gap in a range comes back empty rather than being dropped',
    holes.length === 2 && holes[0].records.length === 0 && holes[1].records.length === 1,
    holes.map(h => h.records.length));
}

console.log('');
console.log('=== 404 is a fact about the archive, 500 is a fact about the network ===');
{
  const src = code => S.httpSource({
    base: '/', fetchImpl: async () => ({
      status: code, ok: code < 400, json: async () => ({ ok: true }),
    }),
  });
  ok('404 returns null', (await src(404)('data/index.json')) === null);
  ok('200 returns the body', eq(await src(200)('data/index.json'), { ok: true }));
  let threw = null;
  try { await src(500)('data/index.json'); } catch (e) { threw = e.message; }
  ok('500 throws, so the page can say the archive is unreachable',
    /HTTP 500/.test(threw || ''), threw);
}

console.log('');
console.log('=== the rolling window of recent days ===');
{
  const d = S.recentDays(4, new Date('2026-03-02T23:30:00.000Z'));
  ok('most recent first', eq(d, ['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27']), d);
  ok('UTC, so a late-evening kickoff is not filed under tomorrow',
    S.recentDays(1, new Date('2026-03-02T23:59:59.000Z'))[0] === '2026-03-02');
  ok('and a leap year is not special-cased by hand',
    eq(S.recentDays(2, new Date('2024-03-01T00:00:00.000Z')), ['2024-03-01', '2024-02-29']));
}

/* =============================================================================
   PART B — the two writers, run for real

   A temp PREDIQ_ROOT, a fake ESPN, and a fake clock. freeze runs "before" the
   matches; settle runs two days "after" them. Neither script knows.
   ========================================================================== */
console.log('');
console.log('=== running the writers ===');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const mock = new URL('./mock-espn.mjs', import.meta.url).href;
const box = mkdtempSync(join(tmpdir(), 'prediq-w1-'));

const BASE = '2026-08-23T09:00:00.000Z';
const run = (script, { now, played = false, args = [] } = {}) => {
  const r = spawnSync(process.execPath, ['--import', mock, join('tools', script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PREDIQ_ROOT: box,
      MOCK_BASE: BASE,
      MOCK_NOW: now,
      MOCK_PLAYED: played ? '1' : '0',
    },
  });
  return { ...r, out: (r.stdout || '') + (r.stderr || '') };
};

const dataDir = join(box, 'data');
const files = () => (existsSync(dataDir) ? readdirSync(dataDir).sort() : []);
const raw = f => readFileSync(join(dataDir, f), 'utf8');
const json = f => JSON.parse(raw(f));
const dayFiles = () => files().filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const allRecords = () => dayFiles().flatMap(f => json(f).records);

/* --- dry run first: it must be inert -------------------------------------- */
const dryRun = run('freeze.mjs', { now: BASE, args: ['--dry-run'] });
ok('freeze --dry-run exits clean', dryRun.status === 0, dryRun.out.slice(-400));
ok('and writes absolutely nothing', files().length === 0, files());
ok('but still says what it would have done', /would add/.test(dryRun.out), dryRun.out.slice(-300));

/* --- too early to record anything -----------------------------------------
   Run three days before kickoff. Every fixture is visible — the list runs a week
   out — and every one of them is outside the stated lead time, so the archive
   must stay empty. Get this wrong and every figure on the accuracy page silently
   becomes a week-old prediction nobody ever read. */
const early = run('freeze.mjs', { now: '2026-08-20T09:00:00.000Z' });
ok('freeze three days out exits clean', early.status === 0, early.out.slice(-400));
ok('and records not one prediction', dayFiles().length === 0, dayFiles());
ok('saying why, rather than looking like a day with no football',
  /h away/.test(early.out), early.out.slice(-400));
/* It does write an index, and should: an empty index and a missing one are
   different facts, and the site has to be able to say "nothing recorded yet"
   without treating a 404 as a failure. */
ok('an empty archive still gets an index, so the site can read it',
  eq(json('index.json').days, []) && eq(json('index.json').revs, {}), json('index.json'));

/* --- the real freeze ------------------------------------------------------ */
const f1 = run('freeze.mjs', { now: BASE });
console.log(f1.out.split('\n').filter(l => l.trim()).map(l => '    ' + l).join('\n'));
ok('freeze exits clean', f1.status === 0, f1.out.slice(-600));

const written = dayFiles();
const recs = allRecords();
ok('it wrote an index', existsSync(join(dataDir, 'index.json')));
ok('and day files, one per kickoff date',
  written.length === 2 && eq(written, ['2026-08-23.json', '2026-08-24.json']), written);
ok('every record it wrote is unplayed', recs.every(r => r.result === null), recs.length);
ok('a record was written for each live competition',
  recs.length === 12, recs.map(r => r.league));
ok('the two idle European competitions contributed none',
  !recs.some(r => r.league === 'uefa.europa' || r.league === 'uefa.europa.conf'));
ok('the cross-league Champions League tie IS recorded',
  recs.some(r => r.league === 'uefa.champions'),
  recs.map(r => r.league).join(','));
ok('some records carry a market price and some do not — both are ordinary',
  recs.some(r => r.market) && recs.some(r => !r.market),
  recs.filter(r => r.market).length + ' of ' + recs.length);
ok('every record is stamped with the current model revision',
  recs.every(r => r.model.rev === MODEL_REV));
ok('and with one single config hash, since one config produced them all',
  new Set(recs.map(r => r.model.hash)).size === 1, [...new Set(recs.map(r => r.model.hash))]);
ok('every prediction was made before its kickoff',
  recs.every(r => +new Date(r.predicted.at) < +new Date(r.kickoff)));
ok('each record is filed under the UTC day of its kickoff',
  dayFiles().every(f => json(f).records.every(r => R.dayKey(r.kickoff) === f.slice(0, 10))),
  dayFiles().map(f => [f, json(f).records.map(r => R.dayKey(r.kickoff))]));
ok('the index lists exactly the days that exist',
  eq(json('index.json').days, written.map(f => f.slice(0, 10))), json('index.json').days);
ok('and counts every record under its revision',
  json('index.json').revs[MODEL_REV] === recs.length, json('index.json').revs);

/* --- THE invariant: run it again -----------------------------------------
   Same fixtures, an hour later. This is what the workflow actually does, six
   times a day, and it is the case that must produce no change whatsoever. */
const snapshot = Object.fromEntries(files().map(f => [f, raw(f)]));
/* The clock the second run was given, so "did predicted.at move" is a question
   about which run wrote it rather than about millisecond equality. */
const SECOND_RUN = '2026-08-23T10:00:00.000Z';
const f2 = run('freeze.mjs', { now: SECOND_RUN });
ok('a second freeze exits clean', f2.status === 0, f2.out.slice(-400));
ok('and reports it recorded nothing new', /^0 recorded/m.test(f2.out), f2.out.slice(-200));
ok('EVERY file is byte-for-byte what it was',
  files().every(f => raw(f) === snapshot[f]) && files().length === Object.keys(snapshot).length,
  files().filter(f => raw(f) !== snapshot[f]));
ok('so every predicted.at still dates from the first run, not the second',
  allRecords().every(r => +new Date(r.predicted.at) < +new Date(SECOND_RUN)),
  [...new Set(allRecords().map(r => r.predicted.at))]);

/* --- settle -------------------------------------------------------------- */
console.log('');
const frozen = Object.fromEntries(allRecords().map(r => [r.id, JSON.stringify(r)]));

const s1 = run('settle.mjs', { now: '2026-08-25T09:00:00.000Z', played: true });
console.log(s1.out.split('\n').filter(l => l.trim()).map(l => '    ' + l).join('\n'));
ok('settle exits clean', s1.status === 0, s1.out.slice(-600));

const after = allRecords();
ok('every prediction now has a result',
  after.every(r => r.result), after.filter(r => !r.result).map(r => r.id));
ok('which means the ESPN event id survived parseResults — nothing else could match them',
  after.length > 0 && after.every(r => Array.isArray(r.result.goals)));
ok('the scores are the ones ESPN reported, not invented',
  after.every(r => r.result.goals.every(Number.isInteger)),
  after.map(r => r.result.goals));
ok('and settling changed the result field and NOTHING else',
  after.every(r => JSON.stringify({ ...r, result: null }) === frozen[r.id]),
  after.filter(r => JSON.stringify({ ...r, result: null }) !== frozen[r.id]).map(r => r.id));

ok('a summary was written', existsSync(join(dataDir, 'summary.json')));
const sum = json('summary.json');
console.log('    summary: ' + sum.overall.scored + '/' + sum.n + ' scored, hit ' +
            (sum.overall.hitRate * 100).toFixed(0) + '%, log loss ' +
            sum.overall.logLoss.toFixed(4) + ' vs baseline ' +
            sum.overall.baseline.logLoss.toFixed(4));
ok('it scored every record', sum.overall.scored === after.length, [sum.overall.scored, after.length]);
ok('nothing is left pending', sum.overall.pending === 0, sum.overall.pending);
ok('log loss is a real finite number', Number.isFinite(sum.overall.logLoss), sum.overall.logLoss);
ok('it is stated against the no-knowledge baseline, not on its own',
  Math.abs(sum.overall.baseline.logLoss - Math.log(3)) < 1e-9, sum.overall.baseline);
ok('the whole archive is one revision, so coverage is total', sum.coverage === 1, sum.coverage);
ok('and that revision is internally consistent',
  sum.overall.revConsistent === true, sum.overall.revs);
ok('calibration buckets pool all three probabilities, not just the pick',
  sum.overall.calibration.reduce((t, b) => t + b.n, 0) === after.length * 3,
  sum.overall.calibration.reduce((t, b) => t + b.n, 0));

/* The market leg. Only half the mock's competitions are priced, which is the
   point: the comparison must run over the priced half and say so, rather than
   quietly treating an unpriced match as a match the bookmaker got wrong. */
const mk = sum.overall.market;
console.log('    market: ' + mk.n + ' of ' + after.length + ' priced, model log loss ' +
            mk.modelLogLoss.toFixed(4) + ' vs market ' + mk.marketLogLoss.toFixed(4));
ok('the market comparison covers the priced records only',
  mk.n === after.filter(r => r.market).length, [mk.n, after.filter(r => r.market).length]);
ok('and states that coverage rather than leaving it to be assumed',
  Math.abs(mk.coverage - mk.n / after.length) < 1e-9, mk.coverage);
ok('both sides are scored the same way, on the same matches',
  Number.isFinite(mk.modelLogLoss) && Number.isFinite(mk.marketLogLoss));
ok('the market figure is not the model figure under another name',
  mk.marketLogLoss !== mk.modelLogLoss, [mk.modelLogLoss, mk.marketLogLoss]);
ok('overround is recorded, so how much margin was taken is visible',
  after.filter(r => r.market).every(r => r.market.overround > 1),
  after.filter(r => r.market).map(r => r.market.overround));

/* --- and settle is idempotent too --------------------------------------- */
const settledSnapshot = Object.fromEntries(files().map(f => [f, raw(f)]));
const s2 = run('settle.mjs', { now: '2026-08-26T09:00:00.000Z', played: true });
ok('a second settle exits clean', s2.status === 0, s2.out.slice(-400));
ok('and finds nothing awaiting a result', /nothing awaiting a result/.test(s2.out), s2.out.slice(-200));
ok('no file changes, not even a timestamp',
  files().every(f => raw(f) === settledSnapshot[f]),
  files().filter(f => raw(f) !== settledSnapshot[f]));

/* --- a fixture that never finishes ------------------------------------- */
console.log('');
console.log('=== a match that never produces a result ===');
{
  const box2 = mkdtempSync(join(tmpdir(), 'prediq-w1b-'));
  const run2 = (script, env) => spawnSync(
    process.execPath, ['--import', mock, join('tools', script)],
    { cwd: projectRoot, encoding: 'utf8',
      env: { ...process.env, PREDIQ_ROOT: box2, MOCK_BASE: BASE, ...env } });

  run2('freeze.mjs', { MOCK_NOW: BASE, MOCK_PLAYED: '0' });
  /* Played=0 at settle time: the matches are past, and ESPN reports no result
     for them — exactly what a postponement looks like from here. */
  const r = run2('settle.mjs', { MOCK_NOW: '2026-09-02T09:00:00.000Z', MOCK_PLAYED: '0' });
  const out = (r.stdout || '') + (r.stderr || '');
  const d2 = join(box2, 'data');
  const left = readdirSync(d2).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .flatMap(f => JSON.parse(readFileSync(join(d2, f), 'utf8')).records);

  ok('settle still exits clean', r.status === 0, out.slice(-400));
  ok('it says so out loud rather than silently', /still unresolved after/.test(out), out.slice(-500));
  ok('no result is invented', left.every(rr => rr.result === null), left.filter(rr => rr.result).length);
  ok('the predictions are not deleted either', left.length === 12, left.length);
  const sum2 = JSON.parse(readFileSync(join(d2, 'summary.json'), 'utf8'));
  ok('so they count as pending and score nothing',
    sum2.overall.scored === 0 && sum2.overall.pending === 12,
    [sum2.overall.scored, sum2.overall.pending]);
  ok('and the accuracy figures are null rather than a flattering zero',
    sum2.overall.hitRate === null && sum2.overall.logLoss === null,
    [sum2.overall.hitRate, sum2.overall.logLoss]);
  rmSync(box2, { recursive: true, force: true });
}

/* --- one league down --------------------------------------------------- */
console.log('');
console.log('=== one competition unreachable ===');
{
  const box3 = mkdtempSync(join(tmpdir(), 'prediq-w1c-'));
  const r = spawnSync(process.execPath, ['--import', mock, join('tools', 'freeze.mjs')], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, PREDIQ_ROOT: box3, MOCK_BASE: BASE, MOCK_NOW: BASE,
           MOCK_PLAYED: '0', MOCK_BREAK: 'ger.1' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const d3 = join(box3, 'data');
  const left = readdirSync(d3).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .flatMap(f => JSON.parse(readFileSync(join(d3, f), 'utf8')).records);
  ok('freeze exits clean with a league down', r.status === 0, out.slice(-400));
  ok('it reports the failures', /fetch errors/.test(out), out.slice(-400));
  ok('no Bundesliga prediction is recorded', !left.some(rr => rr.league === 'ger.1'),
    left.filter(rr => rr.league === 'ger.1').map(rr => rr.id));
  ok('but the other eleven competitions are recorded anyway', left.length === 11, left.length);
  rmSync(box3, { recursive: true, force: true });
}

rmSync(box, { recursive: true, force: true });

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
