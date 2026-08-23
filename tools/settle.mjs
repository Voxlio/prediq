/* =============================================================================
   tools/settle.mjs — attach final scores to predictions already recorded.

     node tools/settle.mjs            write
     node tools/settle.mjs --dry-run  report only

   The second half of the archive. freeze.mjs writes what we said; this writes
   what happened, and then rebuilds the index and the summary.

   It never touches a prediction. store.js's mergeDay will only ever fill in a
   `result` that is absent, so even a bug here cannot rewrite a probability —
   which is the property the whole archive rests on.

   Requests are batched by calendar month, not by day. A record carries its
   league and its kickoff, so a week of unsettled Saturdays in one division is
   one request rather than seven. ESPN caps a wide date range at 100 events, and
   a month comes back complete.

   Scores are matched on the ESPN event id. Matching on date and team names
   would look equivalent and quietly attach the wrong score to a postponed match
   replayed months later.
   ========================================================================== */

import { fetchMonth } from '../assets/js/api.js';
import { attachResult } from '../assets/js/record.js';
import { writeDay, writeIndex, writeSummary, unsettledDays, paths } from '../assets/js/store.js';
import { MODEL_REV } from '../assets/js/config.js';
import { fileIO, report } from './io.mjs';

const dry = process.argv.includes('--dry-run');
const now = new Date();
const io = fileIO();

/* Three hours after kickoff. A match is not over when it starts, and asking for
   a final score at half time returns a score that is not final — and because a
   result is only ever written once, a premature one would stick. */
const GRACE_HOURS = 3;

/* How long a match may stay unresolved before it is worth saying out loud.
   Abandoned and postponed fixtures exist; they are left pending rather than
   voided, because voiding one is a judgement and this archive stores
   observations. But a growing pile of them should be visible, not silent. */
const STALE_DAYS = 5;

console.log('settle — ' + now.toISOString() + (dry ? '  (dry run)' : ''));

const days = await unsettledDays(io, now, GRACE_HOURS);
if (!days.length) {
  console.log('  nothing awaiting a result');
  if (!dry) {
    /* Still rebuild the summary. The archive can be fully settled and the
       summary stale — a model rev bump changes every figure without changing a
       single record. */
    const s = await writeSummary(io, MODEL_REV, now);
    console.log('  summary rebuilt: ' + s.n + ' records, ' + s.days + ' days');
  }
  report({ settled: 0, pending: 0, stale: 0 });
  process.exit(0);
}

console.log('  ' + days.reduce((t, d) => t + d.pending.length, 0) +
            ' predictions awaiting a result across ' + days.length + ' days');

/* --- work out the smallest set of requests that could answer all of them --- */
const needed = new Map();     /* "slug|year|month" → {slug, year, month} */
const wanted = new Map();     /* record id → the day file it lives in */

for (const { day } of days) {
  const file = await io.read(paths.day(day));
  for (const rec of file?.records ?? []) {
    if (rec.result) continue;
    if (+new Date(rec.kickoff) > +now - GRACE_HOURS * 3600e3) continue;
    const k = new Date(rec.kickoff);
    const key = rec.league + '|' + k.getUTCFullYear() + '|' + k.getUTCMonth();
    needed.set(key, { slug: rec.league, year: k.getUTCFullYear(), month: k.getUTCMonth() });
    wanted.set(rec.id, day);
  }
}
console.log('  ' + needed.size + ' month requests to cover them');

const scores = new Map();     /* event id → [home, away] */
const failed = [];
for (const { slug, year, month } of needed.values()) {
  try {
    for (const r of await fetchMonth(slug, year, month)) {
      if (r.id) scores.set(String(r.id), [r.home.g, r.away.g]);
    }
  } catch (err) {
    /* One month failing must not stop the others. The affected predictions stay
       pending and the next run picks them up. */
    failed.push(slug + ' ' + (month + 1) + '/' + year + ': ' + err.message);
  }
}
if (failed.length) console.log('  ' + failed.length + ' month requests failed: ' + failed.join('; '));
console.log('  ' + scores.size + ' finished matches returned');

/* --- attach ---------------------------------------------------------------- */
let settled = 0, missing = 0, refused = 0, changedDays = 0;
const stale = [];

for (const { day } of days) {
  const file = await io.read(paths.day(day));
  const updates = [];

  for (const rec of file?.records ?? []) {
    if (rec.result || wanted.get(rec.id) !== day) continue;
    const goals = scores.get(rec.id);

    if (!goals) {
      missing++;
      const ageDays = (+now - +new Date(rec.kickoff)) / 864e5;
      if (ageDays > STALE_DAYS) {
        stale.push(rec.id + ' ' + rec.home.name + ' v ' + rec.away.name +
                   ' (' + Math.round(ageDays) + 'd)');
      }
      continue;
    }

    const out = attachResult(rec, { home: goals[0], away: goals[1], at: now });
    if (!out.record) { refused++; console.log('    refused ' + rec.id + ': ' + out.skip); continue; }
    updates.push(out.record);
  }

  if (!updates.length) continue;
  settled += updates.length;
  console.log('  ' + day + '  ' + updates.length + ' settled' + (dry ? ' (dry run)' : ''));
  if (dry) continue;

  const res = await writeDay(io, day, updates, now);
  if (res.changed) changedDays++;
  /* mergeDay reports what it actually did. If it settled fewer than we handed
     it, something disagreed about which records had results — worth knowing
     rather than assuming. */
  if (res.settled.length !== updates.length) {
    console.log('    note: merged ' + res.settled.length + ' of ' + updates.length);
  }
}

if (stale.length) {
  console.log('');
  console.log('  ' + stale.length + ' still unresolved after ' + STALE_DAYS +
              ' days — postponed or abandoned, left pending rather than voided:');
  for (const s of stale.slice(0, 10)) console.log('    ' + s);
  if (stale.length > 10) console.log('    …and ' + (stale.length - 10) + ' more');
}

if (!dry) {
  await writeIndex(io, now);
  const s = await writeSummary(io, MODEL_REV, now);
  console.log('');
  console.log('  summary: ' + s.overall?.scored + ' scored of ' + s.n + ' records');
  if (s.overall?.logLoss != null) {
    console.log('    hit rate ' + (s.overall.hitRate * 100).toFixed(1) + '%, log loss ' +
                s.overall.logLoss.toFixed(4) + ' vs ' + s.overall.baseline.logLoss.toFixed(4) +
                ' for a model that knows nothing');
  }
  if (s.overall && !s.overall.revConsistent) {
    console.log('    WARNING: model rev ' + MODEL_REV + ' covers more than one config hash — ' +
                'the model changed without MODEL_REV being bumped');
  }
}

console.log('');
console.log(settled + ' settled, ' + missing + ' still pending' +
            (refused ? ', ' + refused + ' refused' : '') +
            (dry ? ' (nothing written)' : ', ' + changedDays + ' files changed'));

report({ settled, pending: missing, stale: stale.length });
