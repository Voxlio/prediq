/* run.mjs — runs every suite in this folder and totals the result.
   Usage, from anywhere:  node tests/run.mjs
                          node tests/run.mjs -v      (show every assertion)
                          node tests/run.mjs r1 m4   (only those suites)

   Each suite runs in its own process on purpose. They install fake globals —
   fetch, localStorage, a hand-rolled DOM — and several of them import the same
   modules with different mocks in place. Sharing one process would let one
   suite's shims leak into another's, and a suite that passes only because a
   neighbour ran first is worse than no suite at all.

   There is no npm install and no test framework. Every suite is plain Node with
   its own two-line `ok()` helper, and reads the real files in ../assets/. */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const here = new URL('./', import.meta.url);
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const only = args.filter(a => !a.startsWith('-'));

/* A suite is named letters-then-digits: r1, rec1, m4. Anything else in this
   folder is scaffolding — mock-espn.mjs is a preload for the writer scripts, not
   a suite, and running it would report "0 assertions, ok", which is the one
   verdict a test runner must never invent. The convention does the excluding, so
   the next helper added here needs no change made to this file. */
const SUITE = /^[a-z]+\d+\.mjs$/;

const suites = readdirSync(here)
  .filter(f => SUITE.test(f))
  .filter(f => !only.length || only.includes(f) || only.includes(f.replace('.mjs', '')))
  .sort();

if (!suites.length) {
  console.error('no suites matched ' + only.join(' '));
  process.exit(2);
}

let assertions = 0, failures = 0, broken = 0;
const started = Date.now();

for (const name of suites) {
  const r = spawnSync(process.execPath, [new URL(name, here).pathname], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  const passed = lines.filter(l => l.startsWith('  pass  ')).length;
  const failed = lines.filter(l => l.startsWith('  FAIL  ')).length;
  assertions += passed + failed;
  failures += failed;

  /* A suite that crashes before its first assertion reports zero failures and
     would otherwise look like a pass. Exit code is the only honest signal. */
  const crashed = r.status !== 0 && failed === 0;
  if (crashed) broken++;

  const verdict = crashed ? 'CRASHED' : failed ? failed + ' FAILED' : 'ok';
  console.log(
    name.replace('.mjs', '').padEnd(6) +
    String(passed + failed).padStart(5) + ' assertions   ' + verdict
  );

  if (verbose) console.log(out.replace(/^/gm, '    '));
  else if (failed) {
    /* The failing label plus the value it actually got — the two lines that
       matter — without the hundreds of passes around them. */
    lines.forEach((l, i) => {
      if (l.startsWith('  FAIL  ')) {
        console.log('    ' + l.trim());
        if ((lines[i + 1] || '').includes('got:')) console.log('    ' + lines[i + 1].trim());
      }
    });
  } else if (crashed) {
    console.log(out.trim().split('\n').slice(-12).map(l => '    ' + l).join('\n'));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('─'.repeat(46));
console.log(
  assertions + ' assertions in ' + suites.length + ' suites, ' + secs + 's — ' +
  (failures || broken
    ? failures + ' failing' + (broken ? ', ' + broken + ' crashed' : '')
    : 'all passed')
);
process.exit(failures || broken ? 1 : 0);
