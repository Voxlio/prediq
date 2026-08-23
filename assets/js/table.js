/* =============================================================================
   table.js — the ratings view.

   One table per league, or one table across all of them, built from the same
   fit the fixtures page uses. There is no second model here and no second set
   of numbers: powerTable() reads the same ratings through the same grid, so a
   team that tops this page cannot be an underdog on its own match card.

   This file builds DOM and nothing else. It never fetches, never reads
   location, and never touches document beyond createElement — every node it
   needs is handed to it. That is what makes it testable outside a browser, and
   ratings.js is the twenty lines that wire it to the real page.

   The no-innerHTML rule holds here as everywhere: every string reaching the
   document goes through textContent or a text node.
   ========================================================================== */

import { powerTable, leagueSummaries } from './model.js';
import { MODEL } from './config.js';
import { el, clear, stat, setStatus, notice, errorNotice } from './dom.js';

export { showProgress, showFatal } from './dom.js';

/* =============================================================================
   1. COLUMNS

   `dir` is the direction a column sorts on its FIRST click, and it is not the
   same for every column: attack and expected points are best when high, but
   defence is a goals-conceded figure, so its best values are the low ones.
   Clicking "def" and being shown the leakiest defences in the division would be
   the wrong answer to the question actually being asked.

   A column with no `dir` cannot be sorted — the rank is a property of the
   current order, not of the team.

   `cell` is the class the header and the body cell share. They must share one,
   because the column width is declared once against it and `table-layout:
   fixed` reads that width off the header row only — a header styled under a
   different class than its column would silently size itself and nothing else.
   ========================================================================== */

export const COLUMNS = [
  { key: 'rank', label: '#', cell: 'rt-rank',
    help: 'Position in the current sort' },
  { key: 'name', label: 'team', cell: 'rt-team', dir: 1,
    help: 'Team name, alphabetical' },
  { key: 'matches', label: 'pl', cell: 'rt-pl', dir: -1,
    help: 'League matches this season behind the rating' },
  { key: 'attack', label: 'att', cell: 'rt-attack', dir: -1,
    help: 'Goals scored against an average side, where 1.00 is exactly average' },
  { key: 'defence', label: 'def', cell: 'rt-defence', dir: 1,
    help: 'Goals conceded on the same scale — lower is better' },
  { key: 'xpts', label: 'xpts', cell: 'rt-xpts', dir: -1,
    help: 'Expected points per game against an average side on neutral ground' },
];

export const DEFAULT_SORT = { key: 'xpts', dir: -1 };

/* The sort key on a row is not always the column key: `xpts` reads xPoints. */
const VALUE = {
  matches: r => r.matches,
  attack: r => r.attack,
  defence: r => r.defence,
  xpts: r => r.xPoints,
};

export function sortRows(rows, key, dir) {
  const read = VALUE[key];
  const out = [...rows];
  out.sort((a, b) => {
    if (!read) return dir * a.name.localeCompare(b.name);
    const d = dir * (read(a) - read(b));
    /* Ties fall through to the name so the order never depends on the order the
       data happened to arrive in. */
    return d || a.name.localeCompare(b.name);
  });
  return out;
}

/* Given the current sort and a clicked column, the next sort. Clicking the
   active column reverses it; clicking a new one starts from whichever direction
   actually answers the question that column asks. */
export function nextSort(sort, col) {
  return sort.key === col.key
    ? { key: col.key, dir: -sort.dir }
    : { key: col.key, dir: col.dir };
}

/* =============================================================================
   2. ONE TABLE

   A real <table>, because this is tabular data and a screen reader should be
   told so. Sortable headers are buttons inside their <th>, with aria-sort on
   the header itself, which is how assistive software is told what the current
   order actually is.
   ========================================================================== */

const two = n => n.toFixed(2);
const pc = n => Math.round(n * 100) + '%';

/* Below this many matches played, a rating still rests mostly on last season
   rather than on this one. Rows there are dimmed — the figure is not wrong, but
   it is a weaker claim, and the page should not present the two identically. */
const THIN = MODEL.CONFIDENCE_CAP[1].minMatches;

function headerRow(sort, onSort) {
  const tr = el('tr');
  for (const c of COLUMNS) {
    const th = el('th', 'rt-h ' + c.cell);
    th.setAttribute('scope', 'col');

    if (!c.dir) {
      th.textContent = c.label;
      th.title = c.help;
      tr.append(th);
      continue;
    }

    const active = sort.key === c.key;
    th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');

    const b = el('button', active ? 'rt-sort is-on' : 'rt-sort', c.label);
    b.setAttribute('type', 'button');
    b.title = c.help + '. Click to sort by this column.';
    b.onclick = () => onSort(c);
    /* aria-sort tells a screen reader which way the table runs. A sighted
       reader gets nothing from it, so the direction is also drawn. */
    if (active) b.append(el('span', 'rt-caret', sort.dir === 1 ? '↑' : '↓'));
    th.append(b);
    tr.append(th);
  }
  return tr;
}

export function bodyRow(r, rank, showLeague, summary) {
  const thin = r.matches < THIN;
  const tr = el('tr', 'rt-row' + (rank === 1 ? ' is-top' : '') + (thin ? ' is-thin' : ''));

  tr.append(el('td', 'rt-rank', String(rank)));

  /* The team cell. In the cross-league table the division is appended, because
     a hundred names in one list is otherwise impossible to place. */
  const team = el('th', 'rt-team');
  team.setAttribute('scope', 'row');
  team.append(el('span', 'rt-name', r.short));
  if (showLeague && summary) team.append(el('span', 'rt-abbr', summary.abbr));
  team.title = r.name + (r.promoted
    ? ' — no record in this division last season, so the rating started from the promoted default'
    : '');
  tr.append(team);

  const pl = el('td', 'rt-pl', String(r.matches));
  pl.title = thin
    ? `${r.matches} match${r.matches === 1 ? '' : 'es'} this season — this rating still rests mostly on last season`
    : `${r.matches} league matches counted`;
  tr.append(pl);

  const att = el('td', 'rt-attack', two(r.attack));
  att.title = `${two(r.xgFor)} goals expected against an average side`;
  tr.append(att);

  const def = el('td', 'rt-defence', two(r.defence));
  def.title = `${two(r.xgAgainst)} goals expected against, on the same match`;
  tr.append(def);

  const pts = el('td', 'rt-xpts', two(r.xPoints));
  pts.title = `Against an average side on neutral ground: win ${pc(r.win)}, draw ${pc(r.drawP)}, ` +
              `lose ${pc(r.loss)} — likeliest ${r.score.home}–${r.score.away}. ` +
              `That is ${two(r.xPoints)} points a game.`;
  tr.append(pts);

  return tr;
}

export function ratingsTable(rows, sort, onSort, caption, showLeague, summaries) {
  const t = el('table', 'rt');

  if (caption) {
    const cap = el('caption', 'rt-cap');
    cap.append(el('span', 'rt-cap-name', caption.name));
    cap.append(el('span', 'rt-cap-meta', caption.meta));
    t.append(cap);
  }

  const thead = el('thead');
  thead.append(headerRow(sort, onSort));
  t.append(thead);

  const tbody = el('tbody');
  const byLeague = new Map((summaries || []).map(s => [s.slug, s]));
  sortRows(rows, sort.key, sort.dir).forEach((r, i) => {
    tbody.append(bodyRow(r, i + 1, showLeague, byLeague.get(r.leagueSlug)));
  });
  t.append(tbody);

  return t;
}

/* =============================================================================
   3. THE SCOPE SWITCH

   Two scales, and the difference between them is not cosmetic. Within a league
   the ratings are purely fitted. Across leagues they are multiplied by the
   quality coefficients, which the method page states plainly are a judgement
   call. Switching to the cross-league view therefore raises a caveat with it,
   rather than quietly presenting a shakier number in the same typeface.
   ========================================================================== */

export const SCOPES = [
  { id: 'league', label: 'within league',
    help: 'Each division on its own scale, where 1.00 is average in that division. Nothing here is a judgement call.' },
  { id: 'global', label: 'across leagues',
    help: 'One combined table, using the league quality coefficients from the method page. Comparable between divisions, but only as good as those coefficients.' },
];

function scopeSwitch(current, onPick) {
  const wrap = el('div', 'toggle');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Rating scale');
  for (const s of SCOPES) {
    const on = s.id === current;
    const b = el('button', on ? 'toggle-b is-on' : 'toggle-b', s.label);
    b.setAttribute('type', 'button');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = s.help;
    b.onclick = () => { if (!on) onPick(s.id); };
    wrap.append(b);
  }
  return wrap;
}

/* =============================================================================
   4. THE PAGE
   ========================================================================== */

const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

export function showRatings(nodes, index, data, state, handlers) {
  const { mount, status, scope: scopeNode } = nodes;
  const summaries = leagueSummaries(index);
  const rows = powerTable(index, state.scope);

  clear(mount);
  clear(scopeNode);
  scopeNode.append(scopeSwitch(state.scope, handlers.onScope));

  const fitted = summaries.reduce((n, s) => n + s.matches, 0);
  setStatus(status, [
    stat(rows.length, plural(rows.length, 'team')),
    stat(summaries.length, plural(summaries.length, 'league')),
    stat(fitted, 'matches fitted'),
    state.scope === 'global' ? 'cross-league scale' : 'own-league scale',
  ]);

  if (data.errors.length) {
    mount.append(errorNotice(data.errors,
      'The leagues named are missing from the table below rather than shown thinner than they are.'));
  }

  if (!rows.length) {
    mount.append(notice(
      'Nothing to rank yet',
      'No league table reached the page, so there are no ratings to show. This is usually temporary — a reload normally fixes it. Prediq shows an empty table rather than invented ratings.',
      'warn'));
    return;
  }

  if (state.scope === 'global') {
    /* The one place on the site where the judgement-call coefficients change a
       number the reader is looking at. Said out loud, above the table. */
    mount.append(notice(
      'This table uses the league quality coefficients',
      'Ratings from different divisions are measured against different opponents, so comparing them needs a coefficient for how strong each division is. Those coefficients are an informed judgement, not a measurement — they are listed on the method page so you can discount them as you see fit. Within a single division they cancel out exactly, which is why the order inside each league is identical in both views.'));
    const meta = `${rows.length} teams · ${summaries.length} leagues · ` +
                 `${two(index.mean)} goals a side per game across all of them`;
    mount.append(ratingsTable(rows, state.sort, handlers.onSort,
      { name: 'All leagues, quality-adjusted', meta }, true, summaries));
    return;
  }

  for (const s of summaries) {
    const inLeague = rows.filter(r => r.leagueSlug === s.slug);
    if (!inLeague.length) continue;
    const meta = `${inLeague.length} teams · ${two(s.mean)} goals a side per game · ` +
                 `${s.matches} ${plural(s.matches, 'match')} fitted` +
                 (s.excluded ? ` · ${s.excluded} cup ${plural(s.excluded, 'tie')} discarded` : '');
    mount.append(ratingsTable(inLeague, state.sort, handlers.onSort,
      { name: s.name, meta }, false, summaries));
  }
}

export function showLoading(nodes) {
  setStatus(nodes.status, ['loading league tables']);
  clear(nodes.mount);
  const t = el('table', 'rt is-skeleton');
  t.setAttribute('aria-hidden', 'true');
  const tbody = el('tbody');
  /* The placeholder is laid out on the real column classes, so the table does
     not visibly resize the instant the data lands. */
  for (let i = 0; i < 8; i++) {
    const tr = el('tr', 'rt-row');
    for (const c of COLUMNS) {
      const td = el('td', c.cell);
      td.append(el('span', c.key === 'name' ? 'sk sk-md' : 'sk sk-xs'));
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(tbody);
  nodes.mount.append(t);
}
