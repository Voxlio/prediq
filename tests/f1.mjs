/* =============================================================================
   f1.mjs — the Firestore mirror: encoding, the write plan, and the driver run end
   to end against a fake Firestore.

   Two things here are worth more than the rest.

   The ENCODER, because it is the only place a record changes shape. A field the
   encoder mangles would reach Firestore silently wrong, and no other test in the
   project looks at Firestore. So it is round-tripped through a record produced by
   the real record.js rather than one written by hand — the lesson from t3/l1,
   where a hand-fed shape hid a seam bug for a whole session.

   The WRITE PLAN, because a mirror that could overwrite a prediction would defeat
   the archive from the other end. store.js protects the repository copy; only the
   exists:false precondition and the updateMask protect the Firestore copy, and a
   precondition is the one guard a service account cannot bypass.

   Nothing here touches the network. `firestore()` takes its fetch as an argument.
   ========================================================================== */

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = new URL('../assets/js/', import.meta.url).href;
const toolsBase = new URL('../tools/', import.meta.url).href;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const F = await import(toolsBase + 'firestore.mjs');
const R = await import(base + 'record.js');
const M = await import(base + 'model.js');
const { MODEL_REV, LEAGUES } = await import(base + 'config.js');

/* The house format: run.mjs counts lines beginning "  pass  " and "  FAIL  ", so
   passes are always printed rather than hidden behind -v. The first draft of this
   file printed "  ok" under -v only, and run.mjs duly reported "f1  0 assertions
   ok" — which is precisely the verdict its own comments say a runner must never
   invent. It was right and the suite was wrong. */
let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  console.log((cond ? '  pass  ' : '  FAIL  ') + what +
    (cond ? '' : '\n          got: ' + JSON.stringify(detail)));
  if (cond) pass++; else fail++;
};
const section = t => console.log('\n' + t);

/* --- a real record, not an imagined one -------------------------------------
   The first draft of this file hand-wrote a `prediction` object and fed it to
   freeze(), which returned nothing: the shape was wrong in half a dozen places
   (`home` is top-level, not under `fixture`; `lambda` is `{home, away}` not an
   array; `teams.home.matches` is required). That is lesson 1 in tests/README —
   never hand-feed a shape a real module produces — and it cost the same twenty
   minutes here that it cost in t3.

   So the record comes from M.predictAll(), the same producer main.js uses, over
   the same Premier League data the model suites run on. If model.js changes the
   shape of a prediction, this suite finds out.
--------------------------------------------------------------------------- */
const T0 = new Date('2026-08-24T09:00:00.000Z');
const NOW = T0;

const PREV = [
  ['1','Liverpool',86,41], ['2','Arsenal',69,34], ['3','Man City',72,44], ['4','Chelsea',64,43],
  ['5','Newcastle',68,47], ['6','Aston Villa',58,51], ['7','Nottm Forest',58,46], ['8','Brighton',66,59],
  ['9','Bournemouth',58,46], ['10','Brentford',66,57], ['11','Fulham',54,54], ['12','Crystal Palace',51,51],
  ['13','Everton',42,44], ['14','West Ham',46,62], ['15','Man United',44,54], ['16','Wolves',54,69],
  ['17','Tottenham',64,65], ['18','Leicester',33,80], ['19','Ipswich',36,82], ['20','Southampton',26,86],
].map(([id, name, gf, ga]) => ({ id, name, short: name, gp: 38, gf, ga, rank: +id }));

const STANDINGS = PREV.slice(0, 17).map(t => ({ ...t, gp: 6, gf: 9, ga: 8 }))
  .concat([['21','Leeds'], ['22','Burnley'], ['23','Sunderland']]
    .map(([id, name]) => ({ id, name, short: name, gp: 6, gf: 5, ga: 11, rank: null })));

const RES = (h, a, hg, ag, date) => ({
  date, home: { id: h, name: '', g: hg }, away: { id: a, name: '', g: ag },
});
const RESULTS = [
  RES('2','12',3,0,'2026-08-15'), RES('1','21',2,1,'2026-08-15'), RES('4','22',1,1,'2026-08-16'),
  RES('3','23',4,0,'2026-08-16'), RES('5','13',2,2,'2026-08-16'), RES('15','8',0,2,'2026-08-17'),
];

const nameOf = id => (STANDINGS.find(t => t.id === id) || { name: 'Unknown FC' }).name;
const FX = (id, h, a, hoursOut, odds = null) => ({
  id, leagueSlug: 'eng.1', date: new Date(+T0 + hoursOut * 3600e3).toISOString(), venue: null,
  home: { id: h, name: nameOf(h), short: '', form: null },
  away: { id: a, name: nameOf(a), short: '', form: null },
  odds,
});

const data = {
  season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: +T0,
  fixtures: [
    /* Priced, so the record carries a market leg — the encoder must handle it. */
    FX('704311', '2', '1', 5, { home: 0.40, draw: 0.28, away: 0.32,
                                overround: 1.06, overUnder: 2.5, provider: 'DraftKings' }),
    /* Unpriced, so `market` is null — a different encoder path entirely. */
    FX('704312', '11', '12', 8),
  ],
  byLeague: { 'eng.1': { standingsNow: STANDINGS, standingsPrev: PREV, results: RESULTS } },
};
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) {
  data.byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
}
const { predictions } = M.predictAll(data);
const byId = id => predictions.find(p => p.fixture.id === id);

const frozen = R.freeze(byId('704311'), NOW).record;
const unpriced = R.freeze(byId('704312'), NOW).record;

section('the record we are encoding is real');
ok('freeze() produced a record', !!frozen, R.freeze(byId('704311'), NOW).skip);
ok('it carries a market leg', !!frozen?.market, frozen?.market);
ok('it carries a model fingerprint', !!frozen?.model?.hash, frozen?.model);
ok('it has a result key, set to null', frozen?.result === null, frozen?.result);
ok('the unpriced one has a null market rather than none',
  unpriced?.market === null && 'market' in unpriced, unpriced?.market);


/* --- encoding ------------------------------------------------------------- */
section('encode / decode round-trips');

const round = v => F.decode(F.encode(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok('the whole frozen record survives a round trip', same(round(frozen), frozen),
  { got: round(frozen), want: frozen });

const settledRec = R.attachResult(frozen, { home: 2, away: 1, at: new Date('2026-08-24T16:05:00.000Z') }).record;
ok('a settled record survives too', same(round(settledRec), settledRec), round(settledRec));
ok('and the settled one really does have a result', !!settledRec?.result, settledRec?.result);

section('the types that are easy to get wrong');
ok('an integer stays an integer', F.encode(1).integerValue === '1', F.encode(1));
ok('a float stays a float', F.encode(1.5).doubleValue === 1.5, F.encode(1.5));
ok('zero is an integer, not absent', F.encode(0).integerValue === '0', F.encode(0));
ok('0.0 round-trips as 0 and not as null', round(0) === 0, round(0));
ok('a whole-number probability of 1 comes back as 1', round(1) === 1, round(1));
ok('null is distinct from absent', F.encode(null).nullValue === null, F.encode(null));
ok('an absent key stays absent', !('x' in round({ a: 1, x: undefined })), round({ a: 1, x: undefined }));
ok('an empty array survives', same(round([]), []), round([]));
ok('an empty object survives', same(round({}), {}), round({}));
ok('a scoreline of [1,1] does not become floats',
  same(F.encode([1, 1]).arrayValue.values.map(v => v.integerValue), ['1', '1']),
  F.encode([1, 1]));
ok('a nested probability array round-trips exactly',
  same(round(frozen.predicted.probs), frozen.predicted.probs), round(frozen.predicted.probs));
ok('the probabilities are real numbers, so the check above is not vacuous',
  Array.isArray(frozen.predicted.probs) && frozen.predicted.probs.length === 3,
  frozen.predicted.probs);

section('and the values it must refuse rather than mangle');
const refuses = (what, fn) => { try { fn(); ok(what, false, 'no error thrown'); } catch { ok(what, true); } };
refuses('NaN is refused', () => F.encode(NaN));
refuses('Infinity is refused', () => F.encode(Infinity));
refuses('an array of arrays is refused', () => F.encode([[1], [2]]));
refuses('a function is refused', () => F.encode(() => 1));

/* --- credentials ---------------------------------------------------------- */
section('credentials');
ok('no env var means the mirror is off, not broken',
  F.readCredentials({}) === null, F.readCredentials({}));
ok('an empty env var also means off',
  F.readCredentials({ FIREBASE_SERVICE_ACCOUNT: '   ' }) === null);
refuses('malformed JSON is refused', () => F.readCredentials({ FIREBASE_SERVICE_ACCOUNT: '{oops' }));
refuses('JSON with no private_key is refused',
  () => F.readCredentials({ FIREBASE_SERVICE_ACCOUNT: '{"client_email":"a@b","project_id":"p"}' }));
refuses('a private_key that is not a PEM is refused',
  () => F.readCredentials({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(
    { client_email: 'a@b', project_id: 'p', private_key: 'hunter2' }) }));

/* A real RSA key, generated here. Signing against a fake key would prove only
   that the code calls createSign; verifying the signature proves the assertion a
   real Google endpoint would receive is well-formed. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SA = {
  client_email: 'prediq-archive@prediq-b5690.iam.gserviceaccount.com',
  project_id: 'prediq-b5690',
  private_key: privateKey,
};

section('the JWT we would send to Google');
const jwt = F.signAssertion(SA, new Date('2026-08-24T09:00:00.000Z'));
const [h, c, s] = jwt.split('.');
const unb64 = x => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
ok('three dot-separated parts', jwt.split('.').length === 3);
ok('signed RS256', unb64(h).alg === 'RS256', unb64(h));
ok('issued by the service account', unb64(c).iss === SA.client_email, unb64(c));
ok('scoped to datastore', /datastore/.test(unb64(c).scope), unb64(c).scope);
ok('expires an hour after the clock it was given',
  unb64(c).exp - unb64(c).iat === 3600, unb64(c));
ok('iat comes from the clock passed in, not the wall clock',
  unb64(c).iat === Math.floor(+new Date('2026-08-24T09:00:00.000Z') / 1000), unb64(c).iat);
ok('the signature actually verifies against the public key',
  createVerify('RSA-SHA256').update(h + '.' + c)
    .verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
ok('no base64 padding survives into the token', !jwt.includes('='), jwt.slice(-8));

/* --- the write plan ------------------------------------------------------- */
section('document ids');
ok('a record is keyed by day and event id',
  F.docId('2026-08-24', '704311') === '2026-08-24__704311', F.docId('2026-08-24', '704311'));
ok('a postponed match replayed on another day gets a different document',
  F.docId('2026-09-14', '704311') !== F.docId('2026-08-24', '704311'));
ok('a slug-shaped id survives', F.docId('2026-08-24', 'eng.1-fx') === '2026-08-24__eng.1-fx');
ok('a slash cannot escape into a subcollection path',
  !F.docId('2026-08-24', 'a/b').includes('/'), F.docId('2026-08-24', 'a/b'));
ok('the id never starts with the reserved __ prefix',
  !F.docId('2026-08-24', 'x').startsWith('__'));

/* A fake fetch that records what it was asked to do and answers as Firestore
   would. The log is the assertion target: what we SEND is the whole of what
   Firestore is allowed to do. */
function fakeDb({ statuses = null, tokenFails = false, httpFails = false } = {}) {
  const calls = [];
  const doFetch = async (url, opts) => {
    calls.push({ url, body: opts.body, headers: opts.headers });
    if (url.includes('oauth2')) {
      if (tokenFails) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'stale clock' }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 3599 }) };
    }
    if (httpFails) {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'backend unavailable' } }) };
    }
    const sent = JSON.parse(opts.body).writes;
    return {
      ok: true, status: 200,
      json: async () => ({
        writeResults: sent.map(() => ({})),
        status: statuses ? statuses(sent) : sent.map(() => ({})),
      }),
    };
  };
  return { db: F.firestore({ credentials: SA, fetch: doFetch, now: () => NOW }), calls };
}

section('a prediction can only ever be created, never overwritten');
{
  const { db } = fakeDb();
  const w = db.createRecord('predictions', '2026-08-24', frozen);
  ok('the create carries an exists:false precondition',
    w.write.currentDocument?.exists === false, w.write.currentDocument);
  ok('it has no updateMask, so it writes the whole document',
    !w.write.updateMask, w.write.updateMask);
  ok('the document path is under the predictions collection',
    w.write.update.name.includes('/documents/predictions/2026-08-24__704311'),
    w.write.update.name);
  ok('the path names the project from the service account',
    w.write.update.name.includes('/projects/prediq-b5690/'), w.write.update.name);
  ok('the day is stored as a field as well as in the id',
    w.write.update.fields.day.stringValue === '2026-08-24', w.write.update.fields.day);
  ok('the probabilities are in the document',
    same(F.decode({ mapValue: { fields: w.write.update.fields } }).predicted.probs,
         frozen.predicted.probs),
    F.decode({ mapValue: { fields: w.write.update.fields } }).predicted?.probs);
}

section('attaching a result cannot move anything else');
{
  const { db } = fakeDb();
  const w = db.attachResult('predictions', '2026-08-24', settledRec);
  ok('the update is masked to result alone',
    same(w.write.updateMask.fieldPaths, ['result']), w.write.updateMask);
  ok('the payload contains only result',
    same(Object.keys(w.write.update.fields), ['result']), Object.keys(w.write.update.fields));
  ok('it requires the document to already exist',
    w.write.currentDocument?.exists === true, w.write.currentDocument);

  /* The point of the mask: even handed a record whose probabilities have been
     tampered with, this write cannot carry them. Tampering with `predicted`
     rather than inventing a top-level key, so the test exercises the shape the
     archive really has. */
  const tampered = {
    ...settledRec,
    predicted: { ...settledRec.predicted, probs: [0.99, 0.005, 0.005] },
  };
  const t = db.attachResult('predictions', '2026-08-24', tampered);
  ok('a tampered record produces a write with no predicted block in it',
    !('predicted' in t.write.update.fields), Object.keys(t.write.update.fields));
  ok('and the mask still names only result',
    same(t.write.updateMask.fieldPaths, ['result']));
  ok('the tampering was real, so that check means something',
    tampered.predicted.probs[0] === 0.99 &&
    settledRec.predicted.probs[0] !== 0.99, settledRec.predicted.probs);
}

section('derived documents are meant to change, so they overwrite');
{
  const { db } = fakeDb();
  const w = db.putMeta('meta', 'summary', { at: NOW.toISOString(), n: 12 });
  ok('no precondition', !w.write.currentDocument, w.write.currentDocument);
  ok('no mask', !w.write.updateMask, w.write.updateMask);
  ok('written to the meta collection', w.write.update.name.endsWith('/meta/summary'), w.write.update.name);
}

section('what the batch does with each answer Firestore can give');
{
  const { db, calls } = fakeDb();
  const res = await db.batchWrite([
    db.createRecord('predictions', '2026-08-24', frozen),
    db.attachResult('predictions', '2026-08-24', settledRec),
  ]);
  ok('all applied when Firestore reports no status codes', res.applied === 2, res);
  ok('nothing counted as pre-existing', res.existed === 0, res);
  ok('no failures', res.failures.length === 0, res.failures);
  ok('a token was fetched before the write', calls[0].url.includes('oauth2'), calls[0].url);
  ok('the write went to :batchWrite, not :commit',
    calls[1].url.endsWith(':batchWrite'), calls[1].url);
  ok('the bearer token was attached',
    calls[1].headers.authorization === 'Bearer tok-123', calls[1].headers);
  ok('the token is fetched once, not per batch',
    calls.filter(c => c.url.includes('oauth2')).length === 1);
}
{
  /* The normal steady state: every record already mirrored, so every create is
     refused by its precondition. This must read as "nothing to do", not as an
     outage. */
  const { db } = fakeDb({ statuses: sent => sent.map(() => ({ code: 9, message: 'precondition failed' })) });
  const res = await db.batchWrite([db.createRecord('predictions', '2026-08-24', frozen)]);
  ok('FAILED_PRECONDITION counts as already there', res.existed === 1, res);
  ok('and is not a failure', res.failures.length === 0, res.failures);
  ok('and is not counted as applied', res.applied === 0, res);
}
{
  const { db } = fakeDb({ statuses: sent => sent.map(() => ({ code: 6, message: 'already exists' })) });
  const res = await db.batchWrite([db.createRecord('predictions', '2026-08-24', frozen)]);
  ok('ALREADY_EXISTS also counts as already there', res.existed === 1, res);
}
{
  const { db } = fakeDb({ statuses: sent => sent.map(() => ({ code: 7, message: 'Missing or insufficient permissions' })) });
  const res = await db.batchWrite([db.createRecord('predictions', '2026-08-24', frozen)]);
  ok('PERMISSION_DENIED is a real failure', res.failures.length === 1, res);
  ok('and names the document it happened to',
    res.failures[0].id === '2026-08-24__704311', res.failures[0]);
  ok('and carries the code through', res.failures[0].code === 7, res.failures[0]);
}
{
  const { db } = fakeDb({ statuses: sent => sent.map((_, i) => i === 0 ? { code: 9 } : { code: 7, message: 'nope' }) });
  const res = await db.batchWrite([
    db.createRecord('predictions', '2026-08-24', frozen),
    db.attachResult('predictions', '2026-08-24', settledRec),
  ]);
  ok('a mixed batch is counted per write, not as a whole',
    res.existed === 1 && res.failures.length === 1 && res.applied === 0, res);
}
{
  const { db } = fakeDb({ tokenFails: true });
  let msg = '';
  try { await db.batchWrite([db.createRecord('predictions', '2026-08-24', frozen)]); }
  catch (err) { msg = err.message; }
  ok('a rejected token throws rather than reporting success', /access token/.test(msg), msg);
  ok('and the message repeats what Google said', /stale clock|invalid_grant/.test(msg), msg);
}
{
  const { db } = fakeDb({ httpFails: true });
  let msg = '';
  try { await db.batchWrite([db.createRecord('predictions', '2026-08-24', frozen)]); }
  catch (err) { msg = err.message; }
  ok('a 503 from Firestore throws', /batchWrite failed \(503\)/.test(msg), msg);
}
{
  const { db, calls } = fakeDb();
  const res = await db.batchWrite([]);
  ok('an empty plan sends nothing at all', calls.length === 0, calls.length);
  ok('and reports zeros', res.applied === 0 && res.existed === 0, res);
}
{
  /* 500 is Google's documented ceiling, so 501 writes must be two requests. A
     silent truncation here would drop records from the mirror and nothing would
     say so. */
  const { db, calls } = fakeDb();
  const many = Array.from({ length: 501 }, (_, i) =>
    db.createRecord('predictions', '2026-08-24', { ...frozen, id: 'x' + i }));
  const res = await db.batchWrite(many);
  const writeCalls = calls.filter(c => c.url.endsWith(':batchWrite'));
  ok('501 writes go in two requests', writeCalls.length === 2, writeCalls.length);
  ok('the first is exactly 500', JSON.parse(writeCalls[0].body).writes.length === 500);
  ok('the second is the remaining 1', JSON.parse(writeCalls[1].body).writes.length === 1);
  ok('and all 501 are accounted for', res.applied === 501, res);
}

/* --- the driver, run for real -------------------------------------------------
   mirror.mjs against a scratch archive. It cannot reach Firestore from here, so
   these check the decisions it makes BEFORE the network: is the mirror on, does
   the project match, which days are in scope, and what would be sent.
-------------------------------------------------------------------------------*/
section('mirror.mjs — the decisions it makes before sending anything');

const box = mkdtempSync(join(tmpdir(), 'prediq-mirror-'));
mkdirSync(join(box, 'data'), { recursive: true });
const write = (f, o) => writeFileSync(join(box, 'data', f), JSON.stringify(o, null, 1));

const dayFile = (day, recs) => ({ day, updatedAt: NOW.toISOString(), rev: MODEL_REV, records: recs });
write('2026-08-24.json', dayFile('2026-08-24', [frozen, settledRec]));
write('2026-06-01.json', dayFile('2026-06-01', [{ ...frozen, id: 'old-1' }]));
write('index.json', { updatedAt: NOW.toISOString(), days: ['2026-06-01', '2026-08-24'], revs: { [MODEL_REV]: 3 } });
write('summary.json', { at: NOW.toISOString(), n: 3, days: 2 });

const runMirror = (env, args = []) => {
  const r = spawnSync(process.execPath, [join('tools', 'mirror.mjs'), ...args], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, PREDIQ_ROOT: box, FIREBASE_SERVICE_ACCOUNT: '', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

{
  const r = runMirror({});
  ok('with no credentials it exits 0', r.code === 0, r.code);
  ok('and says the archive is unaffected', /archive unaffected/.test(r.out), r.out.trim());
  ok('and does not claim to have mirrored anything', !/\d+ written/.test(r.out), r.out.trim());
}
{
  const r = runMirror({ FIREBASE_SERVICE_ACCOUNT: '{"client_email":"a@b","project_id":"p","private_key":"nope"}' });
  ok('an unusable credential is a hard failure', r.code === 1, r.code);
  ok('and is described rather than thrown raw', /set but unusable/.test(r.out), r.out.trim());
}
{
  /* The mistake this catches is pasting a key from a different Firebase project:
     everything would appear to work while filling a database nobody reads. */
  const wrong = JSON.stringify({ ...SA, project_id: 'somebody-elses-project' });
  const r = runMirror({ FIREBASE_SERVICE_ACCOUNT: wrong });
  ok('a service account from the wrong project is refused', r.code === 1, r.code);
  ok('and both project names are printed',
    /somebody-elses-project/.test(r.out) && /prediq-b5690/.test(r.out), r.out.trim());
  ok('and it says it refused to write', /Refusing to write/.test(r.out), r.out.trim());
}
{
  const r = runMirror({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) }, ['--dry-run']);
  ok('a dry run exits 0', r.code === 0, r.out.trim());
  ok('the recent day is in scope', /1 of 2 days in scope/.test(r.out), r.out.trim());
  ok('June is out of scope by default', !/old-1/.test(r.out), r.out.trim());
  ok('two records, one settled', /2 records \(1 settled\)/.test(r.out), r.out.trim());
  ok('which is 3 record writes plus 2 meta', /→ 5 writes/.test(r.out), r.out.trim());
  ok('the plan lists a create', /create\s+2026-08-24__704311/.test(r.out), r.out.trim());
  ok('and a result write', /result\s+2026-08-24__704311 result/.test(r.out), r.out.trim());
  ok('and an overwrite for the derived docs', /overwrite\s+meta\/index/.test(r.out), r.out.trim());
  ok('and it sent nothing', /nothing sent \(dry run\)/.test(r.out), r.out.trim());
}
{
  const r = runMirror({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) }, ['--dry-run', '--all']);
  ok('--all widens the scope to every day', /2 of 2 days in scope/.test(r.out), r.out.trim());
  ok('and picks up the June record', /old-1/.test(r.out), r.out.trim());
  ok('3 records now', /3 records \(1 settled\)/.test(r.out), r.out.trim());
}
{
  /* An empty archive is not a failure. A fork of Prediq with a Firebase project
     and no predictions yet should say so and stop. */
  const empty = mkdtempSync(join(tmpdir(), 'prediq-empty-'));
  mkdirSync(join(empty, 'data'), { recursive: true });
  const r = spawnSync(process.execPath, [join('tools', 'mirror.mjs')], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, PREDIQ_ROOT: empty, FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) },
  });
  ok('an empty archive exits 0', r.status === 0, r.status);
  ok('and says so', /archive is empty/.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim());
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
