/* =============================================================================
   ledger.js — the record view: what Prediq said, and what happened.

   One row per match. Left of the divider is the claim, frozen before kickoff and
   never touched since; right of it is the outcome. Nothing on this page is a
   fresh opinion — every verdict comes from record.js's `score()`, computed at
   render time from the stored probabilities and the final score.

   THE POINT OF DERIVING RATHER THAN READING

   A stored verdict is a second copy of a fact, and second copies drift. Worse,
   a stored "hit: true" is unfalsifiable by a reader: they would have to trust
   that whoever wrote it applied the rule we describe. Derived here, the reader
   can open data/2026-08-23.json, see three probabilities and two goals, and
   check the verdict themselves. That is the whole reason the archive exists, so
   the page that displays it must not shortcut it.

   WHAT THIS PAGE DELIBERATELY DOES NOT DO

   It does not publish a hit rate until MIN_FOR_RATE matches have settled. It
   shows the counts from the very first one, because 8 of 12 is a fact — but a
   percentage reads as a claim about the model, and off twelve matches it is
   mostly noise. It also carries no calibration curve and no market comparison:
   both need a lot more data and belong on the accuracy page.

   Same no-innerHTML rule as everywhere else. Team names arrive from ESPN and
   reach the document as text nodes only.
   ========================================================================== */

import { el, clear, setStatus, stat, notice, leagueName, dayLabel } from './dom.js';
import { score } from './record.js';
import { MIN_FOR_RATE } from './config.js';

export { showProgress, showFatal } from './dom.js';
/* The day strip is shared with the fixtures page, so it lives in dom.js — see
   the DAYS section there for why a day key must be rebuilt as a local date. */
export { dayStrip } from './dom.js';

/* Kickoff time in the reader's own zone. A 22:00 UTC kickoff is "23:00" in
   Lagos and the archive's day key says 2026-08-23 either way — the key is the
   writer's business, the clock is the reader's. */
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const pct = p => Math.round(p * 100) + '%';
const OUTCOME_WORD = { home: 'home win', draw: 'draw', away: 'away win' };

/* =============================================================================
   1. ONE MATCH

   Four cells: the fixture, what we picked and at what probability, what
   happened, and the verdict. A record with no result yet gets the same row with
   the last two cells saying so — dropping it would quietly hide every prediction
   still in flight, which is the half of the record that cannot flatter us.
   ========================================================================== */
export function ledgerRow(record) {
  const v = score(record);
  const p = record.predicted;
  const settled = v !== null;

  const row = el('div', 'lg-row' + (settled ? (v.hit ? ' is-hit' : ' is-miss') : ' is-open'));

  /* --- the fixture --- */
  const fixture = el('div', 'lg-fixture');
  const teams = el('div', 'lg-teams');
  teams.append(
    el('span', 'lg-team', record.home.name),
    el('span', 'lg-v', 'v'),
    el('span', 'lg-team', record.away.name));
  const meta = el('div', 'lg-meta');
  const kick = el('time', 'lg-kick', fmtTime.format(new Date(record.kickoff)));
  kick.dateTime = record.kickoff;
  meta.append(el('span', 'lg-comp', leagueName(record.league)), kick);
  fixture.append(teams, meta);

  /* --- what we said --- */
  const said = el('div', 'lg-said');
  const pickWord = OUTCOME_WORD[p.pick];
  said.append(
    el('span', 'lg-pick', pickWord),
    el('span', 'lg-prob', pct(p.probs[{ home: 0, draw: 1, away: 2 }[p.pick]])));
  /* The likeliest scoreline was on the card, so it is part of the claim and
     belongs in the record whether or not it came off. */
  said.append(el('span', 'lg-score-said', p.score[0] + '–' + p.score[1]));
  said.title = 'Predicted ' + pickWord + ' at ' +
    pct(p.probs[{ home: 0, draw: 1, away: 2 }[p.pick]]) +
    ', written down ' + new Date(p.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  /* --- what happened --- */
  const happened = el('div', 'lg-happened');
  if (settled) {
    happened.append(el('span', 'lg-ft', v.goals[0] + '–' + v.goals[1]));
    happened.append(el('span', 'lg-outcome', OUTCOME_WORD[v.outcome]));
  } else {
    happened.append(el('span', 'lg-pending', 'not played yet'));
  }

  /* --- the verdict --- */
  const verdict = el('div', 'lg-verdict');
  if (!settled) {
    verdict.append(el('span', 'lg-mark', '·'));
    verdict.title = 'This prediction is recorded and waiting for the result.';
  } else {
    verdict.append(el('span', 'lg-mark', v.hit ? '✓' : '✕'));
    /* What the model gave to the thing that actually happened. The single most
       honest number about a miss: "we had it at 24%" is a different admission
       from "we had it at 3%", and a hit at 31% is luck rather than skill. */
    verdict.append(el('span', 'lg-assigned', 'gave it ' + pct(v.assigned)));
    if (v.exact) verdict.append(el('span', 'lg-flag', 'exact score'));
    else if (v.runnerUp) verdict.append(el('span', 'lg-flag', 'second choice'));
    verdict.title = v.hit
      ? 'Called it. The model gave ' + OUTCOME_WORD[v.outcome] + ' ' + pct(v.assigned) + '.'
      : 'Missed. The model gave ' + OUTCOME_WORD[v.outcome] + ' ' + pct(v.assigned) +
        ', and picked ' + OUTCOME_WORD[p.pick] + ' instead.';
  }

  row.append(fixture, said, happened, verdict);
  return row;
}

/* =============================================================================
   2. THE DAY'S TALLY

   Counts always; a rate only past MIN_FOR_RATE. The denominator is settled
   matches, never all of them — dividing hits by everything recorded would make
   an unplayed fixture look like a loss.
   ========================================================================== */
export function tally(records, totalSettled) {
  const scored = records.map(score).filter(Boolean);
  const hits = scored.filter(v => v.hit).length;
  const box = el('div', 'lg-tally');

  if (!scored.length) {
    box.append(el('span', 'lg-tally-mute',
      records.length + ' recorded, none finished yet'));
    return box;
  }

  const line = el('span');
  line.append(el('b', null, hits + ' of ' + scored.length), document.createTextNode(' called correctly'));
  box.append(line);

  /* A rate needs a body of evidence, and the honest thing while it is thin is to
     say how far off it is rather than to publish a number with a shrug. */
  if (totalSettled >= MIN_FOR_RATE) {
    box.append(el('span', 'lg-tally-sep', '/'));
    box.append(el('span', null, Math.round((hits / scored.length) * 100) + '% this day'));
  } else {
    box.append(el('span', 'lg-tally-sep', '/'));
    box.append(el('span', 'lg-tally-mute',
      'no rate published until ' + MIN_FOR_RATE + ' matches have settled (' +
      totalSettled + ' so far)'));
  }

  const exact = scored.filter(v => v.exact).length;
  if (exact) {
    box.append(el('span', 'lg-tally-sep', '/'));
    box.append(el('span', 'lg-tally-mute',
      exact + ' exact scoreline' + (exact === 1 ? '' : 's')));
  }
  return box;
}

/* =============================================================================
   3. STATES
   ========================================================================== */
export function showLoading(mount, statusNode) {
  setStatus(statusNode, ['reading the archive']);
  clear(mount);
  const box = el('div', 'lg-rows');
  for (let i = 0; i < 6; i++) {
    const r = el('div', 'lg-row is-skeleton');
    r.append(el('div', 'sk sk-md'), el('div', 'sk sk-sm'), el('div', 'sk sk-sm'), el('div', 'sk sk-xs'));
    box.append(r);
  }
  mount.append(box);
}

/* Two genuinely different empty states, and conflating them would be a lie in
   one direction or the other. An archive with no files at all means the record
   has not started; a day with no file means there was no football. */
export function showNoArchive(mount, statusNode) {
  setStatus(statusNode, ['nothing recorded yet']);
  clear(mount);
  mount.append(notice(
    'The record starts with the next match',
    'Prediq writes each prediction down before kickoff and attaches the result afterwards. ' +
    'Nothing has been recorded yet, so there is nothing to show — this page will fill itself in ' +
    'as matches are played, and no figure will appear here that was not written down beforehand.',
    null));
}

/* Opening the file straight off disk. Every other page survives this, because
   they fetch ESPN over https and a browser allows that from anywhere. This one
   reads its own JSON out of data/ with a relative path, and Chrome blocks a
   file:// page from reading a sibling file — the request fails before it starts,
   with a TypeError whose message says nothing about the cause. So the case is
   detected up front and named, rather than surfacing as "could not load". */
export function showNotServed(mount, statusNode) {
  setStatus(statusNode, ['not being served']);
  clear(mount);
  mount.append(notice(
    'This page needs a web server',
    'The record is stored as JSON files inside the project, and a browser will not let a page ' +
    'opened directly from disk read files next to it. Run "python3 -m http.server" in the ' +
    'project folder and open http://localhost:8000/record.html instead — or read this page on ' +
    'the published site. The fixtures and ratings pages work from disk because they read a ' +
    'public API rather than local files.',
    'warn'));
}

export function showEmptyDay(mount, statusNode, day) {
  setStatus(statusNode, ['no matches recorded']);
  clear(mount);
  mount.append(notice(
    'No predictions for ' + dayLabel(day),
    'Nothing in the leagues Prediq tracks kicked off that day, so nothing was recorded. ' +
    'Days with no matches are left out of the strip above rather than shown as empty.',
    null));
}

/* =============================================================================
   4. THE DAY
   ========================================================================== */
export function showDay(mount, statusNode, { day, records }, totalSettled) {
  clear(mount);
  if (!records.length) return showEmptyDay(mount, statusNode, day);

  /* Kickoff order, so the page reads as the day did. */
  const sorted = [...records].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const scored = sorted.map(score).filter(Boolean);

  setStatus(statusNode, [
    stat(records.length, 'recorded'),
    stat(scored.length, 'finished'),
    stat(scored.filter(v => v.hit).length, 'correct'),
  ]);

  const head = el('div', 'lg-h');
  head.append(
    el('span', 'lg-h-fixture', 'match'),
    el('span', 'lg-h-said', 'we said'),
    el('span', 'lg-h-happened', 'result'),
    el('span', 'lg-h-verdict', 'verdict'));

  const rows = el('div', 'lg-rows');
  for (const r of sorted) rows.append(ledgerRow(r));

  mount.append(tally(sorted, totalSettled), head, rows);
}
