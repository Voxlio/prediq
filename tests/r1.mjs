/* render.js against real model output, on a minimal DOM shim.
   render.js never uses innerHTML, so the serializer below is the ONLY thing in
   this test that can produce markup — which is exactly the property we check. */

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;

/* ---------- 1. the shim ---------- */
const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.childNodes = []; }
  get textContent() { return this.data; }
}
class Element {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.namespaceURI = ns || XHTML;
    this.className = '';
    this.childNodes = []; this.attributes = {}; this.listeners = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...ns) { for (const n of ns) if (n != null) this.childNodes.push(n); }
  appendChild(n) { this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  /* Honours `disabled`, as a browser does. Without that a dead chevron would
     still fire here and the assertion that it does nothing would be about this
     shim rather than about the page. */
  click() { if (this.disabled) return; (this.listeners.click || []).forEach(fn => fn()); }
  set textContent(v) { this.childNodes = v === '' ? [] : [new TextNode(v)]; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
}
globalThis.document = {
  createElement: t => new Element(t),
  /* Icons need this. In a browser document.createElement('svg') returns an
     HTMLUnknownElement that renders absolutely nothing and reports no error, so
     the namespace is not a formality. */
  createElementNS: (ns, t) => new Element(t, ns),
  createTextNode: t => new TextNode(t),
};

/* An element's classes, from wherever they were set.
   HTML elements get them through .className; an SVG element cannot, because
   there .className is a read-only SVGAnimatedString, so dom.js's icon() sets the
   attribute instead. The two are kept SEPARATE here on purpose. Aliasing them
   would be the friendlier shim and would also let someone "simplify" icon() back
   to el() + className, watch every assertion below still pass, and ship chevrons
   with no class and therefore no fill:none — solid black wedges in every
   browser. The asymmetry is the test. */
const clsOf = n => n.className || n.attributes.class || '';
const hasCls = (n, c) => clsOf(n).split(/\s+/).includes(c);

const walk = (n, out = []) => { out.push(n); n.childNodes.forEach(c => walk(c, out)); return out; };
const els = (n, cls) => walk(n).filter(x => x.nodeType === 1 && hasCls(x, cls));
const texts = n => walk(n).filter(x => x.nodeType === 3);

function show(n, depth = 0) {
  const pad = '  '.repeat(depth + 2);
  if (n.nodeType === 3) return n.data.trim() ? pad + '"' + n.data + '"\n' : '';
  const cls = clsOf(n) ? ' .' + clsOf(n).split(/\s+/).join('.') : '';
  const attrs = Object.entries(n.attributes).map(([k, v]) => ' ' + k + '="' + v + '"').join('');
  return pad + n.tagName + cls + attrs + '\n' + n.childNodes.map(c => show(c, depth + 1)).join('');
}

/* ---------- 2. harness ---------- */
let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };

const M = await import(base + 'model.js');
const V = await import(base + 'render.js');
const { MODEL, LEAGUES } = await import(base + 'config.js');

/* ---------- 3. the same Premier League data the model suite uses ---------- */
const PREV = [
  ['1','Liverpool',86,41], ['2','Arsenal',69,34], ['3','Man City',72,44], ['4','Chelsea',64,43],
  ['5','Newcastle',68,47], ['6','Aston Villa',58,51], ['7','Nottm Forest',58,46], ['8','Brighton',66,59],
  ['9','Bournemouth',58,46], ['10','Brentford',66,57], ['11','Fulham',54,54], ['12','Crystal Palace',51,51],
  ['13','Everton',42,44], ['14','West Ham',46,62], ['15','Man United',44,54], ['16','Wolves',54,69],
  ['17','Tottenham',64,65], ['18','Leicester',33,80], ['19','Ipswich',36,82], ['20','Southampton',26,86],
].map(([id, name, gf, ga]) => ({ id, name, short: name, gp: 38, gf, ga, rank: +id }));

/* Crests exist for some teams and not others, because that is the real state
   of the ESPN payloads — a missing one must cost an icon and nothing else. */
const CREST = id => 'https://a.espncdn.com/i/teamlogos/soccer/500/' + id + '.png';
const HAS_CREST = new Set(['2', '4', '6', '8', '21']);
for (const t of PREV) if (HAS_CREST.has(t.id)) t.logo = CREST(t.id);

const NOW = PREV.slice(0, 17).map(t => ({ ...t, gp: 0, gf: 0, ga: 0 }))
  .concat([['21','Leeds'], ['22','Burnley'], ['23','Sunderland']]
    .map(([id, name]) => ({ id, name, short: name, gp: 0, gf: 0, ga: 0, rank: null,
                            logo: HAS_CREST.has(id) ? CREST(id) : null })));

/* one hostile name, to prove it can only ever land in a text node */
const HOSTILE = '<img src=x onerror=alert(1)>';
NOW.push({ id: '24', name: HOSTILE, short: 'XSS', gp: 0, gf: 0, ga: 0, rank: null });
PREV.push({ id: '24', name: HOSTILE, short: 'XSS', gp: 38, gf: 50, ga: 50, rank: 10 });

const R = (h, a, hg, ag, date, logos = {}) => ({
  date,
  home: { id: h, name: '', g: hg, logo: logos.home ?? null },
  away: { id: a, name: '', g: ag, logo: logos.away ?? null },
});
const RESULTS = [
  R('2','12',3,0,'2026-08-15', { away: CREST('12') }),   /* the only crest team 12 gets */ R('1','21',2,1,'2026-08-15'), R('4','22',1,1,'2026-08-16'),
  R('3','23',4,0,'2026-08-16'), R('5','13',2,2,'2026-08-16'), R('15','8',0,2,'2026-08-17'),
];

const hrs = h => new Date(Date.now() + h * 3600e3).toISOString();
const nameOf = id => (NOW.find(t => t.id === id) || { name: 'Unknown FC' }).name;
const F = (id, h, a, hrsOut, odds = null, slug = 'eng.1') => ({
  id, leagueSlug: slug, date: hrs(hrsOut), venue: null,
  home: { id: h, name: nameOf(h), short: '', form: null },
  away: { id: a, name: nameOf(a), short: '', form: null },
  odds,
});

const FIXTURES = [
  F('f1', '1', '16', 3),
  F('f2', '11', '12', 6, { home: 0.40, draw: 0.28, away: 0.32, overround: 1.06, overUnder: 2.5, provider: 'DraftKings' }),
  F('f3', '21', '2', 27),
  F('f4', '24', '1', 30),
  F('f5', '999', '1', 52),
];

const bucket = { standingsNow: NOW, standingsPrev: PREV, results: RESULTS };
const data = {
  season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: Date.now(),
  fixtures: FIXTURES, byLeague: { 'eng.1': bucket },
};
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) data.byLeague[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };

const { index, predictions } = M.predictAll(data);

/* ---------- 4. one priced card, in full ---------- */
console.log('=== a priced card, as the browser will build it ===');
const p1 = predictions.find(p => p.fixture.id === 'f1');
const c1 = V.matchCard(p1, 0);
console.log(show(c1).replace(/\n$/, ''));

ok('renders an <article class="match">', c1.tagName === 'article' && c1.className === 'match', c1.className);
ok('three outcome rows', els(c1, 'outcome').length === 3, els(c1, 'outcome').length);
ok('exactly one is-pick', els(c1, 'is-pick').length === 1, els(c1, 'is-pick').length);
const shown = els(c1, 'outcome-pct').map(n => parseInt(n.textContent, 10));
ok('displayed percentages sum to 100', shown.reduce((a, b) => a + b, 0) === 100, shown);
ok('bar widths match the percentages',
  els(c1, 'outcome-bar').every((b, i) => b.firstChild.style.props['--w'] === shown[i] + '%'),
  els(c1, 'outcome-bar').map(b => b.firstChild.style.props['--w']));
ok('meter lit to the confidence level', els(c1, 'on').length === p1.conf.level, [els(c1, 'on').length, p1.conf.level]);
ok('meter carries an aria-label',
  /Confidence: \w+, \d of 4/.test(els(c1, 'meter')[0].getAttribute('aria-label')),
  els(c1, 'meter')[0].getAttribute('aria-label'));
const terms = walk(c1).filter(n => n.tagName === 'dt').map(n => n.textContent);
ok('four model fields when unpriced by the book', JSON.stringify(terms) === '["xG","score","o2.5","btts"]', terms);
ok('kickoff has a machine-readable datetime', els(c1, 'kick')[0].dateTime === p1.fixture.date, els(c1, 'kick')[0].dateTime);
ok('card carries its stagger index', c1.style.props['--i'] === '0', c1.style.props);

/* ---------- 5. emphasis markers must not leak ---------- */
console.log('');
console.log('=== insight emphasis ===');
const allCards = predictions.map((p, i) => V.matchCard(p, i));
const everyText = allCards.flatMap(c => texts(c).map(t => t.data));
ok('no literal asterisk reaches the page', !everyText.some(t => t.includes('*')), everyText.filter(t => t.includes('*')));
const bolds = allCards.flatMap(c => walk(c).filter(n => n.tagName === 'b'));
ok('emphasis became real <b> elements', bolds.length > 0, bolds.length);
ok('no <b> is empty', bolds.every(b => b.textContent.trim().length), bolds.map(b => b.textContent));
allCards.forEach((c, i) => {
  const n = els(c, 'insights').length ? els(c, 'insights')[0].childNodes.length : 0;
  if (n) ok('card ' + i + ': ' + n + ' insight lines, within the cap of ' + MODEL.INSIGHT_MAX, n <= MODEL.INSIGHT_MAX, n);
});

/* ---------- 6. the market row ---------- */
console.log('');
console.log('=== market comparison ===');
const c2 = allCards[predictions.findIndex(p => p.fixture.id === 'f2')];
const terms2 = walk(c2).filter(n => n.tagName === 'dt').map(n => n.textContent);
ok('fifth field appears only with odds', terms2.length === 5 && terms2[4] === 'mkt', terms2);
const mkt = walk(c2).filter(n => n.tagName === 'dd').pop();
ok('shows the book as home/draw/away', /^\d+\/\d+\/\d+$/.test(mkt.textContent), mkt.textContent);
ok('book trio sums to 100 after de-margining', mkt.textContent.split('/').reduce((a, b) => a + +b, 0) === 100, mkt.textContent);
const tip = walk(c2).find(n => n.title && n.title.includes('DraftKings'));
ok('names the provider and the removed margin', !!tip && /6% margin removed/.test(tip.title), tip && tip.title);
ok('states it is not a model input', !!tip && /not an input to the model/.test(tip.title));

/* ---------- 7. hostile input ---------- */
console.log('');
console.log('=== a hostile team name ===');
const c4 = allCards[predictions.findIndex(p => p.fixture.id === 'f4')];
const hostile = texts(c4).find(t => t.data.includes('onerror'));
ok('lands in a text node, verbatim', !!hostile && hostile.data === HOSTILE && hostile.nodeType === 3, hostile && hostile.data);
ok('no element in the tree has innerHTML set', !walk(c4).some(n => 'innerHTML' in n));

/* ---------- 8. the refused fixture ---------- */
console.log('');
console.log('=== a fixture the model refuses ===');
const c5 = allCards[predictions.findIndex(p => p.fixture.id === 'f5')];
console.log(show(c5).replace(/\n$/, ''));
ok('dashed blank card', c5.className === 'match is-blank', c5.className);
ok('still names both sides', els(c5, 'blank-teams').length === 1);
ok('carries a readable reason', els(c5, 'blank-note')[0].textContent.length > 30);
ok('no outcome bars on a blank card', els(c5, 'outcome').length === 0);

/* ---------- 9. page states ---------- */
console.log('');
console.log('=== page states ===');
const mount = new Element('main'), status = new Element('div');

V.showLoading(mount, status);
ok('loading: three skeletons', els(mount, 'is-skeleton').length === 3);
ok('loading: skeletons hidden from screen readers', els(mount, 'is-skeleton').every(s => s.getAttribute('aria-hidden') === 'true'));
ok('loading: status reads plainly', status.textContent === 'loading fixtures', status.textContent);

V.showProgress(status, 4, 14);
ok('progress: counts requests', status.textContent.includes('4/14 requests'), status.textContent);

V.showFatal(mount, status, 'test message');
ok('fatal: one warning notice', els(mount, 'notice').length === 1 && els(mount, 'is-warn').length === 1);
ok('fatal: shows the message given', mount.textContent.includes('test message'));
ok('fatal: no cards left behind', els(mount, 'match').length === 0);

V.showEmpty(mount, status, 7);
ok('empty: explains the quiet week', mount.textContent.includes('next 7 days'), mount.textContent.slice(0, 60));
ok('empty: reports zero fixtures', status.textContent.includes('0 fixtures'), status.textContent);

V.showPredictions(mount, status, predictions, index, data);
console.log('    status strip: ' + status.textContent);
ok('full page: one card per fixture', els(mount, 'match').length === predictions.length, [els(mount, 'match').length, predictions.length]);
const days = new Set(predictions.map(p => new Date(p.fixture.date).toDateString()));
ok('full page: one divider per day', els(mount, 'day').length === days.size, [els(mount, 'day').length, days.size, [...days]]);
console.log('    dividers: ' + els(mount, 'day').map(d => d.textContent).join(' | '));
ok('full page: counts fixtures and leagues',
  status.textContent.includes(predictions.length + ' fixtures') && status.textContent.includes('1 league'), status.textContent);
ok('full page: reports the unpriced one', status.textContent.includes('1 unpriced'), status.textContent);
ok('full page: no error notice when nothing failed', els(mount, 'notice').length === 0);

V.showPredictions(mount, status, predictions, index,
  { ...data, errors: [{ league: 'Bundesliga', url: 'x' }, { league: 'Bundesliga', url: 'y' }] });
ok('partial failure: says so, once, naming the league',
  els(mount, 'notice').length === 1 && mount.textContent.includes('Bundesliga') && mount.textContent.includes('2 requests failed'));
ok('partial failure: still renders every card', els(mount, 'match').length === predictions.length);

/* ---------- 10. every class we emit must exist in the stylesheet ---------- */
console.log('');
/* ---------- the recent form strip ---------- */
console.log('=== recent form strip ===');

/* Recompute what the strip SHOULD say straight from RESULTS, independently of
   the model, so this checks the feature rather than restating it. */
function expectedForm(teamId) {
  return RESULTS
    .filter(r => r.home.id === teamId || r.away.id === teamId)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-5).reverse()
    .map(r => {
      const home = r.home.id === teamId;
      const gf = home ? r.home.g : r.away.g, ga = home ? r.away.g : r.home.g;
      return { mark: gf > ga ? 'W' : gf === ga ? 'D' : 'L', gf, ga, atHome: home };
    });
}

/* A unit is a crest plus a scoreline. The result letter is read off the class,
   never off the text, because the text is now digits — which is the whole point
   of the redesign and worth asserting rather than assuming. */
const unitsOf = card => els(card, 'form-runs')
  .map(r => r.childNodes.filter(n => n.nodeType === 1 && hasCls(n, 'form-game')));
const letterOf = u => (u.className.match(/\bis-([wdl])\b/) || [, '?'])[1].toUpperCase();
const scoreOf  = u => (els(u, 'form-score')[0] || { textContent: '' }).textContent;

ok('the card carries a form row', els(c1, 'form-row').length === 1, els(c1, 'form-row').length);
ok('one strip per side', els(c1, 'form-runs').length === 2, els(c1, 'form-runs').length);

const want1 = expectedForm('1');
const units1 = unitsOf(c1)[0];
console.log('    home side 1: expected ' + want1.map(x => x.mark + ' ' + x.gf + '-' + x.ga).join(', '));
console.log('    home side 1: rendered ' + units1.map(u => letterOf(u) + ' ' + scoreOf(u)).join(', '));

ok('one unit per match, in order',
  units1.map(letterOf).join('') === want1.map(x => x.mark).join(''),
  [units1.map(letterOf), want1.map(x => x.mark)]);
ok('each unit prints the scoreline with the team’s own goals first',
  units1.every((u, i) => scoreOf(u) === want1[i].gf + '–' + want1[i].ga),
  units1.map(scoreOf));
ok('a side with no matches says so rather than showing a fake run',
  expectedForm('16').length === 0 && els(c1, 'form-none').length === 1 && unitsOf(c1)[1].length === 0,
  els(c1, 'form-none').map(n => n.textContent));

/* The colour must be redundant. This is the check that keeps it that way: an
   away win has to read as a win from the digits, not from the background. */
const away8 = M.recentForm(index.teams.get('8'), index);
const cardOf = form => V.matchCard({ ...predictions[0], form: { home: form, away: [] } }, 0);
const u8 = unitsOf(cardOf(away8))[0][0];
ok('an away 0-2 win is printed 2–0, so the digits alone say who won',
  away8[0].atHome === false && scoreOf(u8) === '2–0' && letterOf(u8) === 'W',
  [away8[0], scoreOf(u8), u8.className]);

/* --- the tooltip carries everything the unit itself cannot show --- */
ok('every unit carries its scoreline as a tooltip',
  units1.every((u, i) => u.title && u.title.startsWith(want1[i].gf + '–' + want1[i].ga)),
  units1.map(u => u.title));
ok('the tooltip says v at home and at away',
  units1.every((u, i) => u.title.includes(want1[i].atHome ? ' v ' : ' at ')),
  units1.map(u => u.title));
ok('the tooltip names the opponent',
  units1.every(u => u.title.length > 6 && !/undefined|null/.test(u.title)),
  units1.map(u => u.title));
ok('the tooltip carries the date, since the unit has no room for it',
  units1.every(u => / · \d{1,2} \w{3,}/.test(u.title)),
  units1.map(u => u.title));

/* --- what a screen reader gets: one sentence per side, not fifty fragments -- */
const strips1 = els(c1, 'form-runs');
const labelOf = r => r.getAttribute('aria-label') || '';

ok('each strip is announced as one image, so its contents are not spelled out',
  strips1.every(r => r.getAttribute('role') === 'img'),
  strips1.map(r => r.getAttribute('role')));
ok('EVERY strip carries a summary, including the side with no matches',
  strips1.length === 2 && strips1.every(r => labelOf(r).length > 10),
  strips1.map(labelOf));
ok('each summary names its own team, since role=img hides everything else',
  labelOf(strips1[0]).startsWith(p1.home.short || p1.home.name) &&
  labelOf(strips1[1]).startsWith(p1.away.short || p1.away.name),
  strips1.map(labelOf));
ok('the visible team label is hidden from assistive tech, so it is said once',
  els(c1, 'form-team').every(n => n.getAttribute('aria-hidden') === 'true'),
  els(c1, 'form-team').map(n => n.getAttribute('aria-hidden')));
ok('the summary says won, drew or lost in words, not W, D or L',
  /\b(won|drew|lost)\b/.test(labelOf(strips1[0])) &&
  !/\bW\b|\bD\b|\bL\b/.test(labelOf(strips1[0])),
  labelOf(strips1[0]));
ok('the summary reports the same number of matches it drew',
  labelOf(strips1[0]).includes('last ' + units1.length),
  labelOf(strips1[0]));
ok('the empty side is described rather than left as a bare phrase',
  /no matches/.test(labelOf(strips1[1])), labelOf(strips1[1]));

/* --- crests: present, absent, and never load-bearing --------------------- */
console.log('');
console.log('=== crests ===');
ok('a crest arrives from the standings payload',
  index.teams.get('21').logo === CREST('21'), index.teams.get('21').logo);
ok('a crest missing from standings is backfilled from a result',
  index.teams.get('12').logo === CREST('12'), index.teams.get('12').logo);
ok('a team with no crest anywhere keeps null rather than a broken url',
  index.teams.get('13').logo === null, index.teams.get('13').logo);

const crest1 = els(c1, 'form-crest')[0];
ok('a known crest renders as an image', crest1.tagName === 'img' && crest1.src === CREST('21'),
  [crest1.tagName, crest1.src]);
ok('the crest image is marked decorative and deferred',
  crest1.alt === '' && crest1.loading === 'lazy' && crest1.width === 14,
  [crest1.alt, crest1.loading, crest1.width]);

/* A team the model never fitted yields no form at all. */
ok('a team the model never fitted yields no form', M.recentForm(undefined, index).length === 0);

/* RESULTS only give any one side a single match, so the five-match cap and the
   ordering need a longer log than the fixture data can supply. */
const synthetic = { log: [
  { opp: '2', gf: 0, ga: 3, atHome: false, date: '2026-08-01' },   /* oldest */
  { opp: '3', gf: 1, ga: 1, atHome: true,  date: '2026-08-04' },
  { opp: '4', gf: 2, ga: 0, atHome: true,  date: '2026-08-08' },
  { opp: '5', gf: 0, ga: 0, atHome: false, date: '2026-08-12' },
  { opp: '6', gf: 4, ga: 1, atHome: true,  date: '2026-08-15' },
  { opp: '7', gf: 1, ga: 2, atHome: false, date: '2026-08-18' },
  { opp: '8', gf: 3, ga: 1, atHome: true,  date: '2026-08-22' },   /* newest */
]};
const sf = M.recentForm(synthetic, index);
console.log('    seven-match log renders as ' + sf.map(x => x.result).join(''));
ok('a seven-match log is cut to five', sf.length === 5, sf.length);
ok('the five kept are the five most recent, newest first',
  sf.map(x => x.result).join('') === 'WLWDW', sf.map(x => x.result).join(''));
ok('the 3-0 defeat that fell outside the window is gone',
  !sf.some(x => x.gf === 0 && x.ga === 3), sf);
ok('venue survives the reversal',
  sf[0].atHome === true && sf[1].atHome === false, sf.map(x => x.atHome));
ok('opponent ids resolve to names where known',
  sf.every(x => typeof x.opp === 'string' && x.opp.length > 0), sf.map(x => x.opp));
ok('form is capped at five entries', M.recentForm(index.teams.get('1'), index, 5).length <= 5);

const strip = cardOf(sf);
const units5 = unitsOf(strip)[0];
ok('five units render for a five-match strip', units5.length === 5, units5.length);
ok('the strip mixes real crests and lettered stand-ins without breaking',
  els(strip, 'form-crest').length === 5 &&
  els(strip, 'form-crest').filter(c => c.tagName === 'img').length === 3 &&
  els(strip, 'is-none').length === 2,
  els(strip, 'form-crest').map(c => c.tagName));
ok('a lettered stand-in is one uppercase initial, never a url',
  els(strip, 'is-none').every(c => /^[A-Z0-9?]$/.test(c.textContent)),
  els(strip, 'is-none').map(c => c.textContent));
ok('a missing crest costs the icon and nothing else — the score still prints',
  units5.every(u => /^\d+–\d+$/.test(scoreOf(u))), units5.map(scoreOf));


ok('form never appears on a card the model refused',
  !els(V.matchCard(predictions.find(p => !p.ok), 0), 'form-row').length);

/* ---------- the two-phase page ----------
   Phase 1 draws every fixture before any prediction exists. The property that
   matters is not that it looks busy but that it does not lie and does not move:
   no probability may appear before it is known, and when the predictions land
   the list must be in the same order with the same day dividers. A list that
   reorganises itself under the reader is worse than one that arrived later. */
console.log('');
console.log('=== phase 1: fixtures before predictions ===');
const pmount = new Element('main'), pstatus = new Element('div');
const fixturesOnly = predictions.map(p => p.fixture);

V.showFixtureList(pmount, pstatus, fixturesOnly);
console.log('    ' + els(pmount, 'is-pending').length + ' pending cards, status: ' + pstatus.textContent);
ok('phase 1: one card per fixture, none omitted',
  els(pmount, 'match').length === fixturesOnly.length,
  [els(pmount, 'match').length, fixturesOnly.length]);
ok('phase 1: every card is marked pending',
  els(pmount, 'is-pending').length === fixturesOnly.length);
ok('phase 1: each card says a prediction is coming',
  els(pmount, 'is-pending').every(c => /Working out the prediction/.test(c.textContent)));
ok('phase 1: not one probability is shown before it is known',
  els(pmount, 'outcome').length === 0 && !pmount.textContent.includes('%'),
  pmount.textContent.slice(0, 90));
ok('phase 1: pending is kept distinct from the refusal state',
  els(pmount, 'is-blank').length === 0);
ok('phase 1: the competition and kickoff are already on the card',
  els(pmount, 'comp').length === fixturesOnly.length &&
  els(pmount, 'kick').length === fixturesOnly.length);
ok('phase 1: the status strip counts only what it actually has',
  pstatus.textContent.includes(fixturesOnly.length + ' fixtures') &&
  !pstatus.textContent.includes('fitted'), pstatus.textContent);

const dayText = root => els(root, 'day').map(d => d.textContent);
const layout = root => walk(root)
  .filter(n => n.nodeType === 1 && (hasCls(n, 'match') || hasCls(n, 'day')))
  .map(n => hasCls(n, 'day') ? 'DAY ' + n.textContent : 'card');
const beforeDays = dayText(pmount), beforeLayout = layout(pmount);

V.showPredictions(pmount, pstatus, predictions, index, data);
ok('the day dividers are identical once the predictions land',
  JSON.stringify(dayText(pmount)) === JSON.stringify(beforeDays),
  [beforeDays, dayText(pmount)]);
ok('and so is the card order — the list never reorganises itself',
  JSON.stringify(layout(pmount)) === JSON.stringify(beforeLayout),
  [beforeLayout.length, layout(pmount).length]);
ok('phase 2 replaces the pending cards rather than appending to them',
  els(pmount, 'is-pending').length === 0 && els(pmount, 'match').length === predictions.length,
  [els(pmount, 'is-pending').length, els(pmount, 'match').length]);

/* Phase 1 worked, phase 2 did not. The fixtures on screen are still true, so
   they must survive — but every claim that a prediction is coming has to go. */
console.log('');
console.log('=== phase 2 failed, phase 1 did not ===');
const fmount = new Element('main'), fstatus = new Element('div');
V.showFixtureFallback(fmount, fstatus, fixturesOnly, 'HTTP 503');
ok('fallback: keeps every fixture rather than throwing the page away',
  els(fmount, 'match').length === fixturesOnly.length);
ok('fallback: one warning, naming which half is missing',
  els(fmount, 'notice').length === 1 && els(fmount, 'is-warn').length === 1 &&
  fmount.textContent.includes('Fixtures loaded, predictions did not'));
ok('fallback: passes the underlying reason through', fmount.textContent.includes('HTTP 503'));
ok('fallback: stops promising a prediction that is not coming',
  !fmount.textContent.includes('Working out') && fmount.textContent.includes('No prediction'));
ok('fallback: invents no probabilities in their place',
  els(fmount, 'outcome').length === 0 && !fmount.textContent.includes('%'));
ok('fallback: the status strip admits it has no predictions',
  fstatus.textContent.includes('no predictions'), fstatus.textContent);

/* ---------- 11. the pager ----------
   Twelve fixtures on one calendar day, at fixed offsets from a fixed hour, so
   the arithmetic below never depends on what time the suite is run at. */
console.log('');
console.log('=== the pager ===');
{
  const { PAGE_SIZE } = await import(base + 'config.js');
  const many = Array.from({ length: 12 }, (_, i) => F('p' + i, '1', '16', 3 + i * 0.1));

  /* One render, with `page` as the request. Returns everything worth asserting
     about, so each case below is three lines rather than thirty. */
  let asked = [];
  const draw = (page, list = many, size = 5) => {
    const m = new Element('main'), s = new Element('div');
    asked = [];
    V.showFixtureList(m, s, list, null,
      { page, size, onPage: n => asked.push(n) });
    const box = els(m, 'pager')[0] ?? null;
    const btns = box ? els(box, 'pager-b') : [];
    return { m, s, box, btns,
      cards: els(m, 'match').length,
      label: box ? els(box, 'pager-n')[0].textContent : null,
      ids: els(m, 'kick').map(t => t.dateTime) };
  };

  const p0 = draw(0);
  console.log('    ' + show(p0.box).trimEnd());
  ok('a page shows five cards, not twelve', p0.cards === 5, p0.cards);
  ok('the pager says which five, and how many there are', p0.label === '1–5 of 12', p0.label);
  ok('the range uses an en dash rather than a hyphen, like every other range on the site',
    p0.label.includes('–') && !p0.label.includes('-'), p0.label);
  ok('two controls, both real buttons of type button',
    p0.btns.length === 2 && p0.btns.every(b => b.tagName === 'button' && b.type === 'button'),
    p0.btns.map(b => [b.tagName, b.type]));
  ok('back is dead on the first page and forward is live',
    p0.btns[0].disabled === true && !p0.btns[1].disabled,
    p0.btns.map(b => !!b.disabled));

  /* The chevron is aria-hidden, so a button with no label announces as "button"
     and nothing else — twice, identically, on the same row. */
  ok('each control says what it does, for a reader who cannot see the arrow',
    p0.btns[0].getAttribute('aria-label') === 'Previous fixtures' &&
    p0.btns[1].getAttribute('aria-label') === 'More fixtures',
    p0.btns.map(b => b.getAttribute('aria-label')));
  ok('and carries the same words as a tooltip for everyone else',
    p0.btns.every(b => b.title === b.getAttribute('aria-label')),
    p0.btns.map(b => b.title));
  ok('the group is named, so the two buttons are not loose in the page',
    p0.box.getAttribute('role') === 'group' &&
    p0.box.getAttribute('aria-label') === 'Fixture pages',
    [p0.box.getAttribute('role'), p0.box.getAttribute('aria-label')]);

  /* --- the icons are really SVG --------------------------------------------
     document.createElement('svg') produces an element that renders nothing at
     all, silently, so this is the assertion that catches the mistake. */
  const svgs = p0.btns.map(b => b.childNodes[0]);
  ok('each arrow is an svg element in the SVG namespace',
    svgs.every(s => s.tagName === 'svg' && s.namespaceURI === SVG),
    svgs.map(s => [s.tagName, s.namespaceURI]));
  ok('and its paths are too — a path in the HTML namespace draws nothing either',
    svgs.every(s => s.childNodes.length === 1 &&
                    s.childNodes[0].tagName === 'path' &&
                    s.childNodes[0].namespaceURI === SVG),
    svgs.map(s => s.childNodes.map(c => [c.tagName, c.namespaceURI])));
  ok('the class arrives as an attribute, because .className on an SVG element is read-only',
    svgs.every(s => s.getAttribute('class') === 'pager-i' && s.className === ''),
    svgs.map(s => [s.getAttribute('class'), s.className]));
  ok('each carries a viewBox, or it scales to nothing',
    svgs.every(s => s.getAttribute('viewBox') === '0 0 24 24'),
    svgs.map(s => s.getAttribute('viewBox')));
  ok('and is hidden from assistive tech, since the button is already labelled',
    svgs.every(s => s.getAttribute('aria-hidden') === 'true'));
  ok('the two arrows point opposite ways, rather than both being one glyph',
    svgs[0].childNodes[0].getAttribute('d') !== svgs[1].childNodes[0].getAttribute('d'),
    svgs.map(s => s.childNodes[0].getAttribute('d')));
  ok('no presentation is set as an attribute — fill and stroke belong in the stylesheet',
    svgs.every(s => walk(s).every(n => n.nodeType !== 1 ||
      !['fill', 'stroke', 'stroke-width'].some(a => a in n.attributes))),
    svgs.map(s => Object.keys(s.attributes)));

  /* --- pressing them ------------------------------------------------------- */
  p0.btns[1].click();
  ok('forward asks for the next page, and asks once', asked.join() === '1', asked);
  p0.btns[0].click();
  ok('and the disabled control asks for nothing at all', asked.join() === '1', asked);

  const p1 = draw(1);
  ok('page two holds the next five, with none repeated and none skipped',
    p1.ids.join() === p0.ids.map(() => 0).join() ? false
      : p1.ids.length === 5 && p1.ids.every(d => !p0.ids.includes(d)),
    [p0.ids.length, p1.ids.length]);
  ok('and says so', p1.label === '6–10 of 12', p1.label);
  ok('with both controls live in the middle of a list',
    !p1.btns[0].disabled && !p1.btns[1].disabled,
    p1.btns.map(b => !!b.disabled));
  p1.btns[0].click();
  ok('back asks for the page before, not for the first page', asked.join() === '0', asked);

  const p2 = draw(2);
  ok('the last page holds the remainder rather than padding to five', p2.cards === 2, p2.cards);
  ok('and counts it honestly', p2.label === '11–12 of 12', p2.label);
  ok('forward is dead at the end, back is live',
    !p2.btns[0].disabled && p2.btns[1].disabled === true,
    p2.btns.map(b => !!b.disabled));

  /* Every fixture reachable, exactly once: the property the whole feature rests
     on. Anything else is a list that quietly loses a match. */
  const walked = [...p0.ids, ...p1.ids, ...p2.ids];
  ok('the three pages partition the day — nothing hidden, nothing counted twice',
    walked.length === 12 && new Set(walked).size === 12, walked.length);
  ok('and in the order they kick off',
    walked.join() === many.map(f => f.date).join(), walked.slice(0, 2));

  /* --- a request for a page that is not there ------------------------------
     main.js stores the page unclamped on purpose, so these are the live cases
     rather than defensive ones: phase 2 can shorten a day under the reader. */
  ok('a page past the end lands on the last real page, not on an empty one',
    draw(9).label === '11–12 of 12', draw(9).label);
  ok('a negative page lands on the first', draw(-4).label === '1–5 of 12');
  ok('a page that is not a number lands on the first', draw(NaN).label === '1–5 of 12');
  ok('a fractional page is floored rather than slicing between cards',
    draw(1.9).label === '6–10 of 12', draw(1.9).label);

  /* --- when there is nothing to page -------------------------------------- */
  ok('exactly one page means no pager: two dead arrows are not information',
    draw(0, many.slice(0, 5)).box === null);
  ok('one fixture over means there is', draw(0, many.slice(0, 6)).box !== null);
  ok('and it counts the six rather than the five it shows',
    draw(0, many.slice(0, 6)).label === '1–5 of 6', draw(0, many.slice(0, 6)).label);
  ok('a single fixture pages not at all', draw(0, many.slice(0, 1)).box === null);

  /* --- the stagger restarts, so page three does not open with a pause ------ */
  const delays = r => els(r.m, 'match').map(c => c.style.props['--i']);
  ok('the entrance stagger counts from zero on every page',
    delays(p1).join() === '0,1,2,3,4', delays(p1));
  ok('so no card on any page waits longer than the first page\'s last',
    Math.max(...[p0, p1, p2].flatMap(r => delays(r).map(Number))) === 4,
    [p0, p1, p2].map(delays));

  /* --- the heading survives the cut ---------------------------------------
     A slice starting mid-day still has to say which day, even though the
     previous page already said it. `lastDay` resetting on every paint is what
     does it, and it is one line away from being "optimised" into a bug that
     leaves a page of undated cards.

     Anchored to local midnight rather than to now + N hours: eight fixtures
     spread across a working day have to stay on ONE calendar day for this to
     test anything, and offsets from the moment the suite runs stop doing that
     after mid-afternoon. */
  const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return +d; })();
  const at = h => new Date(midnight + h * 3600e3).toISOString();
  const spread = [10, 12, 13, 14, 15, 16, 17, 18, 34, 35]
    .map((h, i) => ({ ...F('s' + i, '1', '16', 0), date: at(h) }));

  const sp0 = draw(0, spread), sp1 = draw(1, spread);
  const headings = r => els(r.m, 'day').map(d => d.textContent);
  console.log('    page 1: ' + headings(sp0).join(' | ') + '   page 2: ' + headings(sp1).join(' | '));
  ok('the eight-then-two split really does cut a day in half, or the next two prove nothing',
    sp0.cards === 5 && headings(sp0).length === 1, [sp0.cards, headings(sp0)]);
  ok('a page that starts in the middle of a day repeats that day\'s heading',
    headings(sp1)[0] === headings(sp0)[0], [headings(sp0), headings(sp1)]);
  ok('and a slice spanning midnight still carries a heading for each day in it',
    headings(sp1).length === 2 && headings(sp1)[1] !== headings(sp1)[0], headings(sp1));

  /* --- both phases agree ---------------------------------------------------
     The reader is usually mid-list when phase 2 lands. If the two disagreed
     about which five those are, the page would swap five cards for five others
     at a moment nobody asked it to. */
  const pm = new Element('main'), ps = new Element('div');
  const pg = { page: 1, size: 5, onPage: () => {} };
  V.showFixtureList(pm, ps, predictions.map(p => p.fixture), null, pg);
  const phase1 = els(pm, 'kick').map(t => t.dateTime);
  V.showPredictions(pm, ps, predictions, index, data, null, pg);
  const phase2 = els(pm, 'kick').map(t => t.dateTime);
  ok('phase 1 and phase 2 show the same slice of the same list',
    phase1.join() === phase2.join(), [phase1, phase2]);

  /* --- the status strip describes the day, not the page -------------------- */
  ok('the strip counts the whole day above five cards, and the pager reconciles it',
    p0.s.textContent.includes('12 fixtures') && p0.label.endsWith('of 12'),
    [p0.s.textContent, p0.label]);

  /* --- paging is opt-in ---------------------------------------------------- */
  const nm = new Element('main'), ns2 = new Element('div');
  V.showFixtureList(nm, ns2, many);
  ok('a caller that passes no paging gets the whole list and no pager, as before',
    els(nm, 'match').length === 12 && els(nm, 'pager').length === 0,
    els(nm, 'match').length);
  ok('and PAGE_SIZE is what the site actually pages by', PAGE_SIZE === 5, PAGE_SIZE);
}

console.log('=== class audit ===');
const fs = await import('node:fs');
const css = fs.readFileSync(new URL('../assets/css/style.css', import.meta.url), 'utf8');
const emitted = new Set();
[mount, status, pmount, pstatus, fmount, fstatus].concat(allCards).forEach(root => walk(root).forEach(n => {
  /* clsOf, not .className: an icon's class is an attribute, and reading only
     .className would leave every SVG class unaudited — which is exactly the set
     of classes whose absence renders a black blob rather than nothing. */
  if (n.nodeType === 1 && clsOf(n)) clsOf(n).split(/\s+/).forEach(c => emitted.add(c));
}));
/* The lookahead, not \b: `\.pager\b` matches inside `.pager-b`, so a class with
   no rule of its own passes as styled on the strength of a longer relative. */
const styled = c => new RegExp('\\.' + c + '(?![\\w-])').test(css);
const orphans = [...emitted].filter(c => !styled(c));
console.log('    ' + emitted.size + ' distinct classes emitted');
ok('no class without styling', orphans.length === 0, orphans);
ok('the audit rejects a class that is only the prefix of a real rule',
  !/\.pager(?![\w-])/.test('.pager-b { color: red }'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
/* Every other suite in this folder ends this way; r1 was the one that did not,
   and printed "9 FAILED" while exiting 0 for as long as it existed. run.mjs
   counts FAIL lines itself so the full run was never fooled, but anything that
   asks the process instead of reading its output — CI, a shell `&&`, a
   deliberate-breakage harness — was told this suite had passed. Found by a
   harness that trusted the exit code, which is the whole argument for reading
   it. */
process.exit(fails ? 1 : 0);
