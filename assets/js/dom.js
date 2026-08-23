/* =============================================================================
   dom.js — the furniture every page shares.

   Element building, the status strip, and the notices that can appear anywhere.
   There is no build step here, so anything used by more than one page lives in
   this file rather than being copied into each: a copied notice is a notice
   that will eventually say two different things.

   The no-innerHTML rule holds across every page that imports this. Each string
   reaching the document goes through textContent or a text node, so a team name
   or bookmaker name coming back from ESPN can never be read as markup. That is
   a deliberate constraint — it means the site cannot be made to render hostile
   content by a change at the far end of an API we do not control.
   ========================================================================== */

import { LEAGUES } from './config.js';

/* =============================================================================
   1. ELEMENTS
   ========================================================================== */

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* A label→value pair, the densest honest way to publish a figure. Used by the
   card readout and by both ratings tables. */
export function field(dl, term, value, title) {
  const box = el('div');
  if (title) box.title = title;
  box.append(el('dt', null, term), el('dd', null, value));
  dl.append(box);
  return box;
}

/* =============================================================================
   2. THE STATUS STRIP

   Every page carries one: a few counts of what the page is actually built from,
   so the reader can see the evidence base rather than take it on trust.
   ========================================================================== */

export function stat(value, label) {
  const s = el('span');
  s.append(el('b', null, String(value)), document.createTextNode(' ' + label));
  return s;
}

export function setStatus(node, parts) {
  if (!node) return;
  clear(node);
  parts.forEach((part, i) => {
    if (i) node.append(el('span', 'status-sep', '/'));
    node.append(typeof part === 'string' ? el('span', 'status-mute', part) : part);
  });
}

/* The label is the honest name of whatever is actually happening. Prediq loads
   in two phases and they are not the same activity: the first is reading
   fixture lists, the second is reading league tables and results. A bar that
   said "building model" through both would be wrong for half its life. */
export function showProgress(statusNode, done, total, label = 'building model') {
  setStatus(statusNode, [stat(`${done}/${total}`, 'requests'), label]);
}

/* =============================================================================
   3. NOTICES
   ========================================================================== */

export function notice(title, body, kind) {
  const box = el('div', kind ? `notice is-${kind}` : 'notice');
  box.append(el('p', 'notice-title', title), el('p', 'notice-body', body));
  return box;
}

export function showFatal(mount, statusNode, message) {
  setStatus(statusNode, ['could not load']);
  clear(mount);
  mount.append(notice(
    'No data reached the page',
    message || 'The football data source could not be reached. This is usually temporary — try again in a minute. Nothing is shown rather than something invented.',
    'warn'));
}

/* api.js records failures by league slug, because that is the machine-readable
   identity. Turning "eng.1" into "Premier League" is this layer's job. */
export function leagueName(slug) {
  return LEAGUES.find(l => l.slug === slug)?.name ?? slug;
}

/* A partial failure is stated plainly rather than papered over. The caller
   supplies the consequence, because it differs by page — a missing league
   weakens a prediction and removes a whole block of the ratings table. */
export function errorNotice(errors, consequence) {
  const failed = [...new Set(errors.map(e => leagueName(e.league)))];
  const n = errors.length;
  return notice(
    'Some data did not load',
    `${n} request${n === 1 ? '' : 's'} failed, affecting ${failed.join(', ')}. ${consequence}`,
    'warn');
}
