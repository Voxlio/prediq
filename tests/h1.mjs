/* method.html makes ~25 numeric claims about the model. Documentation drifts
   from code silently, so every claim carries data-cfg="PATH" and this suite
   resolves that path in config.js and compares. If someone retunes the model
   and forgets the page, this fails.

   The last section applies the same idea to SETUP.md, which quotes program output
   the reader is told to look for in a log. */

/* Paths resolve from this file, not from wherever it happens to be run.
   These suites used to carry an absolute sandbox path, which broke the moment
   the sandbox was renamed. */
const fs = await import('node:fs');
const root = new URL('../', import.meta.url).href;
const file = p => fs.readFileSync(new URL(p, root), 'utf8');
const cfg = await import(root + 'assets/js/config.js');

let fails = 0;
const ok = (l, c, g) => { console.log((c ? '  pass  ' : '  FAIL  ') + l + (c ? '' : '\n          got: ' + JSON.stringify(g))); if (!c) fails++; };

const html = file('method.html');
const index = file('index.html');
const css = file('assets/css/style.css');
/* Comments must go before any selector parsing: a class named only in a
   comment would otherwise satisfy the audit without being styled. */
const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- resolve a dotted path, numeric indexes included ---------- */
function resolve(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg);
}

/* ---------- pull every data-cfg element out of the markup ---------- */
const claims = [];
const re = /<([a-z]+)\s([^>]*?)data-cfg="([^"]+)"([^>]*)>/g;
let m;
while ((m = re.exec(html))) {
  const [full, tag, pre, path, post] = m;
  const attrs = pre + post;
  const close = html.indexOf('</' + tag + '>', m.index + full.length);
  const inner = html.slice(m.index + full.length, close);
  const text = inner.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
  const num = parseFloat(text.replace(/,/g, ''));
  const scale = /data-scale="([^"]+)"/.exec(attrs);
  const div = /data-div="([^"]+)"/.exec(attrs);
  claims.push({ path, text, num, scale: scale && +scale[1], div: div && +div[1] });
}

console.log('=== every number on the page against config.js ===');
console.log('    ' + claims.length + ' claims tagged');
ok('the page actually tags its claims', claims.length >= 20, claims.length);

let bad = [];
for (const c of claims) {
  const raw = resolve(c.path);
  /* Not every documented setting is a number. MODEL_REV is a string on purpose —
     it is hand-set, and '1.10' after '1.9' would be a smaller number and a later
     revision. So strings are compared as text, and only numbers get the scale and
     divisor treatment. */
  if (typeof raw === 'string') {
    if (c.text !== raw) bad.push([c.path, 'page says ' + c.text, 'config says ' + raw]);
    continue;
  }
  if (typeof raw !== 'number') { bad.push([c.path, 'not a number in config', raw]); continue; }
  const expected = c.scale ? raw * c.scale : c.div ? raw / c.div : raw;
  if (!Number.isFinite(c.num) || Math.abs(c.num - expected) > 1e-9) {
    bad.push([c.path, 'page says ' + c.text, 'config says ' + expected]);
  }
}
bad.forEach(b => console.log('        ' + b.join('  |  ')));
ok('every tagged number matches the code', bad.length === 0, bad);

/* ---------- claims stated in PROSE that depend on config ---------- */
console.log('');
console.log('=== prose claims that could silently go stale ===');
const { MODEL, DOMESTIC, LEAGUES } = cfg;

const cells = Math.pow(MODEL.MAX_GOALS + 1, 2);
ok('"a grid of 100 cells" is still true', !html.includes('100 cells') || cells === 100, cells);
ok('"the two factors always sum to 2" is still true',
  Math.abs(MODEL.HOME_ADVANTAGE + MODEL.AWAY_PENALTY - 2) < 1e-12,
  MODEL.HOME_ADVANTAGE + MODEL.AWAY_PENALTY);
ok('"about eleven per cent" matches the home factor',
  !/eleven per cent/.test(html) || Math.round((MODEL.HOME_ADVANTAGE - 1) * 100) === 11,
  MODEL.HOME_ADVANTAGE);
ok('"five leagues" matches how many we rate',
  !/five leagues/.test(html) || DOMESTIC.length === 5, DOMESTIC.length);
ok('every league named on the page is in config',
  ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1']
    .every(n => LEAGUES.some(l => l.name === n) && html.includes(n)));
ok('the Premier League really is the 1.00 baseline',
  LEAGUES.find(l => l.name === 'Premier League').quality === 1.00);
ok('no league is rated above the stated baseline',
  DOMESTIC.every(l => l.quality <= 1.00), DOMESTIC.map(l => [l.abbr, l.quality]));

/* How much probability does truncating at 4 goals actually lose? The page
   claims "about four per cent" — measure it rather than assert it. */
const pois = (k, lam) => { let p = Math.exp(-lam); for (let i = 1; i <= k; i++) p *= lam / i; return p; };
const keptTo = (n, lam) => { let s = 0; for (let k = 0; k <= n; k++) s += pois(k, lam); return s; };
const pairs = [[1.5, 1.2], [1.75, 1.05], [2.2, 1.0], [3.0, 0.95]];
console.log('    probability mass lost by stopping at 4 goals a side:');
let worst = 0;
for (const [h, a] of pairs) {
  const lost = 1 - keptTo(4, h) * keptTo(4, a);
  worst = Math.max(worst, lost);
  console.log('        xG ' + h.toFixed(2) + '-' + a.toFixed(2) + '   ' + (lost * 100).toFixed(1) + '%');
}
console.log('    at ' + MODEL.MAX_GOALS + ' goals, the worst case above loses ' +
  ((1 - keptTo(MODEL.MAX_GOALS, 3.0) * keptTo(MODEL.MAX_GOALS, 0.95)) * 100).toFixed(4) + '%');
const ceilLoss = 1 - keptTo(MODEL.MAX_GOALS, 3.0) * keptTo(MODEL.MAX_GOALS, 0.95);
ok('"under a fifth of one per cent" at our ceiling holds', ceilLoss < 0.002, ceilLoss);
ok('"three to eight per cent" covers an ordinary match',
  (1 - keptTo(4, 1.75) * keptTo(4, 1.05)) > 0.03 &&
  (1 - keptTo(4, 2.2) * keptTo(4, 1.0)) < 0.08,
  [1 - keptTo(4, 1.75) * keptTo(4, 1.05), 1 - keptTo(4, 2.2) * keptTo(4, 1.0)]);
ok('"around eighteen per cent" for a mismatch holds',
  Math.abs((1 - keptTo(4, 3.0) * keptTo(4, 0.95)) - 0.18) < 0.02,
  1 - keptTo(4, 3.0) * keptTo(4, 0.95));

/* ---------- the archive's prose arithmetic ----------
   Three claims in the record section are sums, not opinions. Each is measured
   here for the same reason the truncation loss above is measured: a number
   arrived at by hand once is a number nobody will recheck when the constant it
   came from moves. */

/* "every fixture is offered to the writer eight times before it starts" is
   FREEZE_WITHIN_HOURS divided by the cron interval — two numbers in two files
   that nothing else ties together. Retune either and this fails. */
const wf = file('.github/workflows/predictions.yml');
const cronM = /cron:\s*'(\S+)\s+\*\/(\d+)\s/.exec(wf);
ok('the workflow really is on an every-N-hours cron', !!cronM, cronM && cronM[0]);
if (cronM) {
  const everyH = +cronM[2];
  const chances = cfg.FREEZE_WITHIN_HOURS / everyH;
  console.log('    lead time ' + cfg.FREEZE_WITHIN_HOURS + 'h on an every-' + everyH +
              'h cron = ' + chances + ' chances per fixture');
  ok('"runs every three hours" matches the cron', /every three hours/.test(html) === (everyH === 3), everyH);
  ok('"offered to the writer eight times" is that division',
    !/eight times/.test(html) || chances === 8, chances);
  ok('the lead time leaves several chances, not one',
    chances >= 4 && Number.isInteger(chances), chances);
}

/* "eight right out of twelve ... about one time in five", and the threshold
   MIN_FOR_RATE is set to. Both are binomial tails under a fair coin. */
const lchoose = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const binom = (k, n) => Math.exp(lchoose(n) - lchoose(k) - lchoose(n - k) - n * Math.LN2);
const atLeast = (k, n) => { let s = 0; for (let k2 = k; k2 <= n; k2++) s += binom(k2, n); return s; };
const fluke12 = atLeast(8, 12);
const flukeN = atLeast(Math.ceil(cfg.MIN_FOR_RATE * 8 / 12), cfg.MIN_FOR_RATE);
console.log('    8-of-12 on a fair coin: 1 in ' + (1 / fluke12).toFixed(1) +
            ';  the same rate over ' + cfg.MIN_FOR_RATE + ': 1 in ' + (1 / flukeN).toFixed(0));
ok('"about one time in five" is the 8-of-12 tail',
  !/one time in five/.test(html) || Math.abs(1 / fluke12 - 5) < 0.75, 1 / fluke12);
ok('MIN_FOR_RATE is high enough that the same fluke is rare, as config.js claims',
  flukeN < 0.01, flukeN);
ok('and MIN_FOR_RATE is the smaller-sample threshold, not the calibration one',
  cfg.MIN_FOR_RATE >= 30 && cfg.MIN_FOR_RATE <= 200, cfg.MIN_FOR_RATE);

/* ---------- coverage: does the page document every knob? ----------
   The forward check catches a page that lies. This catches a page that goes
   quiet — a parameter added to config.js and never explained. Anything left
   deliberately undocumented has to be named here, so the omission is a
   decision on the record rather than an oversight. */
console.log('');
console.log('=== does the page document every tuning parameter? ===');
const tagged = new Set(claims.map(c => c.path));
const EXEMPT = {
  HOME_ADV_PRIOR:  'the fallback the measured home effect blends toward — described in words, not worth a figure',
  MIN_STRENGTH:    'a sanity clamp, never reached in normal play',
  MAX_STRENGTH:    'a sanity clamp, never reached in normal play',
};
const undocumented = Object.keys(MODEL)
  .filter(k => ![...tagged].some(p => p === 'MODEL.' + k || p.startsWith('MODEL.' + k + '.')));
undocumented.forEach(k => console.log('    ' + (EXEMPT[k] ? 'exempt  ' : 'MISSING ') + k +
  (EXEMPT[k] ? '  — ' + EXEMPT[k] : '')));
ok('no model parameter is silently undocumented',
  undocumented.every(k => EXEMPT[k]), undocumented.filter(k => !EXEMPT[k]));
ok('every confidence tier is published',
  MODEL.CONFIDENCE.filter(t => t.min > 0).every((_, i) => tagged.has('MODEL.CONFIDENCE.' + i + '.min')),
  MODEL.CONFIDENCE.map(t => t.min));
ok('every league quality coefficient is published',
  DOMESTIC.every((_, i) => tagged.has('LEAGUES.' + i + '.quality')), DOMESTIC.length);
const ttlUndoc = Object.keys(cfg.CACHE.ttl).filter(k => !tagged.has('CACHE.ttl.' + k));
console.log('    cache TTLs not listed: ' + (ttlUndoc.join(', ') || 'none'));
ok('the cache policy is at least broadly published', ttlUndoc.length <= 2, ttlUndoc);

/* The same check one level up. MODEL is not the only place a setting lives: the
   archive's lead time, the threshold before a hit rate is quoted, and the model
   revision are all top-level exports, and each is a promise to the reader rather
   than an implementation detail. Auditing only MODEL.* meant a new constant of
   that kind could be added and never explained. Objects and functions are skipped
   — they are audited by their own paths above, or are not settings at all. */
const TOP_EXEMPT = {
  currentSeason: 'a function, not a setting',
  /* The method page explains how a number is arrived at, and this one changes
     nothing about any number — the fit runs over every league and every match
     before a single card is filtered or sliced. Documenting it there would
     invite the reading that page size affects the model. */
  PAGE_SIZE: 'how many cards are shown at once; affects no computed value',
};
const topUndoc = Object.entries(cfg)
  .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
  .map(([k]) => k)
  .filter(k => !tagged.has(k) && !TOP_EXEMPT[k]);
console.log('    top-level settings not documented: ' + (topUndoc.join(', ') || 'none'));
ok('no top-level setting is silently undocumented', topUndoc.length === 0, topUndoc);

/* ---------- links, assets, and classes ---------- */
console.log('');
console.log('=== links and assets ===');
/* All four pages, not just two of them: a dead href on the ratings page is as
   dead as one here, and the shared bar means a rename breaks all four at once. */
const PAGES = ['index.html', 'record.html', 'ratings.html', 'method.html'];
const pageSrc = new Map(PAGES.map(p => [p, file(p)]));
/* Comments come out first. A grep for id="..." otherwise counts ids that are
   only *mentioned* in a comment — the same trap the CSS class audit fell into,
   and it fired here immediately: a comment explaining an anchor made the page
   look like it declared that anchor twice. */
const bare = s => s.replace(/<!--[\s\S]*?-->/g, '');
const idsIn = s => [...bare(s).matchAll(/\sid="([^"]+)"/g)].map(mm => mm[1]);

const localLinks = new Set();
const badFrag = [];
const dupIds = [];
for (const [page, src] of pageSrc) {
  const ids = idsIn(src);
  const dups = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dups.length) dupIds.push(page + ': ' + [...new Set(dups)].join(', '));
  for (const mm of bare(src).matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = mm[1];
    if (/^(?:https?:|mailto:)/.test(raw)) continue;
    const [path, frag] = raw.split('#');
    if (path) localLinks.add(path);
    /* A fragment is the one kind of link that rots without a 404: the browser
       lands at the top of the page and nothing looks wrong. The previous check
       skipped any href containing a '#' outright, so every skip link and
       method.html#record went unverified. */
    if (frag !== undefined) {
      const target = path || page;
      const tsrc = pageSrc.get(target);
      if (!tsrc || !idsIn(tsrc).includes(frag)) badFrag.push(page + ' → ' + raw);
    }
  }
}
const missing = [...localLinks].filter(p => !fs.existsSync(new URL(p, root)));
console.log('    ' + [...localLinks].join(', '));
ok('every local link and asset exists', missing.length === 0, missing);
ok('every #fragment link lands on an id that exists', badFrag.length === 0, badFrag);
ok('no page declares the same id twice', dupIds.length === 0, dupIds);
ok('index links to the method page', /href="method\.html"/.test(index));
ok('method links back to the fixtures', /href="index\.html"/.test(html));
ok('both pages load the same stylesheet',
  (html.match(/assets\/css\/style\.css/g) || []).length === 1 &&
  (index.match(/assets\/css\/style\.css/g) || []).length === 1);
ok('the method page loads no JavaScript at all', !/<script/.test(html));

/* ---------- the fonts come from here, not from a CDN ----------
   Three link tags used to sit in every <head>, so the site made a third-party
   request on every page load and handed Google an IP address and a user agent
   before drawing a single pixel — while promising, in the footer and in section 9,
   "no cross-site tracking". These are the checks that make that promise
   machine-checked rather than merely written down.

   Deliberately a search of all four pages for the host rather than for the tag: a
   preconnect, a preload and a stylesheet link leak identically, and only the last
   of the three looks like it is fetching anything. */
const cdnFont = [...pageSrc]
  .filter(([, s]) => /fonts\.(?:googleapis|gstatic)\.com/.test(s)).map(([p]) => p);
ok('no page fetches a font from a CDN', cdnFont.length === 0, cdnFont);
const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map(mm => mm[0]);
ok('the stylesheet declares both families itself', faces.length === 2, faces.length);
/* A range rather than a single weight, because these are variable files and one
   number would silently throw away the other four weights the site asks for.
   swap rather than the default, which hides text until the file arrives. */
ok('each face carries a weight range and swaps rather than blocking',
  faces.every(f => /font-weight:\s*\d+\s+\d+/.test(f) && /font-display:\s*swap/.test(f)));
const fontUrls = [...css.matchAll(/url\('([^']+)'\)/g)].map(mm => mm[1]);
const noFont = fontUrls.filter(u => !fs.existsSync(new URL('assets/css/' + u, root)));
console.log('    ' + fontUrls.join(', '));
ok('every font file the stylesheet asks for exists', noFont.length === 0, noFont);
/* Redistributing an OFL font without its licence is the one way this change could
   swap a privacy problem for a licensing one. */
ok('the licence the fonts are redistributed under travels with them',
  fs.existsSync(new URL('assets/fonts/OFL.txt', root)));

const used = new Set();
for (const mm of html.matchAll(/class="([^"]+)"/g)) mm[1].split(/\s+/).forEach(c => used.add(c));
/* The boundary here is a negative lookahead rather than \b, and that is not
   pedantry: \b sits happily between a word character and a hyphen, so an
   entirely unstyled class `foo` would pass on the strength of a `.foo-bar` rule
   somewhere else in the file. That bug was live — `masthead` passed by matching
   `.masthead-row`, and went on passing after `.masthead` itself was deleted. */
const styledIn = (c, s) => new RegExp('\\.' + c.replace(/\./g, '\\.') + '(?![\\w-])').test(s);
const styled = c => styledIn(c, cssBare);
const orphans = [...used].filter(c => !styled(c));
console.log('    ' + used.size + ' classes used on the method page');
ok('no class without styling', orphans.length === 0, orphans);
/* Asserted against a fixed sample, not against real class names: the point is
   that the audit can still say no, and real names drift out from under a test
   that leans on them. */
const sample = '.foo-bar { color: red } .baz { color: red }';
ok('the audit rejects a class that is only a prefix of a real rule',
  !styledIn('foo', sample) && styledIn('foo-bar', sample) && styledIn('baz', sample));

/* ---------- the stylesheet's table of contents ----------
   style.css opens with an "Order:" list of its sections. A list of contents that
   has drifted from its contents is worse than none, because it is trusted for
   exactly as long as it takes someone to act on it — and this one had already
   drifted before anything checked it: it omitted "The record" entirely and still
   called section 4 "masthead" after that name was gone from the file.

   Numbered headers only. The record section has unnumbered sub-headers of the
   same shape (`--- what happened ---`), and they are not sections. */
console.log('');
console.log('=== the stylesheet index ===');
const sections = [...css.matchAll(/^\/\* --- (\d+)\. (.+?) -{3,}/gm)]
  .map(mm => ({ n: +mm[1], name: mm[2].trim() }));
const order = (/^ {3}Order: ([\s\S]*?)\n {3}=+ \*\//m.exec(css) || [, ''])[1]
  .split('→').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

console.log('    ' + sections.length + ' sections, ' + order.length + ' listed in the index');
ok('the stylesheet has sections to check at all', sections.length > 10, sections.length);
ok('and its index lists exactly as many', order.length === sections.length,
  [order.length, sections.length]);
ok('the section numbers run 1..n with no gaps and no repeats',
  sections.every((s, i) => s.n === i + 1), sections.map(s => s.n));
/* Compared by name and in order, so moving a section without moving its entry
   fails as loudly as deleting one. */
const nameDrift = (found, listed) => found
  .map((s, i) => (s.name === listed[i] ? null : (i + 1) + ': index says "' +
    (listed[i] ?? '(nothing)') + '", file says "' + s.name + '"'))
  .filter(Boolean);
ok('every section appears in the index, in the same order, under the same name',
  nameDrift(sections, order).length === 0, nameDrift(sections, order));
/* That the comparison can still say no, proved on a fixed pair rather than on
   the real file — a non-vacuity check that leans on real section names is one
   rename away from being vacuous itself, which is the trap it exists to catch. */
const fake = [{ n: 1, name: 'Tokens' }, { n: 2, name: 'Masthead' }];
ok('the comparison notices a rename, a reorder and a missing entry',
  nameDrift(fake, ['Tokens', 'The bar']).length === 1 &&
  nameDrift(fake, ['Masthead', 'Tokens']).length === 2 &&
  nameDrift(fake, ['Tokens']).length === 1 &&
  nameDrift(fake, ['Tokens', 'Masthead']).length === 0);

/* ---------- the fixed bar ----------
   There is no build step and no template, so the bar is four hand-written
   copies of the same markup. Nothing but this section stops them drifting: a
   link added to one page and forgotten on the other three would look completely
   normal on whichever page you happened to be reading.

   The geometry checks matter for a different reason. A fixed bar occupies no
   space in the flow, so the first screenful of every page sits underneath it
   unless .shell reserves room — and the reservation is only correct as long as
   it stays derived from --bar-h instead of being typed out as a number. */
console.log('');
console.log('=== the fixed bar, on all four pages ===');
const MARK = ' class="is-here" aria-current="page"';
const bars = new Map();
for (const p of PAGES) {
  const src = pageSrc.get(p);
  const all = [...src.matchAll(/<header class="topbar">[\s\S]*?<\/header>/g)];
  ok(p + ' has exactly one bar', all.length === 1, all.length);
  if (all.length === 1) bars.set(p, all[0][0]);
}

if (bars.size === PAGES.length) {
  const stripped = [...bars].map(([p, b]) => [p, b.split(MARK).join('')]);
  const [, first] = stripped[0];
  const differ = stripped.filter(([, b]) => b !== first).map(([p]) => p);
  ok('all four bars are byte-identical once the current-page marker is removed',
    differ.length === 0, differ);

  for (const [p, bar] of bars) {
    const marked = [...bar.matchAll(/<a href="([^"]+)"\s+class="is-here"/g)].map(mm => mm[1]);
    ok(p + ' marks exactly itself as the current page',
      marked.length === 1 && marked[0] === p, marked);
    /* Four links, four icons, four labels. A copy that lost its <span> would
       still look right — the label is only hidden on a narrow screen — while
       announcing as nothing to a screen reader there. */
    ok(p + ' carries four links, each with an icon and a label',
      (bar.match(/<a href=/g) || []).length === 4 &&
      (bar.match(/class="nav-i"/g) || []).length === 4 &&
      (bar.match(/class="nav-t"/g) || []).length === 4);
    ok(p + '\u2019s icons are decorative and sized by a viewBox',
      (bar.match(/viewBox="0 0 24 24"/g) || []).length === 4 &&
      (bar.match(/aria-hidden="true"/g) || []).length === 4);
    ok(p + '\u2019s nav is labelled, since a page may hold more than one',
      /<nav class="nav" aria-label="Primary">/.test(bar));
    /* The bar is the first thing in the body, so it is also the first thing
       tabbed into. The skip link has to come before it or it skips nothing. */
    const src = pageSrc.get(p);
    ok(p + ' puts the skip link ahead of the bar',
      src.indexOf('class="skip"') > 0 && src.indexOf('class="skip"') < src.indexOf('<header class="topbar">'));
  }
}

/* Every page the bar links to must exist, and every page must be linked. A bar
   pointing at a page that was renamed is a 404 on all four pages at once.
   Order is pinned deliberately — fixtures first, method last — because
   byte-identical bars would otherwise keep all four pages consistently wrong. */
const navEl = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(bars.get('index.html') || '');
const navTargets = navEl ? [...navEl[1].matchAll(/href="([^"]+)"/g)].map(mm => mm[1]) : [];
ok('the nav links to all four pages, in order, and nothing else',
  navTargets.join() === PAGES.join(), navTargets);
const navMissing = navTargets.filter(p => !fs.existsSync(new URL(p, root)));
ok('every page the nav links to exists', navMissing.length === 0, navMissing);
/* The wordmark sits outside the nav and is the fifth way home. If it ever stops
   being a link the logo silently becomes decoration. */
ok('the wordmark links home',
  /<a class="wordmark" href="index\.html">/.test(bars.get('index.html') || ''));

/* ---------- geometry ---------- */
/* Two sections need to know where an @media block ends, and a positional
   comparison is no substitute: a rule sitting after a media query's opening
   brace may still be outside the query. That mistake made the first version of
   the check below pass while the labels were hidden at every width. */
function blockAt(s, at) {
  if (at < 0) return '';
  let depth = 0;
  for (let i = s.indexOf('{', at); i >= 0 && i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
  }
  return '';
}

const barH = /--bar-h:\s*([\d.]+)rem/.exec(cssBare);
ok('--bar-h is declared as a token', !!barH, barH && barH[1]);
ok('the bar is fixed rather than sticky, and its height is the token',
  /\.topbar\s*\{[^}]*position:\s*fixed[^}]*\}/.test(cssBare) &&
  /\.topbar\s*\{[^}]*height:\s*var\(--bar-h\)[^}]*\}/.test(cssBare));
/* A fixed bar plus an in-page #anchor is a classic pairing that goes wrong:
   the browser scrolls the target to y=0, which is behind the bar. */
ok('in-page jumps clear the bar via scroll-padding-top',
  /scroll-padding-top:\s*calc\(var\(--bar-h\)/.test(cssBare));
/* Focusing the skip link must not reveal it underneath the bar, which is the
   one thing the link exists to avoid. */
ok('the skip link sits above the bar',
  /\.skip\s*\{[^}]*position:\s*fixed[^}]*\}/.test(cssBare));

/* Counted against the number of .shell rules that set padding at all, rather
   than against a fixed number. Pinning it to 2 was the earlier version, and it
   made adding a breakpoint fail the suite for no reason — while a *fourth*
   breakpoint that hardcoded its top padding would then have been "fixed" by
   bumping the number, which is the wrong repair. This says: however many there
   are, every one of them derives the top from --bar-h. */
const shellDecls = [...cssBare.matchAll(/\.shell\s*\{([^}]*)\}/g)].map(mm => mm[1]);
const shellPadding = shellDecls.filter(d => /padding:/.test(d));
const shellPads = shellPadding
  .map(d => /padding:\s*calc\(var\(--bar-h\)\s*\+\s*([\d.]+)rem\)/.exec(d))
  .filter(Boolean).map(mm => +mm[1]);
ok('every .shell padding reserves the bar height plus clearance, derived not typed',
  shellPadding.length >= 2 && shellPads.length === shellPadding.length &&
  shellPads.every(v => v > 0), [shellPadding.length, shellPads]);
ok('no .shell padding hardcodes a length where --bar-h belongs',
  ![...cssBare.matchAll(/\.shell\s*\{([^}]*)\}/g)].some(mm => /padding:\s*[\d.]/.test(mm[1])));

/* The three ranges encode a decision that is easy to undo by accident: they are
   split by what stops fitting, not by device. 44rem is where the column stops
   fitting its contents, 34rem is where the bar stops fitting the nav labels, and
   the narrow block inherits the wider one rather than repeating it. Nest them the
   wrong way round and the narrow rules would be overridden by the wide ones at
   phone width — silently, since both blocks would still be present. */
const maxBps = [...cssBare.matchAll(/@media \(max-width: ([\d.]+)rem\)/g)].map(mm => +mm[1]);
const minBps = [...cssBare.matchAll(/@media \(min-width: ([\d.]+)rem\)/g)].map(mm => +mm[1]);
ok('there are exactly two narrow ranges and they nest, widest declared first',
  maxBps.length === 2 && maxBps[0] > maxBps[1], maxBps);
ok('and one wide range, starting clear of both', minBps.length === 1 &&
  minBps[0] > maxBps[0], [minBps, maxBps]);
/* The wide block widens containers, never the reading measure. 42rem is about 75
   characters, and method.html is nothing but prose. */
const wide = blockAt(cssBare, cssBare.indexOf('@media (min-width: ' + minBps[0] + 'rem)'));
ok('the wide range leaves the reading measure alone',
  wide.length > 0 && !/--measure:/.test(wide));

/* Section 21 claims the narrow block inherits the wider one rather than repeating
   it. This is what makes that true instead of aspirational. A duplicated selector
   would break nothing visibly — it would just mean two places to edit and the
   later one silently winning, which is how the two ranges got conflated in the
   first place. */
const selsIn = block => {
  const inner = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  return new Set([...inner.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map(mm => mm[1].replace(/\s+/g, ' ').trim()).filter(Boolean));
};
const colSels = selsIn(blockAt(cssBare, cssBare.indexOf('@media (max-width: ' + maxBps[0] + 'rem)')));
const phoneSels = selsIn(blockAt(cssBare, cssBare.indexOf('@media (max-width: ' + maxBps[1] + 'rem)')));
const dupSel = [...colSels].filter(s => phoneSels.has(s));
console.log('    ' + colSels.size + ' selectors at ' + maxBps[0] + 'rem, ' +
  phoneSels.size + ' at ' + maxBps[1] + 'rem, ' + selsIn(wide).size + ' wide');
ok('both ranges actually carry rules', colSels.size > 5 && phoneSels.size > 5);
ok('and no selector is declared in both, so the narrow range inherits the wider',
  dupSel.length === 0, dupSel);

/* fill:none is the load-bearing declaration. SVG fills black by default, so a
   stroke-drawn icon that loses it renders as a solid blob — a failure that
   looks deliberate rather than broken. The markup carries no fill attribute of
   its own, so there is nothing to fall back on. */
const navI = /\.nav-i\s*\{([^}]*)\}/.exec(cssBare);
ok('.nav-i exists and sets fill:none, without which the icons fill black',
  !!navI && /fill:\s*none/.test(navI[1]));
ok('.nav-i strokes in the current colour, so the nav inherits its own hover',
  !!navI && /stroke:\s*currentColor/.test(navI[1]) && /stroke-width:/.test(navI[1]));
ok('the icon markup carries no presentation attributes, only geometry',
  ![...bars.values()].some(b => /<svg[^>]*\s(?:fill|stroke)=/.test(b)));

/* The narrow-screen rule hides the labels. It must hide them from the eye only:
   the icon is aria-hidden, so the label is the link's entire accessible name,
   and display:none would take it out of the accessibility tree and leave four
   links that announce as nothing but a URL. style.css says h1 checks this. */
const narrowAt = cssBare.indexOf('@media (max-width: 34rem)');
const narrow = blockAt(cssBare, narrowAt);
ok('there is a narrow-screen block at all', narrow.length > 0);
const navT = /\.nav-t\s*\{([^}]*)\}/.exec(narrow);
ok('.nav-t is hidden by clipping, never by display:none',
  !!navT && /clip-path:\s*inset\(50%\)/.test(navT[1]) && !/display:\s*none/.test(navT[1]));
/* And nowhere else — hiding the labels at every width would make the nav
   icon-only for everyone, which is not what the icons are for. */
ok('the labels are hidden only on a narrow screen',
  !!navT && !/\.nav-t\s*\{/.test(cssBare.slice(0, narrowAt) + cssBare.slice(narrowAt + narrow.length)));
/* Wrapping would be invisible: the bar's height is fixed and .shell reserves
   exactly that, so a second row is clipped rather than pushing anything down. */
ok('the nav cannot wrap into a row that would be clipped',
  /\.nav\s*\{[^}]*flex-wrap:\s*nowrap/.test(cssBare));

/* ---------- animations ----------

   Two silent failures live here, and neither is visible to the class audit. A
   rule can name an animation with no @keyframes block, in which case nothing
   moves and nothing complains. And the reduced-motion block is an explicit list
   of selectors rather than a blanket rule, so an animation missing from that
   list plays anyway for someone who asked for stillness — an accessibility
   regression that looks like nothing at all. style.css claims this check greps
   for it, so it had better. */
console.log('');
console.log('=== animations ===');
const rmAt = cssBare.indexOf('@media (prefers-reduced-motion');
ok('there is a reduced-motion block at all', rmAt >= 0);
const rmBlock = blockAt(cssBare, rmAt);
const outsideRm = cssBare.slice(0, rmAt) + cssBare.slice(rmAt + rmBlock.length);
const flatRule = /([^{}]+)\{([^{}]*)\}/g;

const animated = [];
for (const r of outsideRm.matchAll(flatRule)) {
  const decl = /animation:\s*([^;]+)/.exec(r[2]);
  if (!decl || /^none/.test(decl[1].trim())) continue;
  const name = decl[1].trim().split(/\s+/)[0];
  r[1].split(',').forEach(sel => animated.push({ sel: sel.trim().replace(/\s+/g, ' '), name }));
}
const stilled = new Set();
for (const r of rmBlock.matchAll(flatRule)) {
  if (!/animation:\s*none/.test(r[2])) continue;
  r[1].split(',').forEach(sel => stilled.add(sel.trim().replace(/\s+/g, ' ')));
}
console.log('    animated: ' + animated.map(a => a.sel + ' → ' + a.name).join(', '));
console.log('    stilled:  ' + [...stilled].join(', '));
ok('found the animations at all', animated.length >= 3, animated.length);
const dangling = animated.filter(a => !new RegExp('@keyframes\\s+' + a.name + '\\b').test(cssBare));
ok('every animation names a @keyframes block that exists', dangling.length === 0, dangling);
const unstilled = animated.filter(a => !stilled.has(a.sel)).map(a => a.sel);
ok('every animated selector is switched off under prefers-reduced-motion',
  unstilled.length === 0, unstilled);
ok('the reduced-motion list is not a blanket rule that would hide the above',
  !/\*\s*\{[^}]*animation:\s*none/.test(rmBlock));

/* ---------- the double-marker trap ----------
   A list that draws its own numeral in ::before shows TWO markers unless the
   native one is suppressed. Nothing in the class audit can see that, and .steps
   shipped with the bug. Assert the rule rather than trusting it. */
console.log('');
console.log('=== list markers ===');
const rules = [...cssBare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map(r => ({ sel: r[1].trim().replace(/\s+/g, ' '), body: r[2] }));
const counters = rules.filter(r => /::before/.test(r.sel) && /content:\s*counter\(/.test(r.body));
console.log('    lists drawing their own numeral: ' + counters.map(c => c.sel).join(', '));
ok('found the counter list at all', counters.length > 0);
for (const c of counters) {
  const owner = c.sel.split(/\s|>/)[0];
  const suppressed = rules.some(r =>
    r.sel.split(',').map(x => x.trim()).includes(owner) && /list-style/.test(r.body));
  ok(owner + ' suppresses its native marker', suppressed, c.sel);
}
ok('ol is in the margin/padding reset',
  rules.some(r => /^h1,/.test(r.sel) && /\bol\b/.test(r.sel) && /padding:\s*0/.test(r.body)));
ok('a plain <ol> would still number itself',
  !rules.some(r => r.sel.split(',').map(x => x.trim()).includes('ol') && /list-style:\s*none/.test(r.body)));

/* ---------- structural sanity ---------- */
console.log('');
console.log('=== structure ===');
for (const tag of ['html', 'head', 'body', 'main', 'section', 'ol', 'ul', 'dl', 'li', 'p', 'div', 'footer', 'header']) {
  const open = (html.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
  const shut = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (open !== shut) ok('balanced <' + tag + '>', false, [open, shut]);
}
ok('all block tags balanced', true);
ok('one h1 only', (html.match(/<h1/g) || []).length === 1);
/* The sequence itself, not just "every number appears somewhere". Renumbering by
   hand after inserting a section leaves two sections with the same number, and
   the old form of this check passed straight through that: 1..7 all appeared, and
   the second 7 was invisible to it. */
const secNums = [...html.matchAll(/class="sec-h">(\d+) &middot; /g)].map(m2 => +m2[1]);
console.log('    section numbers: ' + secNums.join(', '));
ok('sections are numbered 1..n once each, in order',
  secNums.length > 0 && secNums.every((n, i) => n === i + 1), secNums);
ok('lang and viewport set', /<html lang="en">/.test(html) && /name="viewport"/.test(html));
ok('has a skip link to the content', /class="skip" href="#method"/.test(html) && /id="method"/.test(html));
ok('page has its own title and description',
  /<title>Method/.test(html) && /name="description"/.test(html));

/* ---------- SETUP.md against the code it describes ----------
   The same problem as method.html, one step further out. SETUP.md is the only
   thing standing between a new clone and a working archive, and it quotes program
   output verbatim — a sample log, an error message, the flags to run. Reword a
   console.log and the guide starts describing a program that no longer exists,
   which is worse than no guide, because the reader trusts it and then can't find
   the line it told them to look for.

   Only claims are checked here. The sample log's own tallies (47 fixtures, 6
   predictions) are illustrative and stay unasserted; the numbers below are
   promises to the reader, derived from config. */
console.log('');
console.log('=== SETUP.md against the code it describes ===');
const setup = file('SETUP.md');

/* Output the guide quotes, against the file that prints it. Each is a string the
   reader is told to search a log for. */
const quoted = [
  ['freeze reports what it left alone',      'left as first written',      'tools/freeze.mjs'],
  ['settle reports an idle run',             'nothing awaiting a result',  'tools/settle.mjs'],
  ['the workflow reports a no-op archive',   'archive unchanged',          '.github/workflows/predictions.yml'],
  ['the mirror names its service account',   ', service account ',         'tools/mirror.mjs'],
  ['the mirror rejects a wrong-project key', 'firebase-config.js says',    'tools/mirror.mjs'],
  ['the mirror names the IAM role to add',   'lacks Cloud Datastore',      'tools/mirror.mjs'],
  ['the mirror labels an example id',        '(e.g. ',                     'tools/mirror.mjs'],
];
for (const [label, needle, src] of quoted) {
  ok(label + ' — and SETUP.md quotes it', setup.includes(needle) && file(src).includes(needle),
    [setup.includes(needle) ? 'in SETUP.md' : 'NOT in SETUP.md',
     file(src).includes(needle) ? 'in ' + src : 'NOT in ' + src]);
}

/* Flags the guide tells the reader to type. A flag documented but not parsed runs
   the tool for real against a database. */
for (const t of ['freeze', 'settle', 'mirror']) {
  const src = file('tools/' + t + '.mjs');
  ok('tools/' + t + '.mjs really parses --dry-run',
    /argv\.includes\('--dry-run'\)/.test(src) && setup.includes('tools/' + t + '.mjs --dry-run'));
}
ok('the mirror really parses --all, as the catch-up instruction assumes',
  /argv\.includes\('--all'\)/.test(file('tools/mirror.mjs')) && /mirror\.mjs --all/.test(setup));

/* Numbers the guide states in its own voice. Each is FREEZE_WITHIN_HOURS or the
   cron wearing different clothes, and hand-written in prose four times over. */
const H = cfg.FREEZE_WITHIN_HOURS;
ok('the skip message in the sample log is the one record.js builds',
  setup.includes('kickoff more than ' + H + 'h away') &&
  file('assets/js/record.js').includes("'kickoff more than ' + FREEZE_WITHIN_HOURS + 'h away'"),
  H);
ok('"only records matches starting within N hours" is the real lead time',
  setup.includes('within ' + H + ' hours'), H);
ok('the sample log\'s model revision is the current one',
  setup.includes('model rev ' + cfg.MODEL_REV), cfg.MODEL_REV);
ok('the sample log\'s competition count is how many we carry',
  setup.includes(cfg.LEAGUES.length + ' competitions'), cfg.LEAGUES.length);
if (cronM) {
  ok('"it runs itself every three hours" matches the cron too',
    /runs itself every three hours/.test(setup) === (+cronM[2] === 3), +cronM[2]);
}
ok('SETUP.md quotes no assertion or suite count, which would go stale every commit',
  !/\d+\s+assertions|sixteen files|across \w+ files/.test(setup),
  /\d+\s+assertions|sixteen files|across \w+ files/.exec(setup));

/* Every file the guide tells the reader to open or run. Both forms count: named in
   backticks in the prose, and typed after `node` in a fenced command block. */
const named = [
  ...[...setup.matchAll(/`((?:tools|tests|assets|\.github)\/[\w./-]+|firestore\.rules|\.nojekyll)`/g)].map(mm => mm[1]),
  ...[...setup.matchAll(/\bnode ([\w./-]+\.mjs)/g)].map(mm => mm[1]),
];
const namedMissing = [...new Set(named)].filter(p => !fs.existsSync(new URL(p, root)));
console.log('    files named in the guide: ' + [...new Set(named)].join(', '));
ok('every file SETUP.md names exists', namedMissing.length === 0, namedMissing);

/* ---------- the honesty commitments ---------- */
console.log('');
console.log('=== the claims that must never quietly disappear ===');
const must = [
  /* This one used to read "no accuracy record, because none has been measured".
     That was true until the archive started writing; leaving it in place would
     have had the drift guard enforcing a claim the site had outgrown. The
     commitment behind it has not moved — no figure before it is measured — so it
     is restated rather than dropped. */
  ['states there is no measured accuracy figure yet', /no measured\s*accuracy figure yet, because not enough matches have been scored/],
  ['admits the parameters are not backtested',   /not\s*values fitted against a backtest/],
  ['distinguishes correctness from accuracy',    /correctness is not accuracy/],
  ['calls the quality numbers a judgement',      /an informed judgement, not a measurement/],
  ['says the market is never an input',          /never an input to the model/],
  ['says it is not betting advice',              /not betting advice/i],
  ['explains that 70% is meant to lose',         /lose roughly three times in every ten/],
  ['keeps the age restriction',                  /restricted to adults|18\+/],
  ['offers help resources',                      /BeGambleAware/],
  ['says the current table is roster-only',      /never for strength/],

  /* The archive's four promises. Each is a property a reader cannot verify for
     themselves without being told it holds, which is exactly why removing one
     quietly would be the cheapest way to make this site dishonest. */
  ['promises predictions are written before kickoff', /written down before the match|frozen before kickoff|before the match, kept unchanged/i],
  ['promises records are never edited afterwards',    /[Nn]ever edited afterwards|written once/],
  ['says the verdict is derived rather than stored',  /derived, not stored/],
  ['refuses to store a verdict',                      /does not hold\s*<code>correct: true<\/code>/],
  ['points at the commit history as the audit trail', /history itself is\s*the audit trail/],
  ['says each record is stamped with a model revision', /model revision/],
  ['explains why no rate is published yet',           /percentage<\/em> does not appear until/],
  ['links to the record page',                        /href="record\.html"/],
];
must.forEach(([label, re2]) => ok(label, re2.test(html)));
ok('the footer disclaimer is on both pages',
  index.includes('probabilities, not tips') && html.includes('probabilities, not tips'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
