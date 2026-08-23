/* =============================================================================
   tools/mirror.mjs — copy the committed archive into Firestore.

     node tools/mirror.mjs             mirror the recent window
     node tools/mirror.mjs --all       mirror everything (repair after an outage)
     node tools/mirror.mjs --dry-run   print the plan, send nothing

   Runs after the commit step, deliberately. data/ in the repository is the
   archive; this is a copy of it. Doing it in that order means a Firestore outage
   can never cost us a prediction — the record is already committed and pushed
   before this script starts, and the next run picks up whatever this one missed.

   It reads only what is on disk. It does not fetch ESPN, does not fit the model
   and cannot invent a record, so there is no path by which a bug here writes a
   prediction that is not already in git.

   WHY IT IS NOT PART OF freeze.mjs / settle.mjs

   Those two are the archive. Keeping the mirror separate means they stay
   testable with no credentials and no network beyond ESPN, a Firestore failure
   cannot abort a freeze, and this script is free to be idempotent and
   self-healing — run it twice and the second run writes nothing.
   ========================================================================== */

import { paths } from '../assets/js/store.js';
import { FIREBASE, FIRESTORE_COLLECTION, FIRESTORE_META } from '../assets/js/firebase-config.js';
import { readCredentials, firestore } from './firestore.mjs';
import { fileIO, report } from './io.mjs';

const dry = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');
const now = new Date();
const io = fileIO();

/* How far back a day file can still change. A record is created within 24 hours
   of kickoff and settled within a few hours after, so nothing older than this can
   differ from what Firestore already holds. Re-sending the whole archive every
   run would work identically and burn write quota for nothing.

   Generous on purpose: four days rather than two, because the cost of an extra
   day is a few dozen no-op writes and the cost of being too tight is a record
   that never reaches Firestore at all. --all exists for when that happens anyway.
*/
const WINDOW_DAYS = 4;

console.log('mirror — ' + now.toISOString() + (dry ? '  (dry run)' : '') + (all ? '  (full)' : ''));

/* --- is the mirror switched on? ---------------------------------------------
   No credentials is a normal, supported state, not a failure. Someone who forks
   Prediq gets a working site and a working archive with no Firebase project at
   all, and this script tells them why it did nothing rather than going red.
--------------------------------------------------------------------------- */
let sa;
try {
  sa = readCredentials();
} catch (err) {
  console.error('  FIREBASE_SERVICE_ACCOUNT is set but unusable: ' + err.message);
  process.exit(1);
}
if (!sa) {
  console.log('  no FIREBASE_SERVICE_ACCOUNT — mirror disabled, archive unaffected');
  report({ mirrored: 0, present: 0, mirror: 'disabled' });
  process.exit(0);
}

/* Pasting a key from the wrong project would silently populate a database nobody
   is looking at, and everything would appear to succeed. Two independent sources
   name the project, so they can be made to agree. */
if (sa.project_id !== FIREBASE.projectId) {
  console.error('  the service account is for project "' + sa.project_id + '" but ' +
    'assets/js/firebase-config.js says "' + FIREBASE.projectId + '".');
  console.error('  Refusing to write. One of the two is wrong.');
  process.exit(1);
}
console.log('  project ' + sa.project_id + ', service account ' + sa.client_email);

/* --- which days --------------------------------------------------------------*/
const index = await io.read(paths.index());
const every = index?.days ?? await io.list();
if (!every.length) {
  console.log('  archive is empty, nothing to mirror');
  report({ mirrored: 0, present: 0, mirror: 'empty' });
  process.exit(0);
}

/* Day keys are ISO, so a string comparison is a date comparison. Future days sort
   above the cutoff and are included automatically — those are the predictions
   most worth having mirrored, since they are the ones not yet settled. */
const cutoff = new Date(+now - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
const days = all ? every : every.filter(d => d >= cutoff);
console.log('  ' + days.length + ' of ' + every.length + ' days in scope' +
            (all ? '' : ' (since ' + cutoff + ')'));

const db = firestore({ credentials: sa });

/* --- build the write plan ----------------------------------------------------
   Every record gets a create with an exists:false precondition, so all but the
   first run refuse — that refusal IS the write-once guarantee, enforced by the
   database against us rather than by our own code. Settled records additionally
   get a masked update that can touch nothing but `result`.
-------------------------------------------------------------------------------*/
const writes = [];
let records = 0, settled = 0;

for (const day of days) {
  const file = await io.read(paths.day(day));
  for (const rec of file?.records ?? []) {
    records++;
    writes.push(db.createRecord(FIRESTORE_COLLECTION, day, rec));
    if (rec.result) {
      settled++;
      writes.push(db.attachResult(FIRESTORE_COLLECTION, day, rec));
    }
  }
}

/* The derived documents, so a Firestore reader can find its way around without
   listing the whole collection. Sent on every run because they are meant to
   change; they cost two writes. */
if (index) writes.push(db.putMeta(FIRESTORE_META, 'index', index));
const summary = await io.read(paths.summary());
if (summary) writes.push(db.putMeta(FIRESTORE_META, 'summary', summary));

console.log('  ' + records + ' records (' + settled + ' settled) → ' + writes.length + ' writes');

if (dry) {
  for (const w of writes.slice(0, 8)) {
    const kind = w.write.updateMask ? 'result' :
                 w.write.currentDocument?.exists === false ? 'create' : 'overwrite';
    console.log('    ' + kind.padEnd(9) + ' ' + w.label);
  }
  if (writes.length > 8) console.log('    …and ' + (writes.length - 8) + ' more');
  console.log('');
  console.log('nothing sent (dry run)');
  process.exit(0);
}

/* --- send --------------------------------------------------------------------*/
let result;
try {
  result = await db.batchWrite(writes);
} catch (err) {
  /* A hard failure — bad credentials, no network, Firestore down. The archive is
     already committed, so this costs nothing but a red step, and the next run
     retries from the repository. */
  console.error('  mirror failed: ' + err.message);
  console.error('  data/ is unaffected: it was committed before this step ran.');
  report({ mirrored: 0, present: 0, mirror: 'failed' });
  process.exit(1);
}

console.log('');
console.log(result.applied + ' written, ' + result.existed + ' already there' +
            (result.failures.length ? ', ' + result.failures.length + ' failed' : ''));

if (result.failures.length) {
  /* Grouped by gRPC code. Twelve identical PERMISSION_DENIED lines say the same
     one thing as one line, and a rarer code hiding among them is the thing worth
     seeing. */
  const byCode = new Map();
  for (const f of result.failures) {
    if (!byCode.has(f.code)) byCode.set(f.code, { n: 0, eg: f });
    byCode.get(f.code).n++;
  }
  for (const [code, { n, eg }] of byCode) {
    console.error('  code ' + code + ' ×' + n + ': ' + eg.message + '  (e.g. ' + eg.id + ')');
    if (code === 7) {
      console.error('    PERMISSION_DENIED — the service account lacks Cloud Datastore ' +
        'User, or the Firestore database has not been created yet.');
    }
  }
}

report({
  mirrored: result.applied,
  present: result.existed,
  mirror: result.failures.length ? 'partial' : 'ok',
});

/* Failures are reported and the step goes red, but nothing is retried here: the
   same records are re-offered on the next run anyway, and a retry loop against a
   permissions error would just take longer to tell us the same thing. */
if (result.failures.length) process.exit(1);
