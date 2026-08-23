# The archive

Every prediction Prediq has ever published, written down before the match, plus
what actually happened.

Nothing in this directory is edited by hand. It is written by
`.github/workflows/predictions.yml`, which runs `tools/freeze.mjs` and
`tools/settle.mjs` every three hours. Each write is a commit, so the timestamp on
"we said this beforehand" is checkable by anyone — including against us.

## The one rule

**A prediction is written once and never rewritten.** The only change ever made to
an existing record is filling in a `result` that was absent. This is enforced in
`assets/js/store.js`, not left to the scripts, and it is the property the accuracy
figures rest on: if it broke, every number would quietly improve and nothing would
report it.

That is why the history matters more than the files. A single suspicious commit —
one that changes a probability, or backdates a `predicted.at` — would be visible
forever in `git log -p data/`.

## Layout

    YYYY-MM-DD.json   every prediction for matches kicking off on that UTC day
    index.json        which days exist, and how many records per model revision
    summary.json      the measured accuracy, recomputed from the day files

`index.json` and `summary.json` are both derived. They can be deleted and rebuilt
from the day files; the day files cannot be rebuilt from anything.

Days are keyed in **UTC**, so a 23:00 kickoff lands in the same file for the writer
and for the site. It may not be the day it felt like locally.

## Reading a record

    id          the ESPN event id — results are matched on this and nothing else
    league      ESPN league slug, e.g. eng.1
    kickoff     ISO instant
    predicted   { at }  when we committed to this. See below.
    lambda      [home, away] expected goals
    probs       [home, draw, away] — sums to 1
    pick        home | draw | away — simply the largest of probs
    score       [home, away, probability] the likeliest single scoreline
    over25      probability of three or more goals
    btts        probability both teams score
    conf        our own confidence band, 1-3
    seen        [home, away] matches each side's rating was fitted on
    market      the bookmaker's prices at the moment we froze, if ESPN had any,
                de-vigged, plus the overround we removed. Absent for most matches.
    model       { rev, hash } which model produced this
    result      { goals: [home, away] } attached after the match. Absent until then.

`predicted.at` is the honest part. Records are written when a fixture is within 24
hours of kickoff (`FREEZE_WITHIN_HOURS` in `assets/js/config.js`), so these are
approximately the figures a match-day visitor read — not figures computed a week
early, and not figures computed after the fact.

`market` is captured before kickoff because **ESPN deletes bookmaker odds once a
match finishes.** There is no way to recover a price we did not record, which is
why the comparison between our model and the market can only ever run forward from
the day this archive started.

## Why records go missing, and why they stay missing

A match that is postponed or abandoned keeps its record and never gets a `result`.
Voiding it would be a judgement, and this archive stores observations. After five
days `tools/settle.mjs` starts naming them in the workflow log so a growing pile is
visible rather than silent.

A postponed match that is later replayed produces a second record, under its new
kickoff day, with the same `id`. Both are kept: we did claim the first one, and
deleting it would be rewriting history. Only the record whose day matches its
kickoff is scored.

## Checking it yourself

    node tests/run.mjs w1

That suite rebuilds a scratch archive from scratch, runs both writers against a
fake ESPN, and asserts — among other things — that running the writer twice leaves
every byte unchanged.
