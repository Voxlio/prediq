/* =============================================================================
   render.js — turns predictions into the fixtures page.

   No maths, no network. Shared element and status helpers come from dom.js,
   including the rule they enforce: no innerHTML anywhere, so team and provider
   names arriving from ESPN can only ever land in a text node.
   ========================================================================== */

import { el, clear, field, stat, setStatus, notice, errorNotice, leagueName } from './dom.js';

export { showProgress, showFatal } from './dom.js';

/* =============================================================================
   1. DATES

   Intl formats in the reader's own time zone, so a kickoff shows in local time
   wherever the page is opened — no configuration and no server needed.
   ========================================================================== */

const fmtDay  = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function dayLabel(date) {
  const days = Math.round((midnight(date) - midnight(new Date())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return fmtDay.format(date);
}

/* =============================================================================
   2. INSIGHT LINES

   The model marks key figures with *asterisks*. Splitting on those gives
   alternating plain and emphasised parts — odd indexes are the emphasised
   ones. Both are built as real nodes, so nothing is ever parsed as HTML.
   ========================================================================== */

function insightNode(text) {
  const li = el('li');
  text.split('*').forEach((part, i) => {
    if (!part) return;
    li.appendChild(i % 2 ? el('b', null, part) : document.createTextNode(part));
  });
  return li;
}

/* =============================================================================
   3. THE MATCH CARD
   ========================================================================== */

function outcomeRow(name, percent, isPick) {
  const row = el('div', isPick ? 'outcome is-pick' : 'outcome');
  row.append(el('span', 'outcome-name', name));

  const bar = el('span', 'outcome-bar');
  const fill = el('i');
  fill.style.setProperty('--w', percent + '%');
  bar.append(fill);
  row.append(bar);

  const pct = el('span', 'outcome-pct', String(percent));
  pct.append(el('em', null, '%'));
  row.append(pct);
  return row;
}

function confBlock(conf) {
  const wrap = el('div', 'conf');
  wrap.append(el('span', 'label', 'confidence'));

  const meter = el('span', 'meter');
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `Confidence: ${conf.word}, ${conf.level} of 4`);
  for (let i = 1; i <= 4; i++) meter.append(el('i', i <= conf.level ? 'on' : null));
  wrap.append(meter, el('span', 'conf-word', conf.word));
  return wrap;
}

function marketsBlock(p) {
  const dl = el('dl', 'markets');
  const one = n => n.toFixed(2);

  field(dl, 'xG', `${one(p.lambda.home)}–${one(p.lambda.away)}`,
        'Expected goals for each side, from the fitted model');
  field(dl, 'score', `${p.score.home}–${p.score.away}`,
        `Likeliest single scoreline, at ${Math.round(p.score.prob * 100)}%`);
  field(dl, 'o2.5', `${Math.round(p.over25 * 100)}%`, 'Chance of three or more goals');
  field(dl, 'btts', `${Math.round(p.btts * 100)}%`, 'Chance both teams score');

  /* The bookmaker's view, shown beside the model rather than mixed into it,
     with the margin already divided out so the two are comparable. */
  if (p.market) {
    const m = p.market;
    const trio = [m.home, m.draw, m.away].map(v => Math.round(v * 100)).join('/');
    field(dl, 'mkt', trio,
      `${m.provider || 'Bookmaker'} implied probability, home/draw/away, with the ` +
      `${Math.round((m.overround - 1) * 100)}% margin removed. Shown for comparison — it is not an input to the model.`);
  }
  return dl;
}

/* The competition-and-kickoff row every card opens with, whatever state the
   card is in. Shared so the three states cannot drift apart. */
function metaRow(leagueName, iso, crossLeague) {
  const meta = el('div', 'match-meta');
  const comp = el('span', 'comp', leagueName || '');
  if (crossLeague) {
    comp.title = 'Teams from different domestic leagues — strengths are adjusted for league quality';
  }
  const time = el('time', 'kick', fmtTime.format(new Date(iso)));
  time.dateTime = iso;
  meta.append(comp, time);
  return meta;
}

/* Home, "v", away — weighted the same on both sides, because in the states that
   use this there is no pick to emphasise. The names carry no class of their
   own: the flex parent sets size and colour. */
function teamsRow(homeName, awayName) {
  const teams = el('div', 'blank-teams');
  teams.append(
    el('span', null, homeName),
    el('span', 'blank-v', 'v'),
    el('span', null, awayName));
  return teams;
}

/* A fixture the model will not predict. It still gets a card, because hiding
   it would quietly misrepresent what is on this week. */
function blankCard(p) {
  const card = el('article', 'match is-blank');
  card.append(
    metaRow(p.league?.name, p.fixture.date, false),
    teamsRow(p.fixture.home.name, p.fixture.away.name),
    el('p', 'blank-note', p.reason));
  return card;
}

/* A fixture whose prediction has not been worked out yet.

   Phase 1 knows every match, its competition and its kickoff; phase 2 reads the
   league tables and results the numbers come from. Rather than sit behind a
   spinner for the whole of phase 2, the list is drawn as soon as phase 1
   lands — a fixture list is useful on its own — and each card gains its
   prediction when there is one to show.

   Nothing here is ever revised: the model is fitted once, after phase 2, so a
   card goes from this state straight to its final numbers. It never shows one
   probability and then another.

   `note` is the line under the team names. It defaults to the waiting message,
   and the fallback state overrides it to say the wait is over and came to
   nothing — same card, so the list does not reorganise on failure. */
export function pendingCard(fixture, leagueName, i, note = 'Working out the prediction…') {
  const card = el('article', 'match is-pending');
  card.style.setProperty('--i', String(i));
  card.append(
    metaRow(leagueName, fixture.date, false),
    teamsRow(fixture.home.name, fixture.away.name),
    el('p', 'blank-note', note));
  return card;
}

/* Recent results, most recent first, one line per side.

   The team's OWN goals are printed first, so "2–1" reads as a win from the
   digits alone and the colour only reinforces what the numbers already say.
   That ordering is deliberate: printing the fixture as it stood (home–away)
   would make the colour the sole carrier of the result, which fails for the
   ~8% of men who cannot separate this green from this red.

   Both lines are left-aligned so the two sides' crests sit in a column and can
   be compared down the card rather than across it.

   Screen readers get one summary sentence per side: the strip is announced as a
   single image, so the crests and digits inside it are never spelled out. */

const SHORT_DATE = { day: 'numeric', month: 'short' };
const formDate = iso => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d.toLocaleDateString('en-GB', SHORT_DATE);
};

const VERB = { W: 'won', D: 'drew', L: 'lost' };

function formCrest(r) {
  if (!r.oppLogo) {
    /* No crest from ESPN. A letter keeps the unit the same width, so the two
       strips stay aligned whether or not the images exist. */
    return el('span', 'form-crest is-none', (r.opp || '?').charAt(0).toUpperCase());
  }
  const img = el('img', 'form-crest');
  img.src = r.oppLogo;
  img.alt = '';
  img.width = 14;
  img.height = 14;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  return img;
}

function formRuns(runs, teamName) {
  const wrap = el('span', 'form-runs');

  /* One image, one sentence. role="img" prunes everything inside from the
     accessibility tree, so the label below is the whole announcement — ten
     fragments of "crest, two dash one" per card is noise, not information.
     This is the same trick confBlock uses for the confidence meter. */
  wrap.setAttribute('role', 'img');

  if (!runs.length) {
    wrap.setAttribute('aria-label', `${teamName}: no matches counted yet`);
    wrap.append(el('span', 'form-none', 'no matches yet'));
    return wrap;
  }

  for (const r of runs) {
    const unit = el('span', 'form-game is-' + r.result.toLowerCase());
    const when = r.date ? formDate(r.date) : null;
    unit.title = `${r.gf}–${r.ga} ${r.atHome ? 'v' : 'at'} ${r.opp}` + (when ? ` · ${when}` : '');
    unit.append(formCrest(r), el('b', 'form-score', `${r.gf}–${r.ga}`));
    wrap.append(unit);
  }

  const spoken = runs
    .map(r => `${VERB[r.result]} ${r.gf}–${r.ga} ${r.atHome ? 'against' : 'away at'} ${r.opp}`)
    .join(', ');
  wrap.setAttribute('aria-label', `${teamName}, last ${runs.length}, most recent first: ${spoken}`);
  return wrap;
}

function formSide(team, runs) {
  const name = team.short || team.name;
  const line = el('div', 'form-side');

  /* The label is hidden from assistive tech because the strip's own label
     already opens with the team name. Announcing it twice is worse than
     announcing it once. */
  const label = el('span', 'form-team', name);
  label.setAttribute('aria-hidden', 'true');

  line.append(label, formRuns(runs, name));
  return line;
}

function formRow(p) {
  const row = el('div', 'form-row');
  row.append(formSide(p.home, p.form.home), formSide(p.away, p.form.away));
  row.title = 'Last five league matches, most recent first, as counted by the model. Own goals first.';
  return row;
}

export function matchCard(p, index) {
  if (!p.ok) {
    const c = blankCard(p);
    c.style.setProperty('--i', String(index));
    return c;
  }

  const card = el('article', 'match');
  card.style.setProperty('--i', String(index));

  /* --- block 1: competition and kickoff --- */
  const meta = el('div', 'match-meta');
  const comp = el('span', 'comp', p.league?.name ?? '');
  if (p.crossLeague) {
    comp.title = 'Teams from different domestic leagues — strengths are adjusted for league quality';
  }
  const time = el('time', 'kick', fmtTime.format(new Date(p.fixture.date)));
  time.dateTime = p.fixture.date;
  meta.append(comp, time);

  /* --- block 2: the three outcomes --- */
  const outcomes = el('div', 'outcomes');
  outcomes.append(
    outcomeRow(p.home.name, p.pct.home, p.probs.pick === 'home'),
    outcomeRow('Draw',      p.pct.draw, p.probs.pick === 'draw'),
    outcomeRow(p.away.name, p.pct.away, p.probs.pick === 'away'));

  /* --- block 3: confidence and the market fields --- */
  const readout = el('div', 'readout');
  readout.append(confBlock(p.conf), marketsBlock(p));

  /* Form sits between the kickoff and the probabilities: it is context for
     reading them, and it belongs above the model's own numbers rather than
     buried under them. Omitted entirely when neither side has played, which
     is the normal state in the first week of a season. */
  card.append(meta);
  if (p.form && (p.form.home.length || p.form.away.length)) card.append(formRow(p));
  card.append(outcomes, readout);

  /* --- block 4: insights --- */
  if (p.insights.length) {
    const ul = el('ul', 'insights');
    p.insights.forEach(t => ul.append(insightNode(t)));
    card.append(ul);
  }
  return card;
}

/* =============================================================================
   4. PAGE STATES
   ========================================================================== */

/* Something to look at while the first load runs, so the page never sits
   blank and looking broken. */
export function showLoading(mount, statusNode) {
  setStatus(statusNode, ['loading fixtures']);
  clear(mount);
  for (let i = 0; i < 3; i++) {
    const skel = el('article', 'match is-skeleton');
    skel.style.setProperty('--i', String(i));
    skel.setAttribute('aria-hidden', 'true');
    const meta = el('div', 'match-meta');
    meta.append(el('span', 'sk sk-sm'), el('span', 'sk sk-xs'));
    const rows = el('div', 'outcomes');
    for (let r = 0; r < 3; r++) {
      const row = el('div', 'outcome');
      row.append(el('span', 'sk sk-md'), el('span', 'sk sk-bar'), el('span', 'sk sk-xs'));
      rows.append(row);
    }
    skel.append(meta, rows);
    mount.append(skel);
  }
}

export function showEmpty(mount, statusNode, days) {
  setStatus(statusNode, [stat(0, 'fixtures')]);
  clear(mount);
  mount.append(notice(
    'No fixtures in the next ' + days + ' days',
    'The leagues Prediq follows have nothing scheduled in this window — most likely an international break or the gap between seasons. Predictions return with the fixtures.'));
}

/* =============================================================================
   5. THE FULL PAGE
   ========================================================================== */

/* Cards in date order with a heading whenever the day changes. Both page states
   lay out through this, so the day dividers land in the same places in phase 1
   as in phase 2 and the list does not reorganise itself under the reader.
   `card(item, i)` is the only difference between the two. */
function dayGroupedList(mount, items, dateOf, card) {
  let lastDay = null;
  items.forEach((item, i) => {
    const date = new Date(dateOf(item));
    const key = midnight(date);
    if (key !== lastDay) {
      lastDay = key;
      const h = el('h2', 'day');
      h.append(el('span', null, dayLabel(date)));
      mount.append(h);
    }
    mount.append(card(item, i));
  });
}

/* Phase 1: every fixture, no predictions yet. The status strip carries the
   counts rather than a bare spinner, because "31 fixtures across 9 leagues" is
   already the answer to a question somebody came here with. */
export function showFixtureList(mount, statusNode, fixtures) {
  clear(mount);
  const leagues = new Set(fixtures.map(f => f.leagueSlug));
  setStatus(statusNode, [
    stat(fixtures.length, fixtures.length === 1 ? 'fixture' : 'fixtures'),
    stat(leagues.size, leagues.size === 1 ? 'league' : 'leagues'),
    'reading league tables',
  ]);
  dayGroupedList(mount, fixtures, f => f.date,
    (f, i) => pendingCard(f, leagueName(f.leagueSlug), i));
}

/* Phase 1 worked, phase 2 did not. The fixtures on screen are still true, so
   they stay: throwing away a correct fixture list because the predictions
   failed would take away information the reader already had. The notice sits
   above the list and says which half is missing. */
export function showFixtureFallback(mount, statusNode, fixtures, message) {
  clear(mount);
  setStatus(statusNode, [
    stat(fixtures.length, fixtures.length === 1 ? 'fixture' : 'fixtures'),
    'no predictions',
  ]);
  mount.append(notice(
    'Fixtures loaded, predictions did not',
    (message ? message + '. ' : '') +
    'The league tables and results the model is fitted from could not be read, so the ' +
    'matches below are listed without predictions. Nothing here is guessed at in their ' +
    'place. A reload normally fixes it.',
    'warn'));
  dayGroupedList(mount, fixtures, f => f.date,
    (f, i) => pendingCard(f, leagueName(f.leagueSlug), i, 'No prediction — model data did not load.'));
}

export function showPredictions(mount, statusNode, predictions, index, data) {
  clear(mount);

  const priced = predictions.filter(p => p.ok);
  const leagues = new Set(predictions.map(p => p.fixture.leagueSlug));
  const matchesUsed = [...index.fits.values()].reduce((n, f) => n + f.matches.length, 0);

  const parts = [
    stat(predictions.length, predictions.length === 1 ? 'fixture' : 'fixtures'),
    stat(leagues.size, leagues.size === 1 ? 'league' : 'leagues'),
    stat(matchesUsed, 'matches fitted'),
  ];
  if (priced.length < predictions.length) {
    parts.push(stat(predictions.length - priced.length, 'unpriced'));
  }
  setStatus(statusNode, parts);

  if (data.errors.length) {
    mount.append(errorNotice(data.errors,
      'Predictions are still shown, but they rest on less evidence than usual.'));
  }

  /* Grouped by day, because a week across fourteen competitions is a long list. */
  dayGroupedList(mount, predictions, p => p.fixture.date, matchCard);
}
