/* End to end: a fake ESPN, the real api.js + model.js + render.js, booted by
   the real main.js. The point is the seams — URL construction, the cache, the
   progress count, and the exact SHAPE of an error object as it travels from
   api.js to the notice on the page. */

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const { LEAGUES, DOMESTIC, FIXTURE_DAYS, CACHE } = await import(base + 'config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };

/* ---------- DOM shim ---------- */
class TextNode { constructor(d) { this.nodeType = 3; this.data = String(d); this.childNodes = []; } get textContent() { return this.data; } }
class Element {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.className = ''; this.childNodes = []; this.attributes = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...ns) { for (const n of ns) if (n != null) this.childNodes.push(n); }
  appendChild(n) { this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  set textContent(v) { this.childNodes = v === '' ? [] : [new TextNode(v)]; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
}
const mount = new Element('main'), statusNode = new Element('div');
globalThis.document = {
  createElement: t => new Element(t),
  createTextNode: t => new TextNode(t),
  getElementById: id => (id === 'fixtures' ? mount : id === 'status' ? statusNode : null),
};
globalThis.window = globalThis;
const walk = (n, out = []) => { out.push(n); n.childNodes.forEach(c => walk(c, out)); return out; };
const els = (n, cls) => walk(n).filter(x => x.nodeType === 1 && x.className.split(/\s+/).includes(cls));

/* ---------- localStorage shim ---------- */
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: i => [...store.keys()][i] ?? null,
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};

/* ---------- the fake ESPN ---------- */
const SLUGS = LEAGUES.map(l => l.slug);
const DOM_SLUGS = DOMESTIC.map(l => l.slug);
const TEAMS = {};             /* slug -> [{id,name,gf,ga}] */
DOM_SLUGS.forEach((slug, li) => {
  TEAMS[slug] = Array.from({ length: 20 }, (_, i) => ({
    id: slug + '-t' + (i + 1),
    name: slug.toUpperCase().replace('.', ' ') + ' Team ' + (i + 1),
    gf: 70 - i * 2,          /* a clean strength gradient: t1 best, t20 worst */
    ga: 30 + i * 3,
  }));
});

let brokenUrl = () => false;  /* per-URL failure injection */
const hits = [];              /* every URL requested */

const entry = (t, gp, gf, ga, rank) => ({
  team: { id: t.id, displayName: t.name, shortDisplayName: t.name, abbreviation: 'X' + rank },
  stats: [{ name: 'gamesPlayed', value: gp }, { name: 'pointsFor', value: gf },
          { name: 'pointsAgainst', value: ga }, { name: 'rank', value: rank }],
});

const competitor = (t, homeAway, score) => ({
  homeAway, score, form: 'WWDLW',
  team: { id: t.id, displayName: t.name, shortDisplayName: t.name, abbreviation: 'XX' },
});

const ev = (id, date, state, home, away, hg, ag, odds) => ({
  id, date, status: { type: { state } },
  competitions: [{
    venue: { fullName: 'Test Ground' },
    competitors: [competitor(home, 'home', String(hg)), competitor(away, 'away', String(ag))],
    ...(odds ? { odds: [odds] } : {}),
  }],
});

const BOOK = { provider: { displayName: 'DraftKings' },
  homeTeamOdds: { moneyLine: -150 }, drawOdds: { moneyLine: 260 },
  awayTeamOdds: { moneyLine: 400 }, overUnder: 2.5 };

const hrs = h => new Date(Date.now() + h * 3600e3).toISOString();
const ago = d => new Date(Date.now() - d * 864e5).toISOString();

function scoreboard(slug, span) {
  /* A short range is the fixtures request; a month-long one is results. */
  if (span <= FIXTURE_DAYS + 1) {
    if (slug === 'uefa.champions') {
      const AJAX = { id: 'ajax', name: 'Ajax' };
      return { events: [
        ev('ucl1', hrs(30), 'pre', TEAMS['eng.1'][0], TEAMS['esp.1'][0], 0, 0, BOOK),
        ev('ucl2', hrs(31), 'pre', TEAMS['eng.1'][1], AJAX, 0, 0, null),
      ] };
    }
    /* Every other European competition is idle from June to September and
       genuinely answers with nothing — verified against ESPN in August 2026,
       where uefa.europa and uefa.europa.conf both returned 0 events. An empty
       cup is normal, not a failure, so the mock reproduces it rather than
       inventing fixtures that would not exist. */
    if (!TEAMS[slug]) return { events: [] };
    const T = TEAMS[slug];
    return { events: [
      ev(slug + 'f1', hrs(3),  'pre', T[0], T[19], 0, 0, BOOK),
      ev(slug + 'f2', hrs(6),  'pre', T[9], T[10], 0, 0, null),
      ev(slug + 'f3', hrs(27), 'pre', T[4], T[5],  0, 0, BOOK),
      /* one already kicked off — must not be offered as a prediction */
      ev(slug + 'f4', hrs(-2), 'in',  T[2], T[3],  1, 0, BOOK),
    ] };
  }
  /* A month of finished results, plus a cup tie against a non-league side.
     Only domestic divisions are ever asked for a month, since loadModel
     iterates DOMESTIC — but guard anyway, so a future change that asks for a
     cup month fails visibly instead of throwing from inside the mock. */
  if (!TEAMS[slug]) return { events: [] };
  const T = TEAMS[slug];
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(ev(slug + 'r' + i, ago(7 - (i % 6)), 'post', T[i], T[19 - i], (i % 3) + 1, i % 2));
  }
  out.push(ev(slug + 'cup', ago(4), 'post', T[0], { id: 'cov', name: 'Coventry City' }, 3, 0));
  out.push(ev(slug + 'void', ago(3), 'post', T[1], T[2], null, null));  /* no score yet */
  return { events: out };
}

const ymdToDate = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

globalThis.fetch = async (url) => {
  hits.push(url);
  const slug = SLUGS.find(s => url.includes('/soccer/' + s + '/'));
  if (!slug) throw new Error('mock: unroutable ' + url);
  if (brokenUrl(url)) return { ok: false, status: 503, json: async () => ({}) };

  if (url.includes('/standings?')) {
    const season = +new URL(url).searchParams.get('season');
    const isPrev = season === 2025;
    const rows = TEAMS[slug].map((t, i) => isPrev
      ? entry(t, 38, t.gf, t.ga, i + 1)
      /* Current-season table is contaminated by the cup result, exactly as the
         live endpoint is. Roster only — strength must not come from here. */
      : entry(t, 1, i === 0 ? 3 : 1, i === 0 ? 0 : 1, i + 1));
    return { ok: true, status: 200, json: async () => ({ children: [{ standings: { entries: rows } }] }) };
  }

  const [from, to] = new URL(url).searchParams.get('dates').split('-');
  const span = Math.round((ymdToDate(to) - ymdToDate(from)) / 864e5);
  const body = scoreboard(slug, span);
  return { ok: true, status: 200, json: async () => body };
};

/* ---------- boot the real entry point ---------- */
console.log('=== boot ===');
await import(base + 'main.js');
/* The loading skeletons are also .match, so "settled" means the skeletons are
   gone AND something real has replaced them. */
const settled = () => !els(mount, 'is-skeleton').length &&
                      (els(mount, 'match').length > 0 || els(mount, 'notice').length > 0);
for (let i = 0; i < 800 && !settled(); i++) await new Promise(r => setTimeout(r, 25));
ok('boot settled without hanging', settled());

const expectedJobs = LEAGUES.length + DOMESTIC.length * 3;   /* 1 month has started */
console.log('    ' + hits.length + ' requests, ' + store.size + ' cache entries');
console.log('    status strip: ' + statusNode.textContent);
ok('fired one request per job', hits.length === expectedJobs, [hits.length, expectedJobs]);
ok('every request went to ESPN over https', hits.every(u => u.startsWith('https://site.api.espn.com/')));
ok('standings use the path without the site segment',
  hits.filter(u => u.includes('/standings?')).every(u => u.includes('/apis/v2/sports/soccer/')),
  hits.find(u => u.includes('/standings?')));
ok('scoreboard uses the site path',
  hits.filter(u => u.includes('/scoreboard?')).every(u => u.includes('/apis/site/v2/sports/soccer/')));
ok('cached every successful response', store.size === expectedJobs, [store.size, expectedJobs]);
ok('cache keys are namespaced', [...store.keys()].every(k => k.startsWith(CACHE.prefix)));

/* ---------- what the page shows ---------- */
console.log('');
console.log('=== the rendered page ===');
const cards = els(mount, 'match');
const blanks = els(mount, 'is-blank');
ok('rendered cards', cards.length > 0, cards.length);
ok('kicked-off matches are not shown as predictions',
  cards.length === DOM_SLUGS.length * 3 + 2, [cards.length, DOM_SLUGS.length * 3 + 2]);
ok('exactly one refusal, for the untracked side', blanks.length === 1, blanks.length);
ok('the refusal names Ajax and does not blame the network',
  /^Ajax plays outside/.test(els(mount, 'blank-note')[0].textContent), els(mount, 'blank-note')[0].textContent);
ok('no error notice when everything loaded', els(mount, 'notice').length === 0);
ok('day dividers present', els(mount, 'day').length >= 2, els(mount, 'day').length);
/* The strip counts leagues that actually have a fixture, not every league
   configured. The two idle European cups contribute nothing in August, so
   saying "14 leagues" over a list drawn from twelve would be false. Assert the
   strip agrees with the cards beside it, and that the total is what the data
   implies: every domestic division plus the Champions League. */
const onPage = new Set(els(mount, 'comp').map(n => n.textContent));
ok('the status strip counts the leagues actually on the page',
  statusNode.textContent.includes(onPage.size + ' leagues') && onPage.size === DOMESTIC.length + 1,
  [statusNode.textContent, onPage.size, DOMESTIC.length + 1]);
ok('status reports matches fitted', /[1-9]\d* matches fitted/.test(statusNode.textContent), statusNode.textContent);
ok('cup ties and scoreless rows excluded from the fit',
  statusNode.textContent.includes(DOM_SLUGS.length * 8 + ' matches fitted'), statusNode.textContent);

const first = cards[0];
console.log('    first card: ' + els(first, 'outcome-name').map(n => n.textContent).join(' / ') +
            '   ' + els(first, 'outcome-pct').map(n => n.textContent).join(' '));
ok('strongest home side is favoured on card one', els(first, 'is-pick').length === 1);
ok('percentages still sum to 100 on live-shaped data',
  els(first, 'outcome-pct').map(n => parseInt(n.textContent, 10)).reduce((a, b) => a + b, 0) === 100);

/* ---------- the cache actually saves requests ---------- */
console.log('');
console.log('=== second visit ===');
const { loadAll } = await import(base + 'api.js');
const before = hits.length;
const again = await loadAll({});
ok('a repeat load makes no network requests at all', hits.length === before, hits.length - before);
ok('and still returns the same fixtures', again.fixtures.length === DOM_SLUGS.length * 3 + 2, again.fixtures.length);

/* ---------- one league down: the bug this test exists for ---------- */
console.log('');
console.log('=== one league fails ===');
const M = await import(base + 'model.js');
const V = await import(base + 'render.js');

/* 1a. Every Bundesliga request fails, fixtures included. There are then no
       German fixtures to show at all — only the notice can mention it. */
store.clear();
brokenUrl = u => u.includes('/ger.1/');
let partial = await loadAll({});
console.log('    errors: ' + JSON.stringify(partial.errors.slice(0, 2)));
ok('api.js reports failures by slug', partial.errors.every(e => e.league === 'ger.1'), partial.errors);
let out = M.predictAll(partial);
V.showPredictions(mount, statusNode, out.predictions, out.index, partial);
let note = els(mount, 'notice')[0];
console.log('    notice: ' + note.textContent);
ok('the notice names the league in English, not as a slug',
  note.textContent.includes('Bundesliga') && !note.textContent.includes('ger.1'), note.textContent);
ok('it names the league once, not once per failed request',
  (note.textContent.match(/Bundesliga/g) || []).length === 1, note.textContent);
ok('predictions for other leagues survive', els(mount, 'match').length > 0);
ok('no German fixtures are invented', !els(mount, 'match').some(c =>
  walk(c).some(n => n.nodeType === 3 && n.data.includes('GER 1'))));

/* 1b. The harder case: German FIXTURES arrive, but the tables behind them do
       not. Those fixtures must be listed and must blame the right thing. */
store.clear();
brokenUrl = u => u.includes('/ger.1/') && u.includes('/standings?');
partial = await loadAll({});
out = M.predictAll(partial);
V.showPredictions(mount, statusNode, out.predictions, out.index, partial);
const germanBlanks = els(mount, 'blank-note').filter(n => /Bundesliga data did not load/.test(n.textContent));
console.log('    ' + germanBlanks.length + ' German fixtures listed without a prediction');
console.log('    ' + (germanBlanks[0] ? germanBlanks[0].textContent : '(none)'));
ok('the German fixtures are still listed', germanBlanks.length === 3, germanBlanks.length);
ok('and blame the missing table, not the teams',
  germanBlanks.every(n => !/outside the five leagues/.test(n.textContent)));
ok('other leagues still predict normally',
  els(mount, 'match').length - els(mount, 'is-blank').length === DOM_SLUGS.length * 3 + 2 - 3 - 1,
  [els(mount, 'match').length, els(mount, 'is-blank').length]);

/* ---------- total failure ---------- */
console.log('');
console.log('=== everything fails ===');
store.clear();
brokenUrl = () => true;
const dead = await loadAll({});
ok('no fixtures survive', dead.fixtures.length === 0);
ok('every failure is recorded', dead.errors.length === expectedJobs, dead.errors.length);
V.showFatal(mount, statusNode, 'Every attempt to reach the football data source failed.');
ok('page states it plainly', els(mount, 'notice').length === 1 && els(mount, 'match').length === 0);
ok('and invents nothing', !els(mount, 'outcome').length);

/* ---------- the console escape hatch ---------- */
console.log('');
console.log('=== prediq.rebuild() ---');
store.set('unrelated:key', 'x');
store.set(CACHE.prefix + 'fix:test', '{}');
ok('window.prediq exposed', typeof window.prediq?.rebuild === 'function');
const { clearCache } = await import(base + 'api.js');
ok('clearCache drops only our keys', clearCache() === 1 && store.has('unrelated:key'), [...store.keys()]);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
