/* =============================================================================
   assets/js/firebase-config.js — the Firebase project Prediq mirrors its archive
   into.

   THIS FILE IS PUBLIC AND THAT IS CORRECT.

   Every value here is visible to anyone who opens the site and reads the
   JavaScript. That is how Firebase web config works: it identifies the project,
   it does not authorise anything. `apiKey` is a project identifier despite the
   name — it is not a password, it cannot be used to sign in, and rotating it
   would achieve nothing.

   What actually protects the data is firestore.rules, which makes the archive
   readable by everyone and writable by nobody. If those rules are wrong, hiding
   this file would not help; if they are right, publishing it costs nothing.

   The thing that must NEVER appear in this repository is a service-account key —
   a JSON file with a `private_key` field. That one really is a credential, it
   grants admin access, and it bypasses the security rules entirely. It lives in
   the repository's Actions secrets and is read by tools/mirror.mjs from the
   environment.
   ========================================================================== */

export const FIREBASE = {
  apiKey: 'AIzaSyDvBt5SqKeUegayxQKy37J-3a6LVL9bYDA',
  authDomain: 'prediq-b5690.firebaseapp.com',
  projectId: 'prediq-b5690',
  storageBucket: 'prediq-b5690.firebasestorage.app',
  messagingSenderId: '844495060731',
  appId: '1:844495060731:web:b9fa86a7f13efb5808fa5e',
  measurementId: 'G-NTJF9PT6EF',
};

/* --- the archive: written by the mirror, read from the repository ------------
   The browser reads NO prediction from Firestore. The archive is served as
   static JSON from data/ in this repository, which is faster than a Firestore
   query, costs nothing, has no daily quota to exhaust, and is the copy whose
   history can be audited.

   Firestore earns its place there later, when the archive is large enough that
   answering "what is our record on home favourites in the Premier League?" by
   downloading every day file becomes silly. That is a query Firestore can do and
   a directory of static files cannot.

   Until then these constants exist so the mirror and the eventual read path agree
   about which project they mean, and so nobody has to go and find it again.
-------------------------------------------------------------------------------*/
export const FIRESTORE_COLLECTION = 'predictions';
export const FIRESTORE_META = 'meta';

/* --- the visitor counter: the one thing the browser does write ---------------
   assets/js/vitals.js increments two documents in this collection on each page
   load — a running total and one per UTC day — and shows the total in the footer.
   That is the only write any browser is permitted to make, it holds a single
   integer, and firestore.rules constrains it to adding exactly one.

   Separate from `meta` rather than a third document inside it, because the two
   have opposite rules: everything in `meta` is written only by the service
   account and refused to browsers outright, and mixing a browser-writable
   document in among them would mean the rule for the collection could no longer
   simply say `write: if false`. A collection whose access rule needs an
   exception is a collection waiting for the exception to be widened.

   The daily documents are not published anywhere. They exist so traffic over
   time can be read in the Firebase console, and their rules allow writing them
   without allowing reading them.
-------------------------------------------------------------------------------*/
export const FIRESTORE_VIEWS = 'views';
export const FIRESTORE_VIEWS_TOTAL = 'total';
