# Prediq

Football match predictions from a statistical model, with the model's own record
published alongside them.

Statistical output for information. Not betting advice.

## What it is

A static site. Plain HTML, CSS and JavaScript modules — no framework, no build
step, no `npm install`. Open `index.html` in a browser and it works.

Everything is fetched live from ESPN's public soccer endpoints, which need no API
key, and the prediction model is fitted in the visitor's browser on every visit.
There is no server, no login, and no database the site writes to.

## Pages

    index.html     fixtures for the next week, each with a full prediction
    record.html    what was predicted, and what happened, day by day
    ratings.html   the model's own power rankings, and how they were derived
    method.html    the entire method, including what it cannot do

`record.html` is the only page that reads from `data/` rather than from ESPN, so
it needs to be served over http rather than opened off disk. Every verdict on it
is recomputed from the stored probabilities and the final score at the moment the
page renders — no judgement is stored anywhere, so a reader can check one.

## How the prediction works, briefly

A Poisson goals model. Each team gets an attack and a defence rating from its own
league's results, weighted towards recent matches and shrunk towards the league
average when there are few games to go on. Those produce expected goals for both
sides, then a full scoreline probability matrix, and everything shown — the result
probabilities, the likeliest scoreline, over/under 2.5, both teams to score, the
confidence band — is read off that one matrix. `method.html` has the derivation.

Where ESPN carries bookmaker prices, they are shown **beside** the model's numbers
with the margin removed, never mixed into them. The point is to see where the two
disagree, which is not possible if one has been folded into the other.

## The archive

`data/` holds every prediction the site has published, written down before the
match and never edited afterwards, plus the final scores attached later. It is
written by a scheduled GitHub Actions job, so each write is a commit — which is
what makes "we said this beforehand" checkable by anyone, including against us.

`data/README.md` explains the format and the rules it obeys.

## Running the tests

    node tests/run.mjs           everything
    node tests/run.mjs w1        one suite
    node tests/run.mjs -v        every assertion, not just the totals

No dependencies, no test framework — `tests/README.md` explains the layout and the
hand-rolled DOM shim the render suites run on.

## Repository layout

    assets/css/     one stylesheet
    assets/js/      config, data fetching, the model, rendering, the archive schema
    tools/          the scheduled writers (Node only; the browser never loads these)
    tests/          the test suite
    data/           the prediction archive
    .github/        the workflow that writes the archive
    .nojekyll       empty, and deliberately so — see below

GitHub Pages runs every repository through Jekyll unless that empty `.nojekyll`
file is present, and Jekyll silently drops files and folders whose names begin
with an underscore. Nothing here starts with one today, but the failure mode is a
file that is simply missing from the published site with no error anywhere, so the
file costs nothing and is worth keeping.
