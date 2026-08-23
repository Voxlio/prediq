/* End to end: a fake ESPN, the real api.js + model.js + render.js, booted by
   the real main.js. The point is the seams — URL construction, the cache, the
   progress count, the day tabs, and the exact SHAPE of an error object as it
   travels from api.js to the notice on the page.

   This suite re-runs itself as a child process to test deep linking, since a
   day already in the URL can only be read at boot and a module boots once. The
   child sets E1_DAY, reports what it settled on and exits before the rest of
   the suite — one extra boot rather than a whole second run.

   Both share E1_NOW, so parent and child place their mock fixtures on the same
   calendar days. Without that the two clocks are seconds apart and one of them
   could land the other side of midnight. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;
const { LEAGUES, DOMESTIC, FIXTURE_DAYS, CACHE } = await import(base + 'config.js');

const CHILD = process.env.E1_DAY || '';

/* 09:00 local today, not the moment the suite runs. The mock places fixtures at
   +3h, +6h and +27h, and the day-tab assertions need the first two on one
   calendar day and the third on the next. Left as Date.now() that held for most
   of the day and quietly stopped holding after 21:00 local, when +3h crosses
   midnight and the two-day shape becomes a three-day one. Still today's date, so
   the "Today"/"Tomorrow" wording is exercised rather than bypassed. */
const NOW0 = Number(process.env.E1_NOW) || (() => {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return +d;
})();

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };

/* ---------- DOM shim ----------
   Past r1's copy by what the day strip needs: `dataset`, because the day key
   rides on the button as data-day, and listeners recorded rather than ignored
   so a tab can actually be clicked. */
class TextNode { constructor(d) { this.nodeType = 3; this.data = String(d); this.childNodes = []; } get textContent() { return this.data; } }
class Element {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.className = ''; this.childNodes = []; this.attributes = {};
    this.dataset = {}; this.listeners = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; }
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
const mount = new Element('main'), statusNode = new Element('div'), stripNode = new Element('div');
globalThis.document = {
  createElement: t => new Element(t),
  createTextNode: t => new TextNode(t),
  getElementById: id => ({ fixtures: mount, status: statusNode, days: stripNode }[id] ?? null),
};
globalThis.window = globalThis;
const walk = (n, out = []) => { out.push(n); n.childNodes.forEach(c => walk(c, out)); return out; };
const els = (n, cls) => walk(n).filter(x => x.nodeType === 1 && x.className.split(/\s+/).includes(cls));

/* ---------- location / history shim ----------
   The selected day lives in the URL so it can be linked and survive a reload.
   replaceState writes through to `location`, so dayFromURL() round-trips the
   way it does in a browser. pushState is counted and must stay at zero: a tab
   is a filter on one page, and pushing would make Back walk through six days
   instead of leaving the site. */
let pushes = 0, scrolls = 0;
globalThis.location = { href: 'http://localhost:8000/index.html', search: '', reload() {} };
if (CHILD) {
  location.search = '?day=' + CHILD;
  location.href += location.search;
}
globalThis.history = {
  replaceState(_s, _t, url) {
    const u = new URL(url, location.href);
    location.href = String(u);
    location.search = u.search;
  },
  pushState() { pushes++; },
};
globalThis.scrollTo = () => { scrolls++; };

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

/* The one division that plays nothing on the second day. Named here rather than
   hard-coded in the scoreboard so the reason travels with it, and taken from the
   end of the list so it is not also the league other sections break on purpose. */
const DAY1_ONLY = DOM_SLUGS[DOM_SLUGS.length - 1];

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

const hrs = h => new Date(NOW0 + h * 3600e3).toISOString();
const ago = d => new Date(NOW0 - d * 864e5).toISOString();

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
    /* One league plays both its remaining games on the opening day and nothing on
       the second, so that no single day holds every division. Without this the
       mock hid a real bug class: "matches fitted" could be computed over only the
       leagues visible on screen and still read the same on every tab, because
       every tab showed every league. See the note on that assertion below. */
    const third = slug === DAY1_ONLY ? 4 : 27;
    return { events: [
      ev(slug + 'f1', hrs(3),     'pre', T[0], T[19], 0, 0, BOOK),
      ev(slug + 'f2', hrs(6),     'pre', T[9], T[10], 0, 0, null),
      ev(slug + 'f3', hrs(third), 'pre', T[4], T[5],  0, 0, BOOK),
      /* one already kicked off — must not be offered as a prediction */
      ev(slug + 'f4', hrs(-2),    'in',  T[2], T[3],  1, 0, BOOK),
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

/* Three fixtures per division plus two Champions League ties. The fourth
   fixture of each division has already kicked off and api.js drops it. */
const TOTAL = DOM_SLUGS.length * 3 + 2;

const pad = n => String(n).padStart(2, '0');
const localKey = iso => { const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const tabs = () => els(stripNode, 'daytab');
const current = () => tabs().find(b => b.getAttribute('aria-current') === 'date');
const shownDays = () => [...new Set(els(mount, 'kick').map(t => localKey(t.dateTime)))];
const leaguesOn = () => new Set(els(mount, 'comp').map(n => n.textContent));
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/* ---------- child mode: a day already in the URL ----------
   Reported and exited before the rest of the suite runs, so a deep link costs
   one boot rather than a second full pass. */
if (CHILD) {
  process.stdout.write('\nDEEPLINK ' + (current() ? current().dataset.day : 'none') +
                       ' ' + els(mount, 'match').length + ' ' + location.search + '\n');
  process.exit(0);
}

const cards = els(mount, 'match');
ok('rendered cards', cards.length > 0, cards.length);
ok('every card carries exactly one kickoff time',
  els(mount, 'kick').length === cards.length, [els(mount, 'kick').length, cards.length]);
ok('no error notice when everything loaded', els(mount, 'notice').length === 0);

const firstDayCards = cards.length;
ok('the page opens on a single day rather than the whole window',
  shownDays().length === 1 && firstDayCards < TOTAL, [shownDays(), firstDayCards, TOTAL]);
ok('and on the earliest day there is football, which is what a visitor wants first',
  current() && current().dataset.day === tabs()[0].dataset.day,
  [current() && current().dataset.day, tabs().map(b => b.dataset.day)]);
ok('one day heading, since one day is shown', els(mount, 'day').length === 1, els(mount, 'day').length);

/* The strip counts leagues that actually have a fixture on the day shown, not
   every league configured. The two idle European cups contribute nothing in
   August, so saying "14 leagues" over a list drawn from twelve would be false. */
ok('the status strip counts the leagues on the day shown',
  statusNode.textContent.includes(plural(leaguesOn().size, 'league')),
  [statusNode.textContent, leaguesOn().size]);
ok('and the fixtures actually on screen',
  statusNode.textContent.includes(plural(firstDayCards, 'fixture')),
  [statusNode.textContent, firstDayCards]);
ok('while still saying how many the whole window holds, so the day looks like a filter',
  statusNode.textContent.includes(TOTAL + ' in ' + FIXTURE_DAYS + ' days'),
  statusNode.textContent);
ok('status reports matches fitted', /[1-9]\d* matches fitted/.test(statusNode.textContent), statusNode.textContent);
ok('cup ties and scoreless rows excluded from the fit',
  statusNode.textContent.includes(DOM_SLUGS.length * 8 + ' matches fitted'), statusNode.textContent);

const first = cards[0];
console.log('    first card: ' + els(first, 'outcome-name').map(n => n.textContent).join(' / ') +
            '   ' + els(first, 'outcome-pct').map(n => n.textContent).join(' '));
ok('strongest home side is favoured on card one', els(first, 'is-pick').length === 1);
ok('percentages still sum to 100 on live-shaped data',
  els(first, 'outcome-pct').map(n => parseInt(n.textContent, 10)).reduce((a, b) => a + b, 0) === 100);

/* ---------- the day tabs ---------- */
console.log('');
console.log('=== the day tabs ===');
{
  const keys = tabs().map(b => b.dataset.day);
  console.log('    tabs: ' + keys.join(' ') + '   (opened on ' + current().dataset.day + ')');

  ok('more than one day is offered, or the strip would be a dead control',
    keys.length > 1, keys);
  ok('the tabs are in calendar order', keys.join() === [...keys].sort().join(), keys);
  ok('no day is offered twice', new Set(keys).size === keys.length, keys);
  ok('every tab is a real button', tabs().every(b => b.tagName === 'button'), tabs().map(b => b.tagName));

  /* Walk every tab and add up what each shows. Disjoint groups that sum to the
     window total is the whole correctness claim of the filter: nothing hidden,
     nothing counted twice. */
  let sum = 0;
  const everyLeague = new Set();
  const perDayLeagues = [];
  const refusals = [];
  for (const key of keys) {
    const btn = tabs().find(b => b.dataset.day === key);
    if (!btn.disabled) btn.click();

    const n = els(mount, 'match').length;
    sum += n;
    leaguesOn().forEach(l => everyLeague.add(l));
    perDayLeagues.push(leaguesOn().size);
    els(mount, 'blank-note').forEach(x => refusals.push(x.textContent));

    ok('the ' + key + ' tab shows something', n > 0, n);
    ok('and only matches that kick off on ' + key,
      shownDays().join() === key, shownDays());
    ok('with one day heading above them', els(mount, 'day').length === 1, els(mount, 'day').length);
    ok('and that tab marked current, alone',
      current().dataset.day === key &&
      tabs().filter(b => b.getAttribute('aria-current')).length === 1,
      tabs().map(b => [b.dataset.day, b.getAttribute('aria-current')]));
    ok('the day is written to the URL, so the view can be linked',
      location.search === '?day=' + key, location.search);
    /* The fit is done once over every league before any filtering, so a
       Saturday's predictions rest on all of it and this count must not move. */
    ok('matches fitted does not move with the day',
      statusNode.textContent.includes(DOM_SLUGS.length * 8 + ' matches fitted'), statusNode.textContent);
  }

  /* The assertion above is only worth anything if some day is short of a league.
     While every tab happened to show all of them, computing "matches fitted" from
     the leagues on screen — the obvious wrong way to write it — read identically
     on every tab and the assertion passed on broken code. Verified by making that
     exact edit and watching this line fail. */
  ok('and at least one day is missing a division, or that assertion proves nothing',
    perDayLeagues.some(n => n < everyLeague.size), perDayLeagues);

  ok('the tabs partition the window: ' + sum + ' across ' + keys.length + ' days',
    sum === TOTAL, [sum, TOTAL]);
  ok('and between them cover every division plus the Champions League',
    everyLeague.size === DOMESTIC.length + 1, [everyLeague.size, DOMESTIC.length + 1]);

  /* The refusal is a Champions League tie against a side outside the tracked
     divisions, and it kicks off on a later day than the page opens on. Counted
     across every tab rather than on one, which also proves the filter shows it
     exactly once instead of on every day. */
  ok('exactly one refusal in the whole window, for the untracked side',
    refusals.length === 1, refusals);
  ok('and it names Ajax rather than blaming the network',
    /^Ajax plays outside/.test(refusals[0] || ''), refusals[0]);

  ok('a tab click replaces the URL rather than pushing, so Back still leaves the page',
    pushes === 0, pushes);
  ok('and returns to the top of the list', scrolls === keys.length - 1, [scrolls, keys.length - 1]);

  /* ---------- deep links ---------- */
  const deeplink = day => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)],
      { encoding: 'utf8', env: { ...process.env, E1_DAY: day, E1_NOW: String(NOW0) } });
    const m = (r.stdout || '').match(/^DEEPLINK (\S+) (\d+) (\S*)$/m);
    return m ? { day: m[1], cards: +m[2], search: m[3] }
             : { error: 'exit ' + r.status + ' ' + (r.stderr || '').slice(-400) };
  };

  const last = keys[keys.length - 1];
  const linked = deeplink(last);
  console.log('    ?day=' + last + ' → ' + JSON.stringify(linked));
  ok('a page opened with ?day= in the URL starts on that day, not on the default',
    linked.day === last && last !== keys[0], linked);
  ok('and shows that day\'s matches', linked.cards > 0, linked);

  const stale = deeplink('1999-01-01');
  console.log('    ?day=1999-01-01 → ' + JSON.stringify(stale));
  ok('a day with no football — a stale bookmark — falls back to the first real day',
    stale.day === keys[0], stale);
  ok('rather than to an empty page', stale.cards > 0, stale);
  ok('and the URL is corrected to the day actually shown',
    stale.search === '?day=' + keys[0], stale);

  /* Back to the opening day, so the sections below start where they expect. */
  const home = tabs().find(b => b.dataset.day === keys[0]);
  if (!home.disabled) home.click();
}

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
