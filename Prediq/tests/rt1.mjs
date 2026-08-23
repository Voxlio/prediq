/* table.js — the ratings view, on the same DOM shim the render suite uses.
   table.js never uses innerHTML, so nothing in this file can produce markup. */

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const base = new URL('../assets/js/', import.meta.url).href;

/* ---------- 1. the shim ---------- */
class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.childNodes = []; }
  get textContent() { return this.data; }
}
class Element {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.className = '';
    this.childNodes = []; this.attributes = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...ns) { for (const n of ns) if (n != null) this.childNodes.push(n); }
  appendChild(n) { this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  set textContent(v) { this.childNodes = v === '' ? [] : [new TextNode(v)]; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
}
globalThis.document = {
  createElement: t => new Element(t),
  createTextNode: t => new TextNode(t),
};

const walk = (n, out = []) => { out.push(n); n.childNodes.forEach(c => walk(c, out)); return out; };
const els = (n, cls) => walk(n).filter(x => x.nodeType === 1 && x.className.split(/\s+/).includes(cls));
const tags = (n, tag) => walk(n).filter(x => x.nodeType === 1 && x.tagName === tag);

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };
const near = (a, b, tol = 0.005) => Math.abs(a - b) < tol;

const M = await import(base + 'model.js');
const T = await import(base + 'table.js');
const { MODEL, LEAGUES } = await import(base + 'config.js');

/* ---------- 2. two leagues, so the cross-league view has something to do ---- */
const mk = (rows, gp) => rows.map(([id, name, gf, ga]) => ({ id, name, short: name, gp, gf, ga, rank: null }));

const EPL_PREV = mk([
  ['1', 'Liverpool', 86, 41], ['2', 'Arsenal', 69, 34], ['3', 'Man City', 72, 44], ['4', 'Chelsea', 64, 43],
  ['5', 'Newcastle', 68, 47], ['6', 'Aston Villa', 58, 51], ['7', 'Nottm Forest', 58, 46], ['8', 'Brighton', 66, 59],
  ['9', 'Bournemouth', 58, 46], ['10', 'Brentford', 66, 57],
], 38);
/* One hostile name, to prove a team name can only ever land in a text node. */
const HOSTILE = '<img src=x onerror=alert(1)>';
EPL_PREV.push({ id: '11', name: HOSTILE, short: HOSTILE, gp: 38, gf: 50, ga: 50, rank: null });

const ESP_PREV = mk([
  ['31', 'Barcelona', 102, 39], ['32', 'Real Madrid', 78, 38], ['33', 'Atletico', 68, 42], ['34', 'Athletic', 54, 38],
  ['35', 'Villarreal', 71, 54], ['36', 'Betis', 57, 50], ['37', 'Celta', 59, 63], ['38', 'Rayo', 42, 51],
  ['39', 'Osasuna', 48, 51], ['40', 'Mallorca', 35, 50],
], 38);

const nowOf = std => std.map(t => ({ ...t, gp: 0, gf: 0, ga: 0 }));

const R = (h, a, hg, ag, d) => ({ date: d, home: { id: h, name: '', g: hg }, away: { id: a, name: '', g: ag } });
const day = i => new Date(Date.UTC(2026, 7, 2 + i)).toISOString();

/* One league well observed, one barely — that gap is the whole reason the
   is-thin dimming exists, so the fixture has to contain both. */
const EPL_RESULTS = [];
{
  const ids = EPL_PREV.map(t => t.id);
  let k = 0;
  for (let round = 1; round <= 8; round++) {
    for (let i = 0; i < 5; i++) {
      const h = ids[(i + round) % ids.length];
      const a = ids[(ids.length - 1 - i + round) % ids.length];
      if (h === a) continue;
      EPL_RESULTS.push(R(h, a, (i + round) % 4, (i * round) % 3, day(k++)));
    }
  }
}
const ESP_RESULTS = [
  R('31', '40', 3, 0, day(0)), R('32', '39', 2, 1, day(0)), R('33', '38', 1, 1, day(1)),
  R('34', '37', 0, 2, day(1)), R('35', '36', 2, 2, day(2)), R('31', '32', 1, 0, day(3)),
  R('40', '39', 0, 0, day(3)), R('38', '37', 2, 1, day(4)), R('36', '34', 1, 3, day(4)),
  R('33', '35', 2, 0, day(5)),
];

const blank = () => ({ standingsNow: [], standingsPrev: [], results: [] });
const data = {
  season: 2026, prevSeason: 2025, months: [[2026, 7]], errors: [], fetchedAt: Date.now(),
  fixtures: [],
  byLeague: {
    'eng.1': { standingsNow: nowOf(EPL_PREV), standingsPrev: EPL_PREV, results: EPL_RESULTS },
    'esp.1': { standingsNow: nowOf(ESP_PREV), standingsPrev: ESP_PREV, results: ESP_RESULTS },
  },
};
for (const lg of LEAGUES) if (!data.byLeague[lg.slug]) data.byLeague[lg.slug] = blank();

const index = M.buildIndex(data);
const nodes = () => ({ mount: new Element('div'), status: new Element('div'), scope: new Element('div') });
const noop = { onSort() {}, onScope() {} };
const league = () => ({ scope: 'league', sort: { ...T.DEFAULT_SORT } });
const tds = (root, cls) => els(root, cls).filter(n => n.tagName === 'td');

/* ---------- 3. the column contract ---------- */
console.log('=== the column contract ===');
console.log('    columns: ' + T.COLUMNS.map(c => c.key + ' → .' + c.cell).join('   '));

const cells = T.COLUMNS.map(c => c.cell);
ok('every column declares a cell class', cells.every(Boolean), cells);
ok('no two columns share a cell class', new Set(cells).size === cells.length, cells);

const n1 = nodes();
T.showRatings(n1, index, data, league(), noop);
const table1 = els(n1.mount, 'rt')[0];
const headCells = tags(table1, 'thead')[0].childNodes[0].childNodes;
const firstBodyRow = els(table1, 'rt-row')[0];

ok('one header cell per column', headCells.length === T.COLUMNS.length, headCells.length);
ok('one body cell per column', firstBodyRow.childNodes.length === T.COLUMNS.length,
  firstBodyRow.childNodes.length);

/* The assertion that would have caught the rt-name / rt-matches collision:
   table-layout:fixed reads every column width off the header row, so a header
   sitting under a different class than its own column sizes itself and nothing
   else, silently and with no error anywhere. */
ok('header and body agree on the class each column is styled under',
  T.COLUMNS.every((c, i) =>
    headCells[i].className.split(/\s+/).includes(c.cell) &&
    firstBodyRow.childNodes[i].className.split(/\s+/).includes(c.cell)),
  T.COLUMNS.map((c, i) => [c.cell, headCells[i].className, firstBodyRow.childNodes[i].className]));

ok('the skeleton uses those same classes, so nothing resizes when data lands',
  (() => {
    const n = nodes(); T.showLoading(n);
    const row = els(els(n.mount, 'rt')[0], 'rt-row')[0];
    return row.childNodes.length === T.COLUMNS.length &&
      T.COLUMNS.every((c, i) => row.childNodes[i].className.split(/\s+/).includes(c.cell));
  })());
ok('the skeleton is hidden from assistive tech, having nothing to say',
  (() => { const n = nodes(); T.showLoading(n);
    return els(n.mount, 'rt')[0].getAttribute('aria-hidden') === 'true'; })());

/* ---------- 4. sorting ---------- */
console.log('');
console.log('=== sorting ===');
const rows = M.powerTable(index, 'league').filter(r => r.leagueSlug === 'eng.1');
const VAL = { matches: r => r.matches, attack: r => r.attack, defence: r => r.defence, xpts: r => r.xPoints };

for (const c of T.COLUMNS.filter(c => VAL[c.key])) {
  const series = T.sortRows(rows, c.key, c.dir).map(VAL[c.key]);
  const monotone = series.every((v, i) => i === 0 || (c.dir === 1 ? v >= series[i - 1] : v <= series[i - 1]));
  ok(`first click on "${c.label}" answers the question that column asks`,
    monotone, series.map(v => +v.toFixed(2)));
}
ok('the name column sorts alphabetically both ways',
  T.sortRows(rows, 'name', 1)[0].name <= T.sortRows(rows, 'name', 1).at(-1).name &&
  T.sortRows(rows, 'name', -1)[0].name >= T.sortRows(rows, 'name', -1).at(-1).name);
ok('sortRows leaves the array it was handed alone',
  (() => {
    const before = rows.map(r => r.id).join();
    T.sortRows(rows, 'attack', -1);
    return rows.map(r => r.id).join() === before;
  })());
ok('ties break on the name, never on the order the data arrived in',
  (() => {
    const tied = [
      { name: 'Zulu', matches: 5, attack: 1, defence: 1, xPoints: 1.5 },
      { name: 'Alpha', matches: 5, attack: 1, defence: 1, xPoints: 1.5 },
      { name: 'Mike', matches: 5, attack: 1, defence: 1, xPoints: 1.5 },
    ];
    return T.sortRows(tied, 'xpts', -1).map(r => r.name).join() === 'Alpha,Mike,Zulu';
  })());
ok('the rank column cannot be sorted, being a property of the current order',
  !T.COLUMNS.find(c => c.key === 'rank').dir);

const xpCol = T.COLUMNS.find(c => c.key === 'xpts');
const defCol = T.COLUMNS.find(c => c.key === 'defence');
ok('clicking the active column reverses it', T.nextSort({ key: 'xpts', dir: -1 }, xpCol).dir === 1);
ok('clicking a new column starts from that column’s own direction',
  T.nextSort({ key: 'xpts', dir: -1 }, defCol).key === 'defence' &&
  T.nextSort({ key: 'xpts', dir: -1 }, defCol).dir === defCol.dir);
ok('reversing twice returns to where it started',
  T.nextSort(T.nextSort({ key: 'xpts', dir: -1 }, xpCol), xpCol).dir === -1);
ok('defence opens on lowest-first, because low is good there',
  defCol.dir === 1 && xpCol.dir === -1);

/* ---------- 5. sort state, announced and drawn ---------- */
console.log('');
console.log('=== sort state ===');
const announced = headCells.filter(th => th.getAttribute('aria-sort'));
ok('exactly one column is announced as sorted',
  announced.filter(th => th.getAttribute('aria-sort') !== 'none').length === 1,
  announced.map(th => th.getAttribute('aria-sort')));
ok('the announced direction is the one actually in use',
  headCells.at(-1).getAttribute('aria-sort') === 'descending',
  headCells.at(-1).getAttribute('aria-sort'));
ok('the direction is drawn as well, since aria-sort is invisible',
  els(table1, 'rt-caret').length === 1 && els(table1, 'rt-caret')[0].textContent === '↓',
  els(table1, 'rt-caret').map(c => c.textContent));
ok('only the active header is marked on', els(table1, 'is-on').length === 1, els(table1, 'is-on').length);
ok('every sortable header is a real button, typed so it cannot submit anything',
  els(table1, 'rt-sort').every(b => b.tagName === 'button' && b.getAttribute('type') === 'button'));
ok('the rank header is not a button', !els(headCells[0], 'rt-sort').length && headCells[0].textContent === '#');
ok('every column explains itself', T.COLUMNS.every(c => c.help && c.help.length > 15));
ok('every header cell is scoped as a column for screen readers',
  headCells.every(th => th.getAttribute('scope') === 'col'));
ok('the team cell is the row header, so figures are read against a name',
  (() => { const t = els(firstBodyRow, 'rt-team')[0];
    return t.tagName === 'th' && t.getAttribute('scope') === 'row'; })());

let clicked = null;
const nClick = nodes();
T.showRatings(nClick, index, data, league(), { onSort: c => { clicked = c; }, onScope() {} });
els(els(nClick.mount, 'rt')[0], 'rt-sort')[0].onclick();
ok('clicking a header hands back the column that was clicked',
  clicked && clicked.key === 'name', clicked && clicked.key);

/* ---------- 6. the two scales, and the claim that links them ---------- */
console.log('');
console.log('=== within-league versus across-leagues ===');
const nL = nodes(), nG = nodes();
T.showRatings(nL, index, data, league(), noop);
T.showRatings(nG, index, data, { scope: 'global', sort: { ...T.DEFAULT_SORT } }, noop);

ok('within-league draws one table per league that has teams',
  els(nL.mount, 'rt').length === 2, els(nL.mount, 'rt').length);
ok('across-leagues draws exactly one', els(nG.mount, 'rt').length === 1, els(nG.mount, 'rt').length);
ok('the cross-league table says out loud that it rests on a judgement call',
  els(nG.mount, 'notice').length === 1 && nG.mount.textContent.includes('judgement'),
  els(nG.mount, 'notice').length);
ok('the within-league table raises no caveat, having none to raise',
  els(nL.mount, 'notice').length === 0);
ok('only the cross-league table labels each team’s division',
  els(nG.mount, 'rt-abbr').length > 0 && els(nL.mount, 'rt-abbr').length === 0,
  [els(nG.mount, 'rt-abbr').length, els(nL.mount, 'rt-abbr').length]);
ok('every team appears exactly once in each view',
  els(nG.mount, 'rt-row').length === els(nL.mount, 'rt-row').length,
  [els(nG.mount, 'rt-row').length, els(nL.mount, 'rt-row').length]);
ok('each league table is captioned with its own name',
  els(nL.mount, 'rt-cap-name').map(c => c.textContent).join('|') === 'Premier League|La Liga',
  els(nL.mount, 'rt-cap-name').map(c => c.textContent));

/* The identity the page rests on. The quality coefficients multiply into attack
   and divide out of defence, so they cancel exactly for a same-league pair. If
   they did not, switching scale would reorder a division — and those
   coefficients are the one thing on this page that is admittedly a guess. */
const orderIn = (scope, slug) => M.powerTable(index, scope)
  .filter(r => r.leagueSlug === slug)
  .sort((a, b) => b.xPoints - a.xPoints || a.name.localeCompare(b.name))
  .map(r => r.id).join();
for (const slug of ['eng.1', 'esp.1']) {
  ok(`changing scale never reorders ${slug} within itself`,
    orderIn('league', slug) === orderIn('global', slug),
    [orderIn('league', slug), orderIn('global', slug)]);
}
ok('the two scales really are different numbers, or there would be no switch',
  M.powerTable(index, 'league').some(r => {
    const g = M.powerTable(index, 'global').find(x => x.id === r.id);
    return g && Math.abs(g.xPoints - r.xPoints) > 0.001;
  }));

/* ---------- 7. the figures in a row agree with each other ---------- */
console.log('');
console.log('=== internal consistency of a row ===');
const all = M.powerTable(index, 'league');
const s0 = all[0];
console.log('    ' + s0.short + ': att ' + s0.attack.toFixed(2) + '  def ' + s0.defence.toFixed(2) +
  '  xpts ' + s0.xPoints.toFixed(2) + '  (w ' + Math.round(s0.win * 100) + '% d ' +
  Math.round(s0.drawP * 100) + '% l ' + Math.round(s0.loss * 100) + '%)');

ok('win, draw and loss account for the whole probability',
  all.every(r => near(r.win + r.drawP + r.loss, 1)),
  all.map(r => +(r.win + r.drawP + r.loss).toFixed(4)).filter(v => !near(v, 1)).slice(0, 3));
ok('expected points is three for a win plus one for a draw, and nothing else',
  all.every(r => near(r.xPoints, 3 * r.win + r.drawP)),
  all.filter(r => !near(r.xPoints, 3 * r.win + r.drawP)).slice(0, 2).map(r => [r.short, r.xPoints]));
ok('no rating claims more than three points a game, or fewer than none',
  all.every(r => r.xPoints > 0 && r.xPoints < 3),
  all.map(r => r.xPoints).filter(v => v <= 0 || v >= 3));
/* Within one division a bigger attack rating must mean more expected goals,
   because both are measured against the same average opponent. Across divisions
   it need not, since each league's own goals-per-game baseline multiplies in —
   which is exactly the "meaningless across leagues" claim the scale switch
   exists to honour, so it is asserted rather than left implied. */
const monotoneIn = slug => {
  const s = all.filter(r => r.leagueSlug === slug)
    .sort((a, b) => a.attack - b.attack).map(r => r.xgFor);
  return s.every((v, i) => i === 0 || v >= s[i - 1] - 1e-9);
};
ok('inside one division, a stronger attack always means more expected goals',
  monotoneIn('eng.1') && monotoneIn('esp.1'));
ok('on the own-league scale, ratings from two divisions are not comparable',
  (() => {
    const s = [...all].sort((a, b) => a.attack - b.attack);
    return s.some((r, i) => i > 0 && r.xgFor < s[i - 1].xgFor - 1e-9);
  })(),
  'if this fails the two leagues happen to share a baseline and the fixture needs changing');

/* The documented identity is xpts = 1.5 minus half the draw chance, and the
   method page states it for a side rated exactly average. This is the exact
   version, true of every row: the gap from that figure is one and a half times
   the difference between winning and losing. It collapses to the documented
   form precisely when a team is as likely to win as to lose — which is what
   "exactly average" means, and is why the page words it that way. */
ok('xpts sits 1.5 x (win - loss) away from 1.5 minus half the draw chance, exactly',
  all.every(r => near(r.xPoints - (1.5 - 0.5 * r.drawP), 1.5 * (r.win - r.loss), 1e-9)),
  all.filter(r => !near(r.xPoints - (1.5 - 0.5 * r.drawP), 1.5 * (r.win - r.loss), 1e-9))
    .slice(0, 2).map(r => [r.short, r.xPoints, r.win, r.drawP, r.loss]));
ok('so the closer a side is to even odds, the closer it sits to that figure',
  (() => {
    const even = all.reduce((b, r) => Math.abs(r.win - r.loss) < Math.abs(b.win - b.loss) ? r : b);
    const lop  = all.reduce((b, r) => Math.abs(r.win - r.loss) > Math.abs(b.win - b.loss) ? r : b);
    const gap = r => Math.abs(r.xPoints - (1.5 - 0.5 * r.drawP));
    console.log('    nearest to even odds: ' + even.short + ', ' + gap(even).toFixed(3) +
      ' off 1.5-d/2; most lopsided: ' + lop.short + ', ' + gap(lop).toFixed(3) + ' off');
    return gap(even) < gap(lop);
  })());
ok('the tooltip on xpts quotes the same figure the cell prints',
  tds(table1, 'rt-xpts')[0].title.includes(tds(table1, 'rt-xpts')[0].textContent + ' points a game'),
  tds(table1, 'rt-xpts')[0].title);
ok('every figure is printed to two places, so a column reads as a column',
  tds(nL.mount, 'rt-attack').concat(tds(nL.mount, 'rt-defence'), tds(nL.mount, 'rt-xpts'))
    .every(td => /^\d+\.\d\d$/.test(td.textContent)));
ok('the rank column counts from one, in order, per table',
  tds(els(nL.mount, 'rt')[0], 'rt-rank').map(td => td.textContent).join() ===
  tds(els(nL.mount, 'rt')[0], 'rt-rank').map((_, i) => i + 1).join());

/* ---------- 8. how thin evidence is shown ---------- */
console.log('');
console.log('=== thin evidence, and the top row ===');
const THIN = MODEL.CONFIDENCE_CAP[1].minMatches;
const eplTable = els(nL.mount, 'rt')[0], espTable = els(nL.mount, 'rt')[1];
console.log('    matches behind each rating: eng.1 ' +
  tds(eplTable, 'rt-pl')[0].textContent + ', esp.1 ' + tds(espTable, 'rt-pl')[0].textContent +
  ' (threshold ' + THIN + ')');

ok('exactly one row per table is marked top',
  els(eplTable, 'is-top').length === 1 && els(espTable, 'is-top').length === 1);
ok('the top row is the first one', els(eplTable, 'rt-row')[0].className.includes('is-top'));
ok('a well-observed league is not dimmed', els(eplTable, 'is-thin').length === 0,
  els(eplTable, 'is-thin').length);
ok('a league under the threshold is dimmed in full',
  els(espTable, 'is-thin').length === els(espTable, 'rt-row').length,
  [els(espTable, 'is-thin').length, els(espTable, 'rt-row').length]);
ok('dimming follows the confidence cap rather than a second, private number',
  els(nL.mount, 'rt-row').every(tr =>
    tr.className.includes('is-thin') === (Number(els(tr, 'rt-pl')[0].textContent) < THIN)),
  els(nL.mount, 'rt-row').map(tr => [els(tr, 'rt-pl')[0].textContent, tr.className]).slice(0, 4));
ok('a dimmed row explains itself rather than just looking faded',
  tds(espTable, 'rt-pl')[0].title.includes('rests mostly on last season'),
  tds(espTable, 'rt-pl')[0].title);
ok('the match count is not pluralised as "1 matches"',
  tds(nL.mount, 'rt-pl').every(td => !/\b1 matches\b/.test(td.title)));
ok('a promoted side says where its rating came from',
  M.powerTable(index, 'league').some(r => r.promoted) === false ||
  els(nL.mount, 'rt-team').some(t => t.title.includes('promoted default')));

/* ---------- 9. the scope switch ---------- */
console.log('');
console.log('=== the scope switch ===');
let picked = null;
const nS = nodes();
T.showRatings(nS, index, data, league(), { onSort() {}, onScope: id => { picked = id; } });
const btns = els(nS.scope, 'toggle-b');
ok('one button per scale', btns.length === T.SCOPES.length, btns.length);
ok('the group is named for assistive software',
  els(nS.scope, 'toggle')[0].getAttribute('aria-label') === 'Rating scale');
ok('pressed state matches the scale in use',
  btns[0].getAttribute('aria-pressed') === 'true' && btns[1].getAttribute('aria-pressed') === 'false',
  btns.map(b => b.getAttribute('aria-pressed')));
ok('the active button is marked on, and only it',
  els(nS.scope, 'is-on').length === 1 && btns[0].className.includes('is-on'));
btns[1].onclick();
ok('picking the other scale reports which one', picked === 'global', picked);
picked = null;
btns[0].onclick();
ok('picking the scale already in use does nothing at all', picked === null, picked);
ok('each scale explains what it costs you',
  T.SCOPES.every(s => s.help.length > 40) &&
  T.SCOPES.find(s => s.id === 'global').help.includes('coefficients'));
ok('the switch is rebuilt, never appended to, on a repaint',
  (() => { T.showRatings(nS, index, data, league(), noop);
    return els(nS.scope, 'toggle-b').length === T.SCOPES.length; })(),
  els(nS.scope, 'toggle-b').length);

/* ---------- 10. degrading honestly ---------- */
console.log('');
console.log('=== when the data does not arrive ===');
const empty = { ...data, byLeague: Object.fromEntries(LEAGUES.map(l => [l.slug, blank()])) };
const nE = nodes();
T.showRatings(nE, M.buildIndex(empty), empty, league(), noop);
ok('no ratings means no table, not an empty one',
  els(nE.mount, 'rt').length === 0 && els(nE.mount, 'notice').length === 1);
ok('and it says so in words', nE.mount.textContent.includes('Nothing to rank yet'));
ok('it promises no invented ratings', nE.mount.textContent.includes('invented'));
ok('the scale switch survives, so the page is still navigable',
  els(nE.scope, 'toggle-b').length === 2);

const nErr = nodes();
T.showRatings(nErr, index,
  { ...data, errors: [{ league: 'esp.1', what: 'standingsNow', message: 'HTTP 500' }] },
  league(), noop);
ok('a failed request is reported above the tables, which still render',
  els(nErr.mount, 'notice').length === 1 && els(nErr.mount, 'rt').length === 2);
ok('the report says a league is missing rather than thinner than it is',
  nErr.mount.textContent.includes('missing from the table'));

/* ---------- 11. the status strip ---------- */
console.log('');
console.log('=== the status strip ===');
console.log('    ' + nL.status.textContent);
console.log('    ' + nG.status.textContent);
ok('counts teams, leagues and matches fitted',
  /\d+ teams/.test(nL.status.textContent) && /2 leagues/.test(nL.status.textContent) &&
  /\d+ matches fitted/.test(nL.status.textContent), nL.status.textContent);
ok('names the scale in use, since the figures mean different things on each',
  nL.status.textContent.includes('own-league scale') &&
  nG.status.textContent.includes('cross-league scale'),
  [nL.status.textContent, nG.status.textContent]);
ok('the team count matches the rows actually drawn',
  Number(nL.status.textContent.match(/(\d+) teams/)[1]) === els(nL.mount, 'rt-row').length,
  [nL.status.textContent, els(nL.mount, 'rt-row').length]);

/* ---------- 12. no markup, ever ---------- */
console.log('');
console.log('=== a hostile team name ===');
const hostileCell = els(nL.mount, 'rt-name').find(n => n.textContent === HOSTILE);
ok('a hostile name reaches the page intact', !!hostileCell, hostileCell && hostileCell.textContent);
ok('it is a text node, not an element',
  hostileCell.childNodes.length === 1 && hostileCell.childNodes[0].nodeType === 3,
  hostileCell.childNodes.map(c => c.nodeType));
ok('no img element exists anywhere on this page',
  tags(nL.mount, 'img').length === 0, tags(nL.mount, 'img').length);
ok('every element on the page is one table.js asked for by name',
  (() => {
    const allowed = ['div', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'button', 'p', 'b', 'h3', 'ul', 'li', 'code', 'a', 'strong', 'em'];
    return walk(nL.mount).filter(n => n.nodeType === 1).every(n => allowed.includes(n.tagName));
  })(),
  [...new Set(walk(nL.mount).filter(n => n.nodeType === 1).map(n => n.tagName))]);

/* ---------- 13. classes must exist in the stylesheet ---------- */
console.log('');
console.log('=== class audit ===');
const fs = await import('node:fs');
const css = fs.readFileSync(new URL('../assets/css/style.css', import.meta.url), 'utf8');
const emitted = new Set();
const harvest = root => walk(root).forEach(n => {
  if (n.nodeType === 1 && n.className) n.className.split(/\s+/).forEach(c => emitted.add(c));
});
[nL.mount, nG.mount, nL.status, nS.scope, nE.mount, nErr.mount].forEach(harvest);
{ const n = nodes(); T.showLoading(n); harvest(n.mount); }
const orphans = [...emitted].filter(c => !new RegExp('\\.' + c + '\\b').test(css));
console.log('    ' + emitted.size + ' distinct classes emitted');
ok('no class without styling', orphans.length === 0, orphans);

console.log('');
console.log(fails ? fails + ' FAILED' : 'ALL ASSERTIONS PASSED');
process.exit(fails ? 1 : 0);
