/* =============================================================================
   tools/freeze.mjs — write down today's predictions, before the matches start.

     node tools/freeze.mjs            write
     node tools/freeze.mjs --dry-run  report what it would write, touch nothing

   Run by .github/workflows/predictions.yml several times a day. It reads ESPN,
   fits the model, and appends any fixture it has not already recorded to
   data/YYYY-MM-DD.json.

   THE ONE RULE: A FIXTURE IS RECORDED ONCE AND NEVER RE-RECORDED.

   The job runs repeatedly and sees the same fixtures again and again. Rewriting
   them each time would keep nudging `predicted.at` towards kickoff, so the
   archive would show the model predicting matches an hour in advance when it
   had in fact called them two days out — a quiet improvement to our own record.
   store.js enforces this in mergeDay; this script only supplies candidates.

   It also means the frozen bookmaker price is an early one rather than a closing
   one. That is a real cost, accepted deliberately: an early price is a harder
   benchmark to beat on lead time and an easier one on accuracy, and either way
   `predicted.at` makes the lead time visible instead of leaving it to be assumed.

   No credentials, no secrets. Reading ESPN needs no key, and writing is a commit
   made by the workflow's own token.
   ========================================================================== */

import { loadAll } from '../assets/js/api.js';
import { predictAll } from '../assets/js/model.js';
import { freeze, dayKey } from '../assets/js/record.js';
import { writeDay, writeIndex } from '../assets/js/store.js';
import { MODEL_REV, LEAGUES } from '../assets/js/config.js';
import { fileIO, report } from './io.mjs';

const dry = process.argv.includes('--dry-run');
const now = new Date();

/* api.js caches through localStorage and wraps every call, so with no
   localStorage present it simply runs uncached. That is the right behaviour for
   a scheduled job: it should read fresh data every time, not a copy of what it
   read six hours ago. */
console.log('freeze — ' + now.toISOString() + (dry ? '  (dry run)' : ''));
console.log('model rev ' + MODEL_REV + ', ' + LEAGUES.length + ' competitions');

const data = await loadAll();
if (data.errors.length) {
  /* Errors are reported and the run continues. A league that failed contributes
     no fixtures, and refusing to record the other ten because one endpoint was
     down would lose predictions that were perfectly good. */
  const byLeague = {};
  for (const e of data.errors) byLeague[e.league] = (byLeague[e.league] || 0) + 1;
  console.log('  ' + data.errors.length + ' fetch errors: ' +
    Object.entries(byLeague).map(([l, n]) => l + '×' + n).join(', '));
}
console.log('  ' + data.fixtures.length + ' fixtures in the next few days');

const { predictions } = predictAll(data);

const byDay = new Map();
const skips = new Map();
for (const p of predictions) {
  const out = freeze(p, now);
  if (!out.record) {
    /* Grouped by kind rather than listed one per line. "18 idle cup fixtures"
       is readable in a workflow log; eighteen near-identical lines are not, and
       a real problem hides among them. */
    const kind = out.skip.split(':')[0];
    skips.set(kind, (skips.get(kind) || 0) + 1);
    continue;
  }
  const day = dayKey(out.record.kickoff);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(out.record);
}

console.log('  ' + [...byDay.values()].reduce((t, r) => t + r.length, 0) +
            ' predictions across ' + byDay.size + ' days');
for (const [kind, n] of [...skips].sort((a, b) => b[1] - a[1])) {
  console.log('    skipped ' + n + ' · ' + kind);
}

const io = fileIO();
let added = 0, kept = 0, changedDays = 0;

for (const day of [...byDay.keys()].sort()) {
  const records = byDay.get(day);
  if (dry) {
    const before = await io.read('data/' + day + '.json');
    const known = new Set((before?.records ?? []).map(r => r.id));
    const fresh = records.filter(r => !known.has(r.id));
    console.log('  ' + day + '  would add ' + fresh.length + ' of ' + records.length);
    added += fresh.length;
    kept += records.length - fresh.length;
    continue;
  }
  const res = await writeDay(io, day, records, now);
  added += res.added.length;
  kept += res.kept.length;
  if (res.changed) changedDays++;
  console.log('  ' + day + '  +' + res.added.length + ' new, ' +
              res.kept.length + ' already recorded' + (res.changed ? '' : ', unchanged'));
}

/* writeIndex decides for itself whether anything changed, so this is called
   unconditionally. One place decides when a file is worth rewriting. */
if (!dry) await writeIndex(io, now);

console.log('');
console.log(added + ' recorded, ' + kept + ' left as first written' +
            (dry ? ' (nothing written)' : ', ' + changedDays + ' files changed'));

/* The workflow puts these in the commit subject. Handed over as data rather than
   scraped back out of the log above, and counted from what mergeDay actually
   did — so the history says what was committed, not what was attempted. */
report({ recorded: added, days: changedDays });

/* A run that recorded nothing is not a failure. Between fixture rounds, and in
   the summer, there is genuinely nothing to record — and exiting non-zero would
   turn a quiet week into a wall of red workflow runs that nobody then reads. */
if (!dry && added === 0 && data.fixtures.length === 0 && data.errors.length > 0) {
  console.error('no fixtures AND fetch errors — treating as a failed run');
  process.exit(1);
}
