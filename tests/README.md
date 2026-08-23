# Prediq tests

No framework, no `npm install`, no dependencies. Plain Node ES modules that
import the real files in `../assets/` and read the real `.html` and `.css`.

```
node tests/run.mjs            # everything
node tests/run.mjs -v         # everything, printing each assertion
node tests/run.mjs r1 m4      # only those suites
```

Exit code is 0 if every assertion passed, 1 otherwise. Nothing here is served to
visitors — no page links to this folder.

## What each suite guards

| Suite | Seam | Guards |
|---|---|---|
| `t3` | `api.js` parsers | American-odds conversion, overround removal, standings and results parsing against the exact shapes ESPN returns |
| `t4` | `api.js` calendar | season labelling and the month list, including the June off-season boundary |
| `m1` | `model.js` | Poisson matrix sums to 1, truncation at 9 goals, largest-remainder rounding to exactly 100 |
| `m2` | `model.js` | attack/defence fitting, the 1.00 divisional average, recency weighting, the last-season prior |
| `m3` | `model.js` | the cross-league quality identity — that `q` and the global mean cancel exactly |
| `m4` | `model.js` | refusal messages: when the model declines, and that it never blames the teams for a network error |
| `p1` | `model.js` | power ratings as expected points per game, and the exact `xPoints` identity |
| `rec1` | `record.js` | the frozen prediction: what it refuses to write, that it survives JSON unchanged, hand-computed log loss and Brier, and that no judgement is ever stored |
| `l1` | `api.js` loader | phase 1 reads fixtures only, phase 2 never asks a cup for a table, the two compose to `loadAll`, the history cap bounds a cold visit for every month of a season, the progress bar is sized once and ends full |
| `r1` | `render.js` | the match card on a hand-rolled DOM shim: no `innerHTML` anywhere, the form strip, the confidence meter, that the list does not reorganise between the two phases, and that every class emitted is styled |
| `rt1` | `table.js` | the ratings table on the same shim, including header/body column-class agreement |
| `v1` | `ledger.js`, `record.html` | **the record page.** That every verdict is derived, not read — the suite recomputes each one from the raw probabilities and goals, then rewrites a stored score and demands the mark move. That a prediction with no result yet is still on the page. That no rate appears before `MIN_FOR_RATE` and the denominator is settled matches. That a day key renders as the same calendar date at UTC−7 and UTC+14, checked in a child process per timezone |
| `e1` | `main.js` | the whole page end to end with `fetch` and `localStorage` mocked: request count, cache behaviour, a second visit, one league failing. Also the day tabs — that they partition the window with nothing hidden or double-counted, that the day survives into the URL, and that a link or bookmark carrying `?day=` opens on it, checked by re-running the suite as a child process |
| `h1` | all four pages, `style.css`, `SETUP.md` | every `data-cfg` number on the page against `config.js`, in both directions — the page cannot claim a value the code does not hold, and a setting cannot be added to `config.js` without being explained. Also that the honesty commitments are all still present, that local links exist, and that animations have keyframes and are switched off under `prefers-reduced-motion`. And the setup guide against the programs it describes: every log line it tells the reader to look for is a string those programs still print, every flag it tells them to type is still parsed, and the numbers it states in its own voice are `FREEZE_WITHIN_HOURS`, `MODEL_REV` and the cron . And the fixed bar: with no build step it is four hand-written copies, so the suite strips the current-page marker and demands the four be byte-identical, then checks the things that would look fine and not be — that each page marks itself and only itself, that `.nav-i` still sets `fill: none` without which every icon fills black, that the labels are hidden by clipping and never `display: none` since the icons are `aria-hidden` and the label is the whole accessible name, and that `.shell` reserves the bar height by deriving it from `--bar-h` rather than repeating the number |
| `w1` | `store.js`, `tools/freeze.mjs`, `tools/settle.mjs` | **the archive.** That a prediction is written once and never rewritten, that a result is the only thing that can be added later, that a second run leaves every byte identical, and that a day nothing settled reports `null` rather than a flattering zero. Runs both writers as child processes against a fake ESPN |
| `f1` | `tools/firestore.mjs`, `tools/mirror.mjs` | the Firestore mirror: a real frozen record round-tripping through the value encoder, the `exists: false` precondition that stops a prediction being overwritten, the `updateMask` that stops a result write touching anything else, and a service account from the wrong project being refused |

## Conventions worth keeping

Each suite runs in its own process. They install conflicting fake globals —
`fetch`, `localStorage`, a hand-rolled DOM — so sharing one process would let one
suite's shims leak into another's, and a suite that passes only because a
neighbour ran first is worse than no suite at all. `run.mjs` also reports a
non-zero exit with zero failures as `CRASHED`, because a suite that dies before
its first assertion would otherwise read as a pass.

Paths resolve from `import.meta.url`, never from an absolute path. `import()`
takes `new URL('../assets/js/', import.meta.url).href`; `fs` takes a URL
*object*, since `readFileSync` rejects a `file://` string.

A test that a sort happened needs a second assertion that the input was unsorted.
`v1`'s first run passed its kickoff-order check against a list that `predictAll`
had already sorted, so the assertion was true without the sort existing. The
guard is cheap and it caught this on the first run; keep writing it.

The same rule, generalised: **an assertion that a value does not change needs a
second assertion that the hard case was reached.** Two examples, both caught by
deliberately breaking the code and finding the suite still green.

`e1` checks that "matches fitted" stays constant as the day tabs are clicked,
which is the page's claim that the model is fitted over every league regardless of
what is on screen. Computing that figure from only the leagues *visible* — the
obvious wrong way to write it — passed, because the mock happened to put every
league on every day. One league now plays nothing on the second day, and a further
assertion states that at least one day is short of a division, so the constancy
check cannot go vacuous again.

`v1` checks a day key renders as the same calendar date across six timezones,
including the DST rounding. Only `Europe/London` actually changed its clocks on
the dates being tested, so five of the six zones were asserting nothing while the
labels claimed otherwise. The suite now also reports the measured length of each
transition day and asserts that some zone saw 23 hours and some saw 25 — if a
future edit picks dates on which nothing transitions, that fails rather than
quietly passing.

Where a suite depends on the wall clock, pin it. `e1` derived its fixture times
from `Date.now()`, which put its +3h and +6h fixtures on the same calendar day for
most of the day and on two different days after 21:00 local — so the day-tab
assertions tested a different shape depending on when they ran. It now pins 09:00
local, and passes the same instant to its child process so both place their
fixtures on the same days.

Documentation that quotes program output is code, and drifts like code. `h1` holds
`SETUP.md`'s quoted log lines against the files that print them, and caught this on
its first run: the troubleshooting section had been written with an invented error
message, while the mirror was printing a perfectly good diagnosis of its own that
the guide never mentioned. A reader would have searched the log for a string that
was never in it. Where a guide tells someone what they'll see, assert the program
still says it — and prefer quoting the real line to paraphrasing it.

A grep for a forbidden API has to strip comments first. `v1` asserted that
`ledger.js` contains no `innerHTML` and failed on the file's own header comment
saying it never uses `innerHTML` — an assertion whose easiest fix is deleting the
documentation is worse than no assertion. Where the property can be observed on
the rendered tree instead, as in `r1`, prefer that.

Mocks freeze their clock at module load. A mock that stamps dates with
`Date.now()` at call time makes two identical runs differ by a millisecond, which
silently defeats any byte-for-byte comparison.

Every assertion prints a line starting `  pass  ` or `  FAIL  `, because that is
what `run.mjs` counts. A suite that only prints its passes under `-v` reports "0
assertions, ok" — which run.mjs's own comments call the one verdict a test runner
must never invent. `f1` did exactly this on its first run.

Never hand-write a data shape that a real module produces. `f1`'s first draft
hand-fed a `prediction` object to `freeze()` and got nothing back, because the
real shape puts `home` at the top level, makes `lambda` a `{home, away}` object
rather than an array, and requires `teams.home.matches`. Build the input with the
producing code — `M.predictAll(data)` — and a shape change breaks the suite
instead of hiding in it.

Mock data is built from the shapes the browser diagnostics actually returned, and
where one module feeds another the mock is generated by the producing code rather
than hand-written — otherwise a seam bug survives the test that was meant to
catch it.

A failing assertion is not automatically a bug in `assets/`. Several have been
wrong tests: an across-league comparison made on the own-league scale, an
identity that only holds at even odds, a word table that stopped at "ten". Check
the assertion before editing the code, and when the assertion was too loose,
replace it with the exact invariant rather than widening the tolerance.

Keep one assertion per invariant, in one suite. The nav was checked in two places
and the weaker check was the one that broke: `v1` matched `<nav class="nav">`
literally, so adding an `aria-label` to that element failed a suite about the
record page. Worse is the quiet version — had the regex been looser it would have
gone on passing while `h1` did the real work, and nobody would have known which
copy was load-bearing. When a check outgrows its suite, move it and leave a
comment saying where it went.

An assertion written and passed on its first run has proved nothing yet. Break the
code sixteen ways and confirm each break names itself: that is how the vacuous
version of the narrow-screen check was found, which compared a rule's position
against the position of an `@media` line and so passed for a rule sitting outside
the query entirely. Match braces, don't compare offsets.

When breaking code to test a guard, read the exit code and not just the `FAIL`
lines. Twice during the run above a breakage left an unbalanced parenthesis, the
suite died on import before its first assertion, and zero failures looked exactly
like a passing guard — which is the same trap `run.mjs` already guards against by
treating a non-zero exit with no failures as CRASHED. A breakage must be valid
code that is wrong, not code that will not parse.
