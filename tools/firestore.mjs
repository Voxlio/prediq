/* =============================================================================
   tools/firestore.mjs — a Firestore client in about two hundred lines and no
   dependencies.

   Prediq installs nothing. That rules out firebase-admin, so this talks to the
   Firestore REST API directly: sign a JWT with the service account's private key,
   swap it for an access token, then POST documents. Node 20 has everything
   needed — `node:crypto` signs, global `fetch` sends.

   That is not a hardship in this case. The whole surface we need is "create a
   document if it does not exist" and "fill in one field of a document that
   does", which the REST API expresses more precisely than the SDK does.

   THE SEAM: `firestore()` takes its `fetch` and its clock as arguments. The tests
   pass fakes and never touch the network, and mirror.mjs passes the real ones.
   ========================================================================== */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const API = 'https://firestore.googleapis.com/v1';

/* Non-atomic batch. `:commit` would roll the whole batch back if one write
   failed, and one write failing is the NORMAL case here — see the precondition
   on create below. `:batchWrite` reports per-write status instead, which is the
   difference between "this record was already mirrored" and "the whole run
   broke". Google's documented ceiling is 500 writes per request. */
const BATCH_LIMIT = 500;

/* --- credentials -------------------------------------------------------------
   The service account JSON, straight out of the environment. Absent means the
   mirror is switched off, which is a supported state and not an error: data/ in
   the repository is the archive, and this is a copy of it.
-------------------------------------------------------------------------------*/
export function readCredentials(env = process.env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (err) {
    /* Worth a specific message. The usual cause is the secret being pasted with
       the surrounding quotes, or a shell having eaten the newlines in the
       private key, and "Unexpected token" alone sends you looking in the wrong
       place. */
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (' + err.message +
      '). Paste the whole downloaded file, braces included, with nothing added.');
  }

  for (const field of ['client_email', 'private_key', 'project_id']) {
    if (!sa[field]) throw new Error('service account JSON has no ' + field);
  }
  if (!/BEGIN PRIVATE KEY/.test(sa.private_key)) {
    throw new Error('service account private_key does not look like a PEM key');
  }
  return sa;
}

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* --- the access token --------------------------------------------------------
   A self-signed JWT, exchanged for a bearer token. Cached for the life of the
   process: a mirror run takes seconds and tokens last an hour, so asking twice
   would be pure waste.
-------------------------------------------------------------------------------*/
export function signAssertion(sa, now) {
  const iat = Math.floor(+now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(body).sign(sa.private_key);
  return body + '.' + b64url(sig);
}

/* --- JS values to Firestore values -------------------------------------------
   Firestore stores typed values, so `{ n: 3 }` goes over the wire as
   `{ n: { integerValue: "3" } }`. Encoding by hand rather than reaching for a
   library, and the tests round-trip a real frozen record through both directions
   so a field the encoder mangles cannot pass unnoticed.

   Integers and doubles are distinct types, so `1` and `1.0` are not
   interchangeable — which matters because a scoreline of [1, 1] must not come
   back as [1.0, 1.0] and a probability of exactly 0 must not come back as an
   integer. `Number.isInteger` decides, and decode reverses it.
-------------------------------------------------------------------------------*/
export function encode(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot store ' + value + ' in Firestore');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    /* Firestore cannot nest an array directly inside an array. Nothing in a
       record does, but a future field might, and a silent truncation would be
       far worse than a refusal. */
    for (const v of value) {
      if (Array.isArray(v)) throw new Error('Firestore cannot store an array of arrays');
    }
    return { arrayValue: value.length ? { values: value.map(encode) } : {} };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;   /* absent and null are different facts */
      fields[k] = encode(v);
    }
    return { mapValue: Object.keys(fields).length ? { fields } : {} };
  }
  throw new Error('cannot encode ' + typeof value);
}

export function decode(v) {
  if (!v || typeof v !== 'object') throw new Error('not a Firestore value');
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, x] of Object.entries(v.mapValue.fields ?? {})) out[k] = decode(x);
    return out;
  }
  throw new Error('unknown Firestore value type: ' + Object.keys(v).join(','));
}

/* --- document ids ------------------------------------------------------------
   `{day}__{eventId}`, not the event id alone.

   A postponed fixture is recorded again under its new kickoff day, so the same
   event id legitimately appears in two day files (store.js keeps both: we did
   claim the first one, and deleting it would be rewriting history). Keying on the
   event id alone would make the replayed match overwrite the abandoned claim —
   quietly losing the record of a prediction we actually published.

   The day is still a field on the document, so this costs nothing in queries.
-------------------------------------------------------------------------------*/
export function docId(day, id) {
  const safe = String(id).replace(/[/]/g, '_');
  return day + '__' + safe;
}

export function firestore({ credentials, fetch: doFetch = globalThis.fetch, now = () => new Date() }) {
  const sa = credentials;
  const project = sa.project_id;
  const docPath = '/projects/' + project + '/databases/(default)/documents';
  let token = null;

  async function bearer() {
    if (token) return token;
    const res = await doFetch(sa.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(sa, now()),
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      /* The two failures worth naming, because the fix differs completely: a
         clock more than five minutes off makes a valid key look invalid, and a
         disabled or deleted service account looks identical to a typo. */
      throw new Error('could not get an access token (' + res.status + '): ' +
        (body.error_description || body.error || 'no detail') +
        '. If this says invalid_grant, check the service account still exists.');
    }
    token = body.access_token;
    return token;
  }

  async function batchWrite(writes) {
    if (!writes.length) return { applied: 0, existed: 0, failures: [] };
    const auth = await bearer();
    let applied = 0, existed = 0;
    const failures = [];

    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
      const chunk = writes.slice(i, i + BATCH_LIMIT);
      const res = await doFetch(API + '/' + docPath + ':batchWrite', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
        body: JSON.stringify({ writes: chunk.map(w => w.write) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error('batchWrite failed (' + res.status + '): ' +
          (body.error?.message || 'no detail'));
      }

      /* status[] runs parallel to writes[]. A zero or absent code means applied.
         Code 6 ALREADY_EXISTS and code 9 FAILED_PRECONDITION are both "the
         document was already there", which is the expected answer for every
         record after its first run — counted, not raised. Anything else is real:
         7 PERMISSION_DENIED means the rules or the service account are wrong and
         every subsequent run will fail the same way, so it must be visible. */
      (body.status ?? []).forEach((st, n) => {
        if (!st || !st.code) { applied++; return; }
        if (st.code === 6 || st.code === 9) { existed++; return; }
        failures.push({ id: chunk[n]?.label ?? '?', code: st.code, message: st.message || '' });
      });
    }
    return { applied, existed, failures };
  }

  return {
    project,

    /* Create only. `currentDocument.exists: false` makes the database itself
       refuse to overwrite a prediction — and unlike firestore.rules, which a
       service account bypasses, a precondition applies to admin too. This is the
       only place in the project where write-once is enforced against us rather
       than merely by us. */
    createRecord(collection, day, record) {
      return {
        label: docId(day, record.id),
        write: {
          update: {
            name: docPath + '/' + collection + '/' + docId(day, record.id),
            fields: encode({ ...record, day }).mapValue.fields,
          },
          currentDocument: { exists: false },
        },
      };
    },

    /* Fill in the result and nothing else. `updateMask` limits the write to the
       named paths, so even a caller that handed over a whole tampered record
       could not move a probability with this. The mask is the wire-level twin of
       mergeDay's rule in store.js. */
    attachResult(collection, day, record) {
      return {
        label: docId(day, record.id) + ' result',
        write: {
          update: {
            name: docPath + '/' + collection + '/' + docId(day, record.id),
            fields: encode({ result: record.result }).mapValue.fields,
          },
          updateMask: { fieldPaths: ['result'] },
          currentDocument: { exists: true },
        },
      };
    },

    /* Derived documents. These are MEANT to change on every run, so no
       precondition and no mask — a full overwrite is the correct semantics for a
       file that can be rebuilt from the records at any time. */
    putMeta(collection, id, payload) {
      return {
        label: 'meta/' + id,
        write: {
          update: {
            name: docPath + '/' + collection + '/' + id,
            fields: encode(payload).mapValue.fields,
          },
        },
      };
    },

    batchWrite,
  };
}
