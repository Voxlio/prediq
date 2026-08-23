/* method.html makes ~25 numeric claims about the model. Documentation drifts
   from code silently, so every claim carries data-cfg="PATH" and this suite
   resolves that path in config.js and compares. If someone retunes the model
   and forgets the page, this fails. */

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
const localLinks = new Set();
for (const src of [html, index]) {
  for (const mm of src.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    if (!/^https?:/.test(mm[1])) localLinks.add(mm[1]);
  }
}
const missing = [...localLinks].filter(p => !fs.existsSync(new URL(p, root)));
console.log('    ' + [...localLinks].join(', '));
ok('every local link and asset exists', missing.length === 0, missing);
ok('index links to the method page', /href="method\.html"/.test(index));
ok('method links back to the fixtures', /href="index\.html"/.test(html));
ok('both pages load the same stylesheet',
  (html.match(/assets\/css\/style\.css/g) || []).length === 1 &&
  (index.match(/assets\/css\/style\.css/g) || []).length === 1);
ok('the method page loads no JavaScript at all', !/<script/.test(html));

const used = new Set();
for (const mm of html.matchAll(/class="([^"]+)"/g)) mm[1].split(/\s+/).forEach(c => used.add(c));
const orphans = [...used].filter(c => !new RegExp('\\.' + c.replace('.', '\\.') + '\\b').test(cssBare));
console.log('    ' + used.size + ' classes used on the method page');
ok('no class without styling', orphans.length === 0, orphans);

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
let rmEnd = rmAt, depth = 0;
for (let i = cssBare.indexOf('{', rmAt); i < cssBare.length && i >= 0; i++) {
  if (cssBare[i] === '{') depth++;
  else if (cssBare[i] === '}' && --depth === 0) { rmEnd = i; break; }
}
const rmBlock = cssBare.slice(rmAt, rmEnd + 1);
const outsideRm = cssBare.slice(0, rmAt) + cssBare.slice(rmEnd + 1);
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
