/* v1.mjs — ledger.js, the record view, on the same DOM shim r1 and rt1 use.

   The record page is the one page whose whole claim is that it is checkable, so
   the assertions here are aimed at that claim rather than at appearance:

     - every verdict must be DERIVED. This suite recomputes each one from the raw
       stored numbers — argmax of three probabilities against the two goals — and
       demands the page agree. If ledger.js ever started reading a stored
       judgement, the page would still render and this suite would still pass,
       so the test goes further: it mutates a stored score and requires the mark
       to change.
     - a rate must not appear before MIN_FOR_RATE, and the denominator must be
       settled matches rather than everything recorded.
     - a prediction with no result yet must still be on the page. Dropping those
       is the one edit that would make the record flatter the model without any
       individual row being wrong.

   Records come from the real model through the real freeze(), never hand-built —
   f1's first draft hand-fed a shape to freeze() and got nothing back.
*/

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const base = new URL('../assets/js/', import.meta.url).href;

/* ---------- 1. the shim ----------
   Extended past rt1's copy by exactly two things the day strip needs: `dataset`,
   because the day key rides on the button as data-day, and `addEventListener`,
   which is recorded rather than ignored so a click can actually be fired. */
class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.childNodes = []; }
  get textContent() { return this.data; }
}
class Element {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.className = '';
    this.childNodes = []; this.attributes = {}; this.dataset = {};
    this.listeners = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...ns) { for (const n of ns) if (n != null) this.childNodes.push(n); }
  appendChild(n) { this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { (this.listeners.click || []).forEach(fn => fn()); }
  set textContent(v) { this.childNodes = v === '' ? [] : [new TextNode(v)]; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
}
globalThis.document = {
  createElement: t => new Element(t),
  createTextNode: t => new TextNode(t),
};

const walk = (n, out = []) => { out.push(n); n.childNodes.forEach(c => walk(c, out)); return out; };
const els = (n, cls) => walk(n).filter(x => x.nodeType === 1 && x.className.split(/\s+/).includes(cls));
const one = (n, cls) => els(n, cls)[0];
const tags = (n, tag) => walk(n).filter(x => x.nodeType === 1 && x.tagName === tag);

let fails = 0;
const ok = (l, c, g) => {
  console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g)));
  if (!c) fails++;
};

const M = await import(base + 'model.js');
const R = await import(base + 'record.js');
const C = await import(base + 'config.js');
const D = await import(base + 'dom.js');
const L = await import(base + 'ledger.js');
const { MIN_FOR_RATE, LEAGUES } = C;

/* ---------- 2. real records, from the real model ---------- */
const HOSTILE = '<img src=x onerror=alert(1)>';

const PREV = [
  ['1','Liverpool',86,41], ['2','Arsenal',69,34], ['3','Man City',72,44], ['4','Chelsea',64,43],
  ['5','Newcastle',68,47], ['6','Aston Villa',58,51], ['7','Nottm Forest',58,46], ['8','Brighton',66,59],
  ['9','Bournemouth',58,46], ['10','Brentford',66,57], ['11','Fulham',54,54], ['12','Crystal Palace',51,51],
  ['13','Everton',42,44], ['14','West Ham',46,62], ['15','Man United',44,54], ['16', HOSTILE, 54, 69],
  ['17','Tottenham',64,65], ['18','Leicester',33,80], ['19','Ipswich',36,82], ['20','Southampton',26,86],
].map(([id, name, gf, ga]) => ({ id, name, short: name, gp: 38, gf, ga, rank: +id }));

const NOW = PREV.map(t => ({ ...t, gp: 6, gf: 9, ga: 8 }));

const RES = (h, a, hg, ag, date) => ({
  date, home: { id: h, name: '', g: hg }, away: { id: a, name: '', g: ag },
});
const RESULTS = [
  RES('2','12',3,0,'2026-08-15'), RES('1','20',2,1,'2026-08-15'), RES('4','19',1,1,'2026-08-16'),
  RES('3','18',4,0,'2026-08-16'), RES('5','13',2,2,'2026-08-16'), RES('15','8',0,2,'2026-08-17'),
];

const T0 = new Date('2026-08-23T09:00:00.000Z');
const hrs = h => new Date(+T0 + h * 3600e3).toISOString();
const F = (id, h, a, out, slug = 'eng.1') => ({
  id, leagueSlug: slug, date: hrs(out), venue: null,
  home: { id: h, name: '', short: '', form: null },
  away: { id: a, name: '', short: '', form: null },
  odds: null,
});

/* Deliberately out of kickoff order in the input, so the sort has something to
   do. Deliberately mixed strengths, so the set contains both a heavy favourite
   and a near-coin-toss rather than six of the same shape. */
const FIXTURES = [
  F('704', '11', '12', 11),
  F('701', '1', '20', 3),
  F('702', '17', '16', 5),
  F('703', '18', '3', 7),
  F('705', '13', '14', 13),
  F('706', '9', '10', 15),
];

const data = {
  season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: +T0,
  fixtures: FIXTURES,
  byLeague: { 'eng.1': { standingsNow: NOW, standingsPrev: PREV, results: RESULTS } },
};
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) {
  data.byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
}

const { predictions } = M.predictAll(data);
const frozen = predictions.map(p => R.freeze(p, T0)).filter(f => f.record).map(f => f.record);

console.log('=== the fixture ===');
console.log('    ' + frozen.length + ' records frozen from ' + FIXTURES.length + ' fixtures');
ok('every fixture froze, so the suite is testing six records not two',
  frozen.length === FIXTURES.length, frozen.length);

/* Results are chosen from each record's OWN pick, so a hit is a hit whatever the
   model happened to say. Hard-coding "2-0 is a hit" would silently stop testing
   the hit branch the day the model changed its mind about a fixture. */
const realise = (outcome, big) =>
  outcome === 'home' ? (big ? [4, 0] : [1, 0]) :
  outcome === 'away' ? (big ? [0, 4] : [0, 1]) :
  (big ? [2, 2] : [1, 1]);
const notPick = pick => (pick === 'home' ? 'away' : 'home');

const settle = (rec, goals) => {
  const out = R.attachResult(rec, { home: goals[0], away: goals[1], at: hrs(20) });
  if (!out.record) throw new Error('attachResult refused: ' + out.skip);
  return out.record;
};

const byId = id => frozen.find(r => r.id === id);
const RECORDS = [
  settle(byId('701'), realise(byId('701').predicted.pick, true)),        /* hit */
  settle(byId('702'), realise(notPick(byId('702').predicted.pick), true)), /* miss */
  settle(byId('703'), byId('703').predicted.score.slice(0, 2)),           /* exact scoreline */
  settle(byId('704'), [1, 1]),                                            /* a draw */
  byId('705'),                                                            /* no result yet */
  byId('706'),                                                            /* no result yet */
];

/* ---------- 3. the verdict, recomputed from the raw numbers ---------- */
console.log('');
console.log('=== every verdict is derived, and this suite derives it independently ===');

const INDEX = { home: 0, draw: 1, away: 2 };
const WORD = ['home', 'draw', 'away'];
const outcomeOf = ([h, a]) => (h > a ? 'home' : h < a ? 'away' : 'draw');
const argmax = probs => WORD[probs.indexOf(Math.max(...probs))];
const pctOf = p => Math.round(p * 100) + '%';

for (const rec of RECORDS) {
  const p = rec.predicted;
  const row = L.ledgerRow(rec);
  const mark = one(row, 'lg-mark').textContent;
  const tag = rec.home.name === HOSTILE || rec.away.name === HOSTILE ? 'hostile' : rec.id;

  if (!rec.result) {
    ok(tag + ': an unsettled record gets the neutral mark, not a cross',
      mark === '·', mark);
    ok(tag + ': and says so in words rather than leaving the cell blank',
      one(row, 'lg-pending').textContent === 'not played yet',
      one(row, 'lg-happened').textContent);
    ok(tag + ': and carries is-open, so nothing colours it green or red',
      row.className.includes('is-open') &&
      !row.className.includes('is-hit') && !row.className.includes('is-miss'),
      row.className);
    continue;
  }

  const outcome = outcomeOf(rec.result.goals);
  const expectHit = p.pick === outcome;

  ok(tag + ': the stored pick is the argmax of the stored probabilities',
    p.pick === argmax(p.probs), [p.pick, p.probs]);
  ok(tag + ': the mark agrees with argmax(probs) vs the goals, computed here',
    mark === (expectHit ? '✓' : '✕'), [mark, p.pick, outcome, rec.result.goals]);
  ok(tag + ': the row class agrees with the mark',
    row.className.includes(expectHit ? 'is-hit' : 'is-miss'), row.className);

  /* The number that makes a miss readable. Recomputed from the record rather
     than read off score(), so the page and score() cannot agree on a wrong one. */
  ok(tag + ': "gave it" is the probability assigned to what actually happened',
    one(row, 'lg-assigned').textContent === 'gave it ' + pctOf(p.probs[INDEX[outcome]]),
    one(row, 'lg-assigned').textContent);

  ok(tag + ': the final score is printed as stored',
    one(row, 'lg-ft').textContent === rec.result.goals[0] + '–' + rec.result.goals[1],
    one(row, 'lg-ft').textContent);

  const exact = rec.result.goals[0] === p.score[0] && rec.result.goals[1] === p.score[1];
  const flags = els(row, 'lg-flag').map(n => n.textContent);
  ok(tag + ': the exact-score flag appears exactly when the scoreline matched',
    flags.includes('exact score') === exact, [flags, p.score, rec.result.goals]);
}

/* The set has to actually exercise both branches, or the loop above is a loop
   over six identical cases and proves much less than it appears to. */
const marks = RECORDS.map(r => one(L.ledgerRow(r), 'lg-mark').textContent);
ok('the fixture contains at least one hit', marks.includes('✓'), marks);
ok('and at least one miss', marks.includes('✕'), marks);
ok('and at least one unsettled record', marks.includes('·'), marks);
ok('and at least one exact scoreline',
  RECORDS.some(r => els(L.ledgerRow(r), 'lg-flag').some(n => n.textContent === 'exact score')));
ok('and at least one settled record that was NOT an exact scoreline',
  RECORDS.some(r => r.result && !els(L.ledgerRow(r), 'lg-flag').some(n => n.textContent === 'exact score')));

/* The assertion that catches a stored judgement being read instead of derived.
   Change nothing but the score, and the verdict must move. A page reading a
   stored `hit` would sail through every assertion above and fail this one. */
console.log('');
console.log('=== changing the score changes the verdict ===');
{
  const hit = RECORDS.find(r => r.result && one(L.ledgerRow(r), 'lg-mark').textContent === '✓');
  const flipped = { ...hit, result: { ...hit.result, goals: realise(notPick(hit.predicted.pick), true) } };
  ok('a record whose score is rewritten to the other outcome now reads as a miss',
    one(L.ledgerRow(flipped), 'lg-mark').textContent === '✕',
    one(L.ledgerRow(flipped), 'lg-mark').textContent);
  ok('and its "gave it" figure moves to the new outcome',
    one(L.ledgerRow(flipped), 'lg-assigned').textContent ===
      'gave it ' + pctOf(flipped.predicted.probs[INDEX[outcomeOf(flipped.result.goals)]]),
    one(L.ledgerRow(flipped), 'lg-assigned').textContent);
  ok('and the original record is untouched by the copy',
    one(L.ledgerRow(hit), 'lg-mark').textContent === '✓');
}

/* ---------- 4. the row's shape ---------- */
console.log('');
console.log('=== the row is four cells, in the order the header names ===');
const CELLS = ['lg-fixture', 'lg-said', 'lg-happened', 'lg-verdict'];
{
  const row = L.ledgerRow(RECORDS[0]);
  ok('a row has exactly four cells', row.childNodes.length === 4, row.childNodes.length);
  ok('and they are the four named cells, in order',
    row.childNodes.every((n, i) => n.className.split(/\s+/).includes(CELLS[i])),
    row.childNodes.map(n => n.className));

  const mount = new Element('div'), status = new Element('div');
  L.showDay(mount, status, { day: '2026-08-23', records: RECORDS }, 0);
  const head = one(mount, 'lg-h');
  ok('the header has one label per cell', head.childNodes.length === 4, head.childNodes.length);
  ok('and each header label is classed to match its column',
    head.childNodes.every((n, i) => n.className === 'lg-h-' + CELLS[i].slice(3)),
    head.childNodes.map(n => n.className));

  /* rt1's lesson, applied to a grid instead of a table: the columns are declared
     once for the header and the rows together, so a cell count that no longer
     matches the track count would silently wrap a cell onto a second line. */
  const css = readFileSync(new URL('../assets/css/style.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/\.lg-h,\s*\.lg-row \{([^}]*)\}/g)].map(m => m[1]);
  ok('the stylesheet declares the columns for .lg-h and .lg-row together',
    blocks.length === 2, blocks.length);
  const trackCount = block => {
    const m = block.match(/grid-template-columns:\s*([^;]+);/);
    return m ? m[1].replace(/minmax\([^)]*\)/g, 'X').trim().split(/\s+/).length : null;
  };
  ok('the wide layout declares four columns, one per cell',
    trackCount(blocks[0]) === 4, trackCount(blocks[0]));
  ok('the narrow layout declares three, and moves the fourth cell to its own line',
    trackCount(blocks[1]) === 3 && /\.lg-verdict \{[^}]*grid-column: 1 \/ -1/.test(css),
    trackCount(blocks[1]));
}

/* ---------- 5. ordering, and nothing dropped ---------- */
console.log('');
console.log('=== the day reads in kickoff order, and holds every record ===');
{
  const mount = new Element('div'), status = new Element('div');
  L.showDay(mount, status, { day: '2026-08-23', records: RECORDS }, 0);
  const rows = els(mount, 'lg-row');
  ok('one row per record, unsettled ones included',
    rows.length === RECORDS.length, [rows.length, RECORDS.length]);

  /* Handing showDay the records in the order they were built proved nothing:
     predictAll returns its predictions sorted by kickoff, so the list was
     already in order and the sort had nothing to do. The guard below caught
     that, so the input is scrambled here on purpose — and the guard stays, so
     it can catch it again if the fixture ever drifts back into order. */
  const SCRAMBLED = [RECORDS[3], RECORDS[0], RECORDS[5], RECORDS[2], RECORDS[4], RECORDS[1]];
  ok('the input handed to showDay really is out of kickoff order',
    SCRAMBLED.map(r => r.kickoff).join() !== [...SCRAMBLED.map(r => r.kickoff)].sort().join(),
    SCRAMBLED.map(r => r.kickoff));

  const [m2, s2] = [new Element('div'), new Element('div')];
  L.showDay(m2, s2, { day: '2026-08-23', records: SCRAMBLED }, 0);
  const times = els(m2, 'lg-row').map(r => tags(r, 'time')[0].dateTime);
  ok('rows come out in kickoff order regardless', times.join() === [...times].sort().join(), times);
  ok('and showDay did not reorder the caller\'s array to do it',
    SCRAMBLED[0] === RECORDS[3] && SCRAMBLED[1] === RECORDS[0]);

  ok('every kickoff carries a machine-readable datetime',
    times.every(t => /^\d{4}-\d{2}-\d{2}T/.test(t)), times);

  const settled = RECORDS.filter(r => r.result).length;
  const hits = RECORDS.filter(r => r.result && R.score(r).hit).length;
  ok('the status strip counts what was recorded, what finished, and what was right',
    status.textContent.includes(RECORDS.length + ' recorded') &&
    status.textContent.includes(settled + ' finished') &&
    status.textContent.includes(hits + ' correct'),
    status.textContent);
}

/* ---------- 6. the rate gate ---------- */
console.log('');
console.log('=== counts always, a percentage only past MIN_FOR_RATE ===');
{
  const settled = RECORDS.filter(r => r.result);
  const hits = settled.filter(r => R.score(r).hit).length;

  const below = L.tally(RECORDS, MIN_FOR_RATE - 1).textContent;
  const at = L.tally(RECORDS, MIN_FOR_RATE).textContent;

  ok('below the threshold the counts are still published',
    below.includes(hits + ' of ' + settled.length + ' called correctly'), below);
  ok('below the threshold no percentage is published',
    !/\d+% this day/.test(below), below);
  ok('and it says how much record is needed and how much there is',
    below.includes(String(MIN_FOR_RATE)) && below.includes(String(MIN_FOR_RATE - 1)), below);

  ok('at the threshold the percentage appears', /\d+% this day/.test(at), at);
  ok('and it is hits over settled, not hits over everything recorded',
    at.includes(Math.round((hits / settled.length) * 100) + '% this day'), at);

  /* The denominator is the single most misleading thing this page could get
     wrong: dividing by everything recorded would score an unplayed fixture as a
     loss, and the number would still look plausible. */
  ok('the denominator is settled matches, not all records',
    below.includes(' of ' + settled.length + ' ') && !below.includes(' of ' + RECORDS.length + ' '),
    below);

  const none = L.tally(RECORDS.filter(r => !r.result), 0).textContent;
  ok('a day with nothing finished reports that, rather than 0 of 0',
    none.includes('none finished yet') && !none.includes('0 of 0'), none);
}

/* ---------- 7. the day strip ---------- */
console.log('');
console.log('=== the day strip ===');
{
  /* Every call here pins `now`. The strip labels a day relative to today, so a
     suite that let it read the wall clock would test a different code path in
     October than it did in August — and the "Today" branch would go untested on
     every day but one. */
  const FAR = { now: new Date('2026-09-10T12:00:00.000Z') };
  const days = ['2026-08-23', '2026-08-22', '2026-08-20'];
  const picked = [];
  const strip = L.dayStrip(days, '2026-08-22', d => picked.push(d), FAR);
  const btns = strip.childNodes;

  ok('one button per day offered', btns.length === days.length, btns.length);
  ok('every button is a real button, not a styled div',
    btns.every(b => b.tagName === 'button' && b.type === 'button'),
    btns.map(b => b.tagName));
  ok('each carries its day key as data, not just as a label',
    btns.map(b => b.dataset.day).join() === days.join(),
    btns.map(b => b.dataset.day));

  const cur = btns[1];
  ok('the current day is marked with aria-current',
    cur.getAttribute('aria-current') === 'date', cur.getAttribute('aria-current'));
  ok('and is disabled, so it cannot be clicked to reload itself',
    cur.disabled === true, cur.disabled);
  ok('and carries is-on for the eye as well as for assistive software',
    cur.className.includes('is-on'), cur.className);
  ok('no other button is marked current',
    btns.filter(b => b.getAttribute('aria-current')).length === 1,
    btns.map(b => b.getAttribute('aria-current')));

  btns[0].click();
  btns[2].click();
  ok('clicking a day calls back with that day key', picked.join() === '2026-08-23,2026-08-20', picked);
  cur.click();
  ok('and the current day has no handler at all', picked.length === 2, picked);

  ok('the full date stays available on the title, since the label is abbreviated',
    btns.every(b => typeof b.title === 'string' && b.title.length > 4),
    btns.map(b => b.title));
  ok('the strip is a labelled group',
    strip.getAttribute('role') === 'group' && !!strip.getAttribute('aria-label'),
    [strip.getAttribute('role'), strip.getAttribute('aria-label')]);
  ok('it reuses the existing toggle styling rather than inventing a second switch',
    strip.className === 'toggle' && btns.every(b => b.className.includes('toggle-b')),
    strip.className);

  /* Weekday and day number are separate spans so the stylesheet can drop the
     weekday under 34rem. If they were ever merged into one the CSS would still
     parse and the strip would silently stop fitting a phone. */
  ok('an ordinary day renders weekday and number as separate spans',
    els(btns[0], 'daytab-wd').length === 1 && els(btns[0], 'daytab-d').length === 1,
    btns[0].childNodes.map(c => c.className));
  ok('and the number span holds a bare day of the month',
    /^\d{1,2}$/.test(one(btns[0], 'daytab-d').textContent),
    one(btns[0], 'daytab-d').textContent);
  ok('no day is marked today when today is outside the strip',
    btns.every(b => !b.className.includes('is-today')),
    btns.map(b => b.className));

  /* --- the same three days, read on the 23rd --- */
  const NOW23 = { now: new Date('2026-08-23T12:00:00.000Z') };
  const t = L.dayStrip(days, '2026-08-23', () => {}, NOW23).childNodes;

  ok('today is marked is-today, so the strip says which tab is now',
    t[0].className.includes('is-today') &&
    t.slice(1).every(b => !b.className.includes('is-today')),
    t.map(b => b.className));
  ok("today's tab reads Today rather than a date",
    t[0].textContent === 'Today', t[0].textContent);
  ok('and drops the number span, since "Today" needs no date beside it',
    els(t[0], 'daytab-d').length === 0 && els(t[0], 'daytab-wd').length === 1,
    t[0].childNodes.map(c => c.className));
  ok('but keeps the real date on its title, which is the only place it survives',
    /23/.test(t[0].title) && /Today/.test(t[0].title), t[0].title);

  /* Yesterday and tomorrow are worth naming too — the record page is mostly read
     the morning after, and the fixtures page mostly the evening before. */
  ok('the day before today is named, not dated',
    D.dayLabel('2026-08-22', NOW23.now) === 'Yesterday', D.dayLabel('2026-08-22', NOW23.now));
  ok('and the day after',
    D.dayLabel('2026-08-24', NOW23.now) === 'Tomorrow', D.dayLabel('2026-08-24', NOW23.now));
  ok('two days out gets a real date rather than a vaguer word',
    !/day$/.test(D.dayLabel('2026-08-25', NOW23.now)) &&
    D.dayLabel('2026-08-25', NOW23.now).includes('25'),
    D.dayLabel('2026-08-25', NOW23.now));

  /* The heading above the list, the tab above that and the record page's own
     strip all come from dom.js, which is the only reason they cannot disagree
     about which day a 22:00 kickoff belongs to. */
  ok('ledger re-exports the shared strip rather than keeping a second copy',
    L.dayStrip === D.dayStrip, typeof L.dayStrip);
}

/* ---------- 8. the day label survives a hostile timezone ---------- */
console.log('');
console.log('=== a day key is a calendar date, not an instant ===');
{
  /* Formatting the key as UTC midnight labels it a day early everywhere west of
     Greenwich; midday UTC fixes that and then labels it a day late at UTC+13 and
     UTC+14, which are real zones with real readers. Only a local calendar date
     is right in both. Intl reads the zone once at process start, so the only way
     to test this is a child process per zone.

     The same child also reports the four labels either side of a daylight-saving
     change, because two local midnights are 23 or 25 hours apart across one and
     an unrounded division puts "Tomorrow" a day out twice a year. That branch is
     unreachable from a zone without DST, so it has to be tested from inside one.

     dom.js is imported directly rather than through ledger.js: this is where the
     code lives, and the parent process separately asserts the re-export is the
     same function. */
  const src = `
class T { constructor(d){ this.nodeType=3; this.data=String(d); this.childNodes=[]; } get textContent(){ return this.data; } }
class E {
  constructor(t){ this.nodeType=1; this.tagName=t; this.className=''; this.childNodes=[]; this.attributes={}; this.dataset={}; }
  get firstChild(){ return this.childNodes[0] ?? null; }
  append(...n){ for (const x of n) if (x!=null) this.childNodes.push(x); }
  removeChild(n){ const i=this.childNodes.indexOf(n); if(i>=0) this.childNodes.splice(i,1); return n; }
  setAttribute(){} addEventListener(){}
  set textContent(v){ this.childNodes = v==='' ? [] : [new T(v)]; }
  get textContent(){ return this.childNodes.map(c=>c.textContent).join(''); }
}
globalThis.document = { createElement: t=>new E(t), createTextNode: t=>new T(t) };
const D = await import(${JSON.stringify(base + 'dom.js')});

const far = new Date('2026-09-10T12:00:00.000Z');
const b = D.dayStrip(['2026-08-23'], 'not-today', () => {}, { now: far }).childNodes[0];
const dst = (from, to) => D.dayLabel(to, D.dayKeyToDate(from));

/* Hours between the two local midnights. 24 in most zones; 23 or 25 where the
   date spans a daylight-saving change, which is the only case the rounding in
   daysFromToday exists for. Reported so the parent can prove some zone in its
   list actually hit it, rather than assuming. */
const gap = (from, to) => (D.dayKeyToDate(to) - D.dayKeyToDate(from)) / 36e5;

process.stdout.write(JSON.stringify({
  spans: b.childNodes.map(c => c.textContent),
  springFwd: dst('2026-03-29', '2026-03-30'),
  springBack: dst('2026-03-29', '2026-03-28'),
  fallFwd: dst('2026-10-25', '2026-10-26'),
  fallBack: dst('2026-10-25', '2026-10-24'),
  springGap: gap('2026-03-29', '2026-03-30'),
  fallGap: gap('2026-10-25', '2026-10-26'),
}));
`;
  const read = tz => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
      { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    try { return JSON.parse(r.stdout); }
    catch { return { error: 'EXIT' + r.status + ' ' + (r.stderr || '').slice(0, 300) }; }
  };

  /* Chatham is UTC+12:45 and observes DST, so it is hostile on both counts at
     once — and a 45-minute offset breaks any arithmetic that assumes whole
     hours. London is here for the DST branch from a zone we can reason about. */
  const ZONES = [['UTC', '+0'], ['America/Los_Angeles', '-7'], ['Pacific/Kiritimati', '+14'],
                 ['Africa/Lagos', '+1'], ['Europe/London', '+0/+1'], ['Pacific/Chatham', '+12:45']];

  const weekdays = new Set();
  const gaps = new Set();
  for (const [tz, offset] of ZONES) {
    const out = read(tz);
    const where = ' in ' + tz + ' (UTC' + offset + ')';

    ok('2026-08-23 is labelled the 23rd' + where,
      out.spans && out.spans[1] === '23', out);
    if (out.spans) weekdays.add(out.spans[0]);

    /* These four dates straddle the EU changeover; in a zone that switches on
       other dates, or not at all, the same assertion is checking ordinary
       arithmetic. Both are worth having, and the two assertions after the loop
       are what prove the hard case was reached at all. */
    ok('2026-03-30 is "Tomorrow" seen from the 29th' + where,
      out.springFwd === 'Tomorrow', out.springFwd);
    ok('and 2026-03-28 "Yesterday"' + where,
      out.springBack === 'Yesterday', out.springBack);
    ok('2026-10-26 is "Tomorrow" seen from the 25th' + where,
      out.fallFwd === 'Tomorrow', out.fallFwd);
    ok('and 2026-10-24 "Yesterday"' + where,
      out.fallBack === 'Yesterday', out.fallBack);

    gaps.add(out.springGap); gaps.add(out.fallGap);
  }

  /* A calendar date has one weekday, so every zone must agree on it. This catches
     a one-day shift without hard-coding an English weekday name into the suite. */
  ok('every zone agrees which weekday 2026-08-23 was',
    weekdays.size === 1, [...weekdays]);

  /* The meta-assertions. Without these the four labels above could all be
     passing on 24-hour days, and Math.round could be Math.floor with nothing to
     show it. A 23-hour day is where floor rounds down to 0 and "Tomorrow" turns
     into "Today". */
  ok('some zone in the list really has a 23-hour day, so the rounding was tested',
    gaps.has(23), [...gaps].sort((a, b) => a - b));
  ok('and some zone a 25-hour one',
    gaps.has(25), [...gaps].sort((a, b) => a - b));
}

/* ---------- 9. the states ---------- */
console.log('');
console.log('=== the four things this page can say instead of a record ===');
{
  const mk = () => [new Element('div'), new Element('div')];

  let [m, s] = mk();
  L.showLoading(m, s);
  ok('loading draws skeleton rows rather than a spinner',
    els(m, 'lg-row').length > 0 && els(m, 'lg-row').every(r => r.className.includes('is-skeleton')),
    els(m, 'lg-row').map(r => r.className));
  ok('and the skeleton has one placeholder per column',
    els(m, 'lg-row')[0].childNodes.length === CELLS.length,
    els(m, 'lg-row')[0].childNodes.length);

  [m, s] = mk();
  L.showNoArchive(m, s);
  const noArchive = m.textContent;
  ok('an empty archive says the record has not started yet',
    els(m, 'notice').length === 1 && /nothing has been recorded/i.test(noArchive), noArchive);
  ok('and does not imply a failure', !/error|failed|could not/i.test(noArchive), noArchive);

  [m, s] = mk();
  L.showEmptyDay(m, s, '2026-08-20');
  ok('a day with no football is a different message from an empty archive',
    m.textContent !== noArchive && /no predictions for/i.test(m.textContent), m.textContent);

  [m, s] = mk();
  L.showNotServed(m, s);
  ok('opening the page from disk is named, not reported as a load failure',
    /web server/i.test(m.textContent) && /http\.server/.test(m.textContent), m.textContent);
  ok('and it is marked as a warning',
    one(m, 'notice').className.includes('is-warn'), one(m, 'notice').className);

  [m, s] = mk();
  L.showDay(m, s, { day: '2026-08-20', records: [] }, 0);
  ok('showDay with no records falls through to the empty-day message',
    /no predictions for/i.test(m.textContent), m.textContent);
}

/* ---------- 10. no markup can reach the page ---------- */
console.log('');
console.log('=== a team name is text, and can only ever be text ===');
{
  /* Comments are stripped first. Both files say in prose that they follow the
     no-innerHTML rule, and a bare grep counted the sentence describing the rule
     as a breach of it — which would have taught the next person to delete the
     comment to get the suite green. The rule is about code. */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const src = strip(readFileSync(new URL('../assets/js/ledger.js', import.meta.url), 'utf8'));
  const boot = strip(readFileSync(new URL('../assets/js/verdicts.js', import.meta.url), 'utf8'));
  ok('the comment stripper left real code behind',
    src.includes('export function ledgerRow') && !src.includes('no innerHTML rule'),
    src.length);
  ok('ledger.js never touches innerHTML', !/innerHTML/.test(src));
  ok('verdicts.js never touches innerHTML', !/innerHTML/.test(boot));
  ok('nor outerHTML or insertAdjacentHTML anywhere',
    !/outerHTML|insertAdjacentHTML|document\.write/.test(src + boot));

  const hostile = RECORDS.find(r => r.home.name === HOSTILE || r.away.name === HOSTILE);
  ok('the fixture really does contain a hostile team name', !!hostile);
  const row = L.ledgerRow(hostile);
  const names = els(row, 'lg-team').map(n => n.textContent);
  ok('the hostile name arrives intact, as a single text node',
    names.includes(HOSTILE), names);
  ok('and no element was created from it',
    tags(row, 'img').length === 0 && walk(row).every(n => n.nodeType !== 1 || n.tagName !== 'script'),
    tags(row, 'img').length);
  /* r1's assertion, not a grep: nothing in the tree was ever handed markup,
     whatever the source says. */
  ok('no node in a rendered row has innerHTML set at all',
    !walk(row).some(n => 'innerHTML' in n));
}

/* ---------- 11. every class emitted is styled ---------- */
console.log('');
console.log('=== nothing renders under a class the stylesheet has never heard of ===');
{
  const css = readFileSync(new URL('../assets/css/style.css', import.meta.url), 'utf8');
  const seen = new Set();
  const collect = node => walk(node).forEach(n => {
    if (n.nodeType !== 1) return;
    n.className.split(/\s+/).filter(Boolean).forEach(c => seen.add(c));
  });

  const [m, s] = [new Element('div'), new Element('div')];
  L.showDay(m, s, { day: '2026-08-23', records: RECORDS }, MIN_FOR_RATE);
  collect(m); collect(s);
  /* `now` pinned to one of the two days, so both branches of the strip emit —
     today's single-span tab and an ordinary two-span one. Left to the wall clock
     the is-today rule would go unchecked on 364 days out of 365. */
  collect(L.dayStrip(['2026-08-23', '2026-08-22'], '2026-08-23', () => {},
    { now: new Date('2026-08-23T12:00:00.000Z') }));
  const skel = new Element('div');
  L.showLoading(skel, new Element('div'));
  collect(skel);

  /* Scoped to this page's own classes, plus the day strip's, which this page and
     the fixtures page share. dom.js's furniture — notice, status, sk — is styled
     and asserted by r1, and re-checking it here would mean two suites failing
     for one cause. */
  const mine = [...seen]
    .filter(c => c.startsWith('lg-') || c.startsWith('is-') || c.startsWith('daytab'))
    .sort();
  console.log('    ' + mine.length + ' classes: ' + mine.join(' '));
  ok('the page emits a non-trivial number of its own classes', mine.length >= 20, mine.length);
  ok('the day strip really was collected, so its classes are among them',
    mine.includes('daytab') && mine.includes('is-today'), mine.filter(c => c.startsWith('daytab')));
  for (const c of mine) {
    ok('.' + c + ' is styled', new RegExp('\\.' + c + '(?![\\w-])').test(css));
  }
}

/* ---------- 12. the page and its boot module agree ---------- */
console.log('');
console.log('=== record.html and verdicts.js agree about the page ===');
{
  const html = readFileSync(new URL('../record.html', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../assets/js/verdicts.js', import.meta.url), 'utf8');

  const ids = [...boot.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  ok('verdicts.js looks up at least three nodes', ids.length >= 3, ids);
  for (const id of ids) {
    ok('record.html has an element with id="' + id + '"', html.includes('id="' + id + '"'), id);
  }

  ok('record.html loads verdicts.js as a module',
    /<script type="module" src="assets\/js\/verdicts\.js"><\/script>/.test(html));
  ok('the skip link points at a target that exists',
    (() => {
      const m = html.match(/class="skip" href="#([^"]+)"/);
      return m && html.includes('id="' + m[1] + '"');
    })());

  /* The same documentation-drift guard h1.mjs puts on method.html. A number
     written into the prose is a promise, and this is what keeps it one. */
  const cfgs = [...html.matchAll(/data-cfg="([^"]+)">([^<]*)</g)];
  ok('record.html states at least two config numbers in its prose', cfgs.length >= 2, cfgs.length);
  const resolve = path => path.split('.').reduce((o, k) => o?.[k], C);
  for (const [, path, text] of cfgs) {
    ok('data-cfg ' + path + ' matches config.js',
      String(resolve(path)) === text.trim(), [path, text.trim(), resolve(path)]);
  }

  /* The nav used to be checked here, and it belongs in h1 instead: this suite is
     about the record page, and the bar is on all four. h1 now holds the four
     copies byte-identical rather than merely agreeing on link order, which is
     what this version could see. Do not re-add it — two regexes over the same
     markup means the weaker one drifts and starts passing for the wrong reason,
     and that is precisely what happened: this one matched `<nav class="nav">`
     exactly, so adding an aria-label to the element broke it. */
}

console.log('');
console.log(fails ? fails + ' failing' : 'v1 ok');
process.exit(fails ? 1 : 0);
