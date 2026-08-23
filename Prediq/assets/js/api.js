/* =============================================================================
   api.js — all network access and caching. Nothing here does any maths.

   Everything goes through localStorage. Data that can never change again (a
   finished month, a completed season) is kept for weeks; anything still moving
   gets minutes. A repeat visit therefore makes almost no network requests.
   ========================================================================== */

import { API, CACHE, DOMESTIC, FIXTURE_DAYS, LEAGUES, MODEL, currentSeason } from './config.js';

/* --- Small helpers ------------------------------------------------------- */

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

/* ESPN returns goals as a string on the scoreboard ("2") but as an object
   ({value: 2}) on other endpoints. Always read through this. */
const goals = c => {
  const n = Number(c?.score?.value ?? c?.score);
  return Number.isFinite(n) ? n : null;
};

const stat = (entry, name) => {
  const s = (entry.stats || []).find(x => x.name === name || x.abbreviation === name);
  if (!s) return null;
  const n = Number(s.value ?? s.displayValue);
  return Number.isFinite(n) ? n : null;
};

/* --- Cache -------------------------------------------------------------- */

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(CACHE.prefix + key);
    if (!raw) return null;
    const { t, d } = JSON.parse(raw);
    if (!t || Date.now() - t > ttl) return null;
    return d;
  } catch {
    return null;   /* private mode, disabled storage, corrupt entry */
  }
}

function cacheSet(key, data) {
  const write = () =>
    localStorage.setItem(CACHE.prefix + key, JSON.stringify({ t: Date.now(), d: data }));
  try {
    write();
  } catch {
    prune();
    try { write(); } catch { /* give up quietly — cache is an optimisation */ }
  }
}

/* Drop the oldest half of our entries when storage fills up. */
function prune() {
  try {
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(CACHE.prefix)) continue;
      let t = 0;
      try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch {}
      mine.push([k, t]);
    }
    mine.sort((a, b) => a[1] - b[1]);
    mine.slice(0, Math.ceil(mine.length / 2)).forEach(([k]) => localStorage.removeItem(k));
  } catch {}
}

export function clearCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE.prefix)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    return keys.length;
  } catch { return 0; }
}

/* --- Fetching ----------------------------------------------------------- */

async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Read through the cache. If the network fails but we hold an expired copy,
   serve that rather than showing the user nothing. */
async function cached(key, ttl, load) {
  const hit = cacheGet(key, ttl);
  if (hit !== null) return hit;
  try {
    const fresh = await load();
    cacheSet(key, fresh);
    return fresh;
  } catch (err) {
    const stale = cacheGet(key, Infinity);
    if (stale !== null) return stale;
    throw err;
  }
}

/* Run tasks with a ceiling on how many are in flight at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

/* --- Odds --------------------------------------------------------------- */

/* American moneyline to implied probability.
   +400 → 100/500 = 0.20      -150 → 150/250 = 0.60
   Exported so it can be unit-tested. */
export function americanToProb(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

/* The three implied probabilities sum to more than 1 — that excess is the
   bookmaker's margin. Divide it out so we compare like with like, and keep the
   original sum since it tells you how much margin was taken. */
export function parseOdds(comp) {
  const o = comp?.odds?.[0];
  if (!o) return null;
  const h = americanToProb(o.homeTeamOdds?.moneyLine);
  const d = americanToProb(o.drawOdds?.moneyLine);
  const a = americanToProb(o.awayTeamOdds?.moneyLine);
  if (h === null || d === null || a === null) return null;
  const sum = h + d + a;
  if (!(sum > 0)) return null;
  const ou = Number(o.overUnder);
  return {
    home: h / sum,
    draw: d / sum,
    away: a / sum,
    overround: sum,
    overUnder: Number.isFinite(ou) ? ou : null,
    provider: o.provider?.displayName ?? o.provider?.name ?? null,
  };
}

/* --- Parsers ------------------------------------------------------------ */

function side(competitors, which) {
  const c = (competitors || []).find(x => x.homeAway === which) || {};
  return {
    id: String(c.team?.id ?? ''),
    name: c.team?.displayName ?? '',
    short: c.team?.shortDisplayName ?? c.team?.abbreviation ?? '',
    logo: c.team?.logo ?? null,
    form: c.form ?? null,
    g: goals(c),
  };
}

/* Upcoming fixtures only. A match already kicked off is no longer a prediction. */
export function parseFixtures(json, leagueSlug) {
  return (json.events || []).flatMap(e => {
    const comp = e.competitions?.[0];
    if (!comp) return [];
    const state = e.status?.type?.state ?? comp.status?.type?.state;
    if (state !== 'pre') return [];
    const home = side(comp.competitors, 'home');
    const away = side(comp.competitors, 'away');
    if (!home.id || !away.id) return [];
    return [{
      id: String(e.id),
      leagueSlug,
      date: e.date,
      venue: comp.venue?.fullName ?? null,
      home: { id: home.id, name: home.name, short: home.short, form: home.form, logo: home.logo },
      away: { id: away.id, name: away.name, short: away.short, form: away.form, logo: away.logo },
      odds: parseOdds(comp),
    }];
  });
}

/* Completed matches with both goal counts present.

   `id` is the ESPN event id. The model never looks at it — it works in teams and
   goals — but the scheduled writer matches a final score to a stored prediction
   by it. Matching on date and team ids instead would look equivalent and quietly
   break on a postponed match replayed months later, which is exactly the case
   where attaching the wrong score would be hardest to notice. */
export function parseResults(json) {
  return (json.events || []).flatMap(e => {
    const comp = e.competitions?.[0];
    if (!comp) return [];
    const state = e.status?.type?.state ?? comp.status?.type?.state;
    if (state !== 'post') return [];
    const home = side(comp.competitors, 'home');
    const away = side(comp.competitors, 'away');
    if (!home.id || !away.id || home.g === null || away.g === null) return [];
    return [{
      id: String(e.id),
      date: e.date,
      home: { id: home.id, name: home.name, g: home.g, logo: home.logo },
      away: { id: away.id, name: away.name, g: away.g, logo: away.logo },
    }];
  });
}

/* ESPN calls goals "points" in soccer: pointsFor / pointsAgainst.

   The crest comes from `logos[]` here but from a flat `logo` on a scoreboard
   competitor — the same fact under two shapes, because these are two different
   endpoints. Both are read, and neither is required: a missing crest costs the
   form strip an icon and nothing else. */
export function parseStandings(json) {
  const groups = json.children?.length
    ? json.children.map(c => c.standings)
    : [json.standings];

  const rows = [];
  for (const g of groups) {
    for (const e of g?.entries || []) {
      const id = String(e.team?.id ?? '');
      if (!id) continue;
      rows.push({
        id,
        name: e.team?.displayName ?? '',
        short: e.team?.shortDisplayName ?? e.team?.abbreviation ?? '',
        logo: e.team?.logos?.[0]?.href ?? e.team?.logo ?? null,
        gp: stat(e, 'gamesPlayed') ?? 0,
        gf: stat(e, 'pointsFor') ?? 0,
        ga: stat(e, 'pointsAgainst') ?? 0,
        rank: stat(e, 'rank'),
      });
    }
  }
  return rows;
}

/* --- Endpoint wrappers -------------------------------------------------- */

export function fetchFixtures(slug, days = FIXTURE_DAYS) {
  const from = new Date();
  const to = new Date(Date.now() + days * 864e5);
  const url = `${API.scoreboard}${slug}/scoreboard?dates=${ymd(from)}-${ymd(to)}`;
  const key = `fix:${slug}:${ymd(from)}:${days}`;
  return cached(key, CACHE.ttl.fixtures, async () => parseFixtures(await getJSON(url), slug));
}

export function fetchStandings(slug, season, isPrevious) {
  const url = `${API.standings}${slug}/standings?season=${season}`;
  const ttl = isPrevious ? CACHE.ttl.standingsPrev : CACHE.ttl.standingsNow;
  return cached(`std:${slug}:${season}`, ttl, async () => parseStandings(await getJSON(url)));
}

/* One calendar month of results. Wide ranges are capped at 100 events by ESPN,
   so we always request month by month — that comes back complete. */
export function fetchMonth(slug, year, month) {
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 0));   /* day 0 = last of prev month */
  const url = `${API.scoreboard}${slug}/scoreboard?dates=${ymd(from)}-${ymd(to)}`;
  const now = new Date();
  const isNow = year === now.getFullYear() && month === now.getMonth();
  const ttl = isNow ? CACHE.ttl.monthCurrent : CACHE.ttl.monthPast;
  return cached(`mon:${slug}:${year}-${month}`, ttl, async () => parseResults(await getJSON(url)));
}

/* Months of a season that have actually started: August through May.
   Month indexes are 0-based, so August is 7 and May is 4. */
export function seasonMonths(season, now = new Date()) {
  const out = [];
  let y = season, m = 7;                     /* 7 = August */
  for (let guard = 0; guard < 12; guard++) {
    if (y > season + 1 || (y === season + 1 && m > 4)) break;   /* past May */
    if (new Date(y, m, 1) > now) break;                          /* not started */
    out.push([y, m]);
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

/* --- Orchestration ------------------------------------------------------ */

/* Prediq loads in two phases, and the split is deliberate.

   PHASE 1 is the fixture list: one request per competition and nothing else.
   It is the smallest thing that makes a page worth looking at — every match,
   its competition, its kickoff time — and it costs one round trip per
   competition no matter how much history the model later reads. Adding a
   fifteenth league therefore costs the first paint one request, not seven.

   PHASE 2 is everything the model needs: two league tables plus a few months
   of results for each domestic division. It is the expensive half, and it is
   the half nobody should have to wait through before seeing what is on.

   The order matters for a reason beyond speed. The model is fitted ONCE, at the
   end of phase 2, so no figure is ever shown and then quietly revised — a card
   goes from "working" to final, never from one probability to another. That is
   worth more than an earlier first prediction would be, because homeAdvantage()
   pools every league's matches together: fitting on half the divisions and then
   refitting on all of them genuinely would move the earlier numbers, by a
   fraction of a point but visibly, and a prediction that changes while you are
   reading it is worse than one that took another second to arrive.

   Neither function throws. Whatever failed lands in `errors` so the page can
   say what is missing instead of silently resting on less. */

async function runJobs(jobs, errors, onProgress) {
  let done = 0;
  const report = () => onProgress?.(done, jobs.length);
  report();

  return mapLimit(jobs, CACHE.concurrency, async job => {
    try {
      let data;
      if (job.kind === 'fixtures')            data = await fetchFixtures(job.slug);
      else if (job.kind === 'standingsNow')   data = await fetchStandings(job.slug, job.season, false);
      else if (job.kind === 'standingsPrev')  data = await fetchStandings(job.slug, job.season, true);
      else                                    data = await fetchMonth(job.slug, job.y, job.m);
      return { job, data };
    } catch (err) {
      errors.push({ league: job.slug, what: job.kind, message: err.message });
      return { job, data: null };
    } finally {
      done++; report();
    }
  });
}

const emptyLeagues = () => {
  const out = {};
  for (const lg of LEAGUES) out[lg.slug] = { standingsNow: [], standingsPrev: [], results: [] };
  return out;
};

/* The months actually requested: the season so far, then only its recent tail.
   seasonMonths() stays honest about the whole season; the cap is applied here,
   where the cost it controls is. */
export function resultMonths(season, now = new Date()) {
  const all = seasonMonths(season, now);
  return MODEL.RESULT_MONTHS > 0 ? all.slice(-MODEL.RESULT_MONTHS) : all;
}

/* Phase 1. One request per competition, including the European ones, which sit
   idle for a few months of the year and correctly return nothing. */
export async function loadFixtures({ onProgress } = {}) {
  const errors = [];
  const out = await runJobs(
    LEAGUES.map(lg => ({ kind: 'fixtures', slug: lg.slug })), errors, onProgress);

  const fixtures = [];
  for (const { data } of out) if (data) fixtures.push(...data);
  fixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  return { fixtures, errors, fetchedAt: Date.now() };
}

/* Phase 2. Cup competitions are absent by design: a Champions League tie is
   predicted from the two clubs' domestic ratings, so the competition itself has
   no table and no fit of its own.

   Cup matches inside a domestic feed are a real hazard, though — a league
   scoreboard includes fixtures against lower-division opposition (Arsenal v
   Coventry City turned up in the Premier League feed). Those are filtered out
   downstream by requiring both teams to appear in that league's standings. */
export async function loadModel({ onProgress } = {}) {
  const season = currentSeason();
  const prev = season - 1;
  const months = resultMonths(season);
  const errors = [];

  const jobs = [];
  for (const lg of DOMESTIC) {
    jobs.push({ kind: 'standingsNow',  slug: lg.slug, season });
    jobs.push({ kind: 'standingsPrev', slug: lg.slug, season: prev });
    for (const [y, m] of months) jobs.push({ kind: 'month', slug: lg.slug, y, m });
  }

  const out = await runJobs(jobs, errors, onProgress);

  const byLeague = emptyLeagues();
  for (const { job, data } of out) {
    if (!data) continue;
    const bucket = byLeague[job.slug];
    if (job.kind === 'standingsNow')       bucket.standingsNow = data;
    else if (job.kind === 'standingsPrev') bucket.standingsPrev = data;
    else                                   bucket.results.push(...data);
  }

  return { season, prevSeason: prev, months, byLeague, errors, fetchedAt: Date.now() };
}

/* How many requests phase 2 will make. Exported so a combined progress bar can
   be sized before phase 2 has started. */
export function estimateModelJobs(now = new Date()) {
  return DOMESTIC.length * (2 + resultMonths(currentSeason(now), now).length);
}

/* Both phases, one await. The ratings page uses this with `withFixtures: false`
   because it has nothing to do with fixtures, and on a cold visit that is
   fourteen requests it would never have looked at. */
export async function loadAll({ onProgress, withFixtures = true } = {}) {
  if (!withFixtures) {
    const model = await loadModel({ onProgress });
    return { ...model, fixtures: [] };
  }

  /* One bar across both phases, so it advances 0 to 100 once instead of
     restarting halfway. Phase 2's size is known in advance, which is the only
     reason a single total is possible before phase 2 begins. */
  const later = estimateModelJobs();
  const first = LEAGUES.length;

  const fx = await loadFixtures({
    onProgress: (done, total) => onProgress?.(done, total + later),
  });
  const model = await loadModel({
    onProgress: (done, total) => onProgress?.(first + done, first + total),
  });

  return {
    ...model,
    fixtures: fx.fixtures,
    errors: [...fx.errors, ...model.errors],
  };
}

