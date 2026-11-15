// Sync as a queue of small jobs. Netlify functions have short time limits (about 10 s for an API call,
// 30 s for a scheduled run), so each run does as many jobs as fit and the next run continues.
import { loadGames, env, storeCountry } from './config.js';
import { isoDay, addDays, dateRange, log } from './util.js';
import { googleConfigured, admobReady } from './google.js';
import { ga4Daily, ga4Retention, ga4Funnel } from './connectors/ga4.js';
import { admobDaily, admobSources } from './connectors/admob.js';
import { ascConfigured, ascDownloads } from './connectors/asc.js';
import { rcConfigured, rcRevenue } from './connectors/revenuecat.js';
import { crashCounts } from './connectors/crashlytics.js';
import { storeRatings } from './connectors/itunes.js';
import { upsertRows, getKV, setKV } from './store.js';
import { db } from './db.js';
import { loadSettings } from './settings.js';
import { NETS, chunkDates } from './connectors/ads.js';
import { saveAdRows } from './adstore.js';
import { storeFunnel, reviews } from './connectors/ascstore.js';
import { steamPlayers, steamReviews, steamSalesReady, steamSalesDay } from './connectors/steam.js';

export const CONNECTORS = ['firebase_ga4', 'admob', 'app_store_connect', 'revenuecat', 'crashlytics', 'ratings', 'ads_asa', 'ads_snap', 'ads_tiktok', 'ads_meta', 'ads_gads', 'store_funnel', 'reviews', 'steam_store', 'steam_sales'];
const Q = 'kv/syncQueue';
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** Build the job list for the last `days` days (ending yesterday). */
export function planJobs(games, { days = 3 } = {}) {
  const end = isoDay(-1), start = isoDay(-days), jobs = [], off = {};
  const g = googleConfigured();
  const gaGames = games.filter(x => x.ga4PropertyId);
  if (g && gaGames.length) {
    const cohort = new Set();
    for (const N of [1, 7, 30]) for (const d of dateRange(addDays(start, -N), addDays(end, -N))) cohort.add(d);
    const dates = [...cohort].sort();
    for (const x of gaGames) {
      jobs.push({ c: 'firebase_ga4', t: 'ga4day', g: x.id, start, end });
      for (const part of chunk(dates, 12)) jobs.push({ c: 'firebase_ga4', t: 'ga4ret', g: x.id, dates: part, end });
      if (x.ga4LevelDimension) jobs.push({ c: 'firebase_ga4', t: 'ga4fun', g: x.id, start: isoDay(-30), end });
    }
  } else off.firebase_ga4 = g ? 'Add GA4 property IDs (Discover my games)' : 'Connect Google';
  const adGames = games.filter(x => x.admobAppId);
  if (admobReady() && env('ADMOB_PUBLISHER_ID') && adGames.length) {
    for (const part of chunk(dateRange(start, end), 31)) jobs.push({ c: 'admob', t: 'admob', start: part[0], end: part[part.length - 1] });
    jobs.push({ c: 'admob', t: 'admobsrc', start: isoDay(-30), end });
  } else off.admob = !admobReady() ? 'AdMob needs Sign in with Google' : !env('ADMOB_PUBLISHER_ID') ? 'Run Discover to find your AdMob account' : 'Add AdMob app IDs (Discover my games)';
  if (ascConfigured() && games.some(x => x.ascAppleId)) for (const d of dateRange(start, end)) jobs.push({ c: 'app_store_connect', t: 'asc', d });
  else off.app_store_connect = ascConfigured() ? 'Add Apple IDs (Discover my games)' : 'Connect App Store Connect';
  const rcGames = games.filter(x => x.revenuecatProjectId);
  if (rcConfigured() && rcGames.length) { for (const x of rcGames) for (const part of chunk(dateRange(start, end), 7)) jobs.push({ c: 'revenuecat', t: 'rc', g: x.id, dates: part }); }
  else off.revenuecat = rcConfigured() ? 'Add RevenueCat project IDs (Discover my games)' : 'Connect RevenueCat';
  const crGames = games.filter(x => x.crashlyticsTable);
  if (g && env('BIGQUERY_PROJECT') && crGames.length) for (const x of crGames) jobs.push({ c: 'crashlytics', t: 'crash', g: x.id, start, end });
  else off.crashlytics = 'Optional: link Crashlytics to BigQuery, then run Discover';
  if (games.some(x => x.appStoreId || x.ascAppleId)) jobs.push({ c: 'ratings', t: 'ratings', d: end });
  else off.ratings = 'Add Apple IDs';
  // ad networks restate recent days, so always refresh at least the last 7
  const adStart = days < 7 ? isoDay(-7) : start;
  for (const [net, N] of Object.entries(NETS)) {
    if (N.ready()) for (const [a, b] of chunkDates(adStart, end, Math.min(N.maxDays, 31))) jobs.push({ c: 'ads_' + net, t: 'ads', net, start: a, end: b });
    else off['ads_' + net] = 'Optional: connect in Marketing → Ad accounts';
  }
  const appleGames = games.filter(x => x.ascAppleId);
  if (ascConfigured() && appleGames.length) {
    for (const x of appleGames) { for (const d of dateRange(isoDay(-Math.min(3, days) - 1), end)) jobs.push({ c: 'store_funnel', t: 'storefun', g: x.id, d }); jobs.push({ c: 'reviews', t: 'reviews', g: x.id }); }
  } else { off.store_funnel = off.reviews = ascConfigured() ? 'Add Apple IDs (Discover my games)' : 'Connect App Store Connect'; }
  const steamGames = games.filter(x => x.steamAppId);
  if (steamGames.length) {
    jobs.push({ c: 'steam_store', t: 'steamstore', d: end });
    if (steamSalesReady()) for (const d of dateRange(start, end)) jobs.push({ c: 'steam_sales', t: 'steamsales', d });
    else off.steam_sales = 'Optional: add the Steam Financial API key in Steam → Connect';
  } else { off.steam_store = off.steam_sales = 'Add Steam App IDs (Reports → Data → Game IDs)'; }
  return { jobs, off, window: { start, end } };
}

/** Run one job and store its rows. Returns the number of rows written. */
export async function runJob(j, games) {
  const G = games.find(x => x.id === j.g);
  if (j.g && !G) return 0; // game removed since planning
  const rows = [];
  const put = (g, d, f) => rows.push({ g, d, ...f });
  switch (j.t) {
    case 'ga4day':
      for (const r of await ga4Daily(G, j.start, j.end)) put(G.id, r.d, { dau: r.dau, newUsers: r.newUsers, sessions: r.sessions, ses: r.ses, len: r.len });
      break;
    case 'ga4ret': {
      const ret = await ga4Retention(G, j.dates);
      for (const [c, v] of Object.entries(ret)) {
        const f = {};
        for (const N of [1, 7, 30]) if (v[N] != null && addDays(c, N) <= j.end) f['d' + N] = v[N];
        if (Object.keys(f).length) put(G.id, c, f);
      }
      break;
    }
    case 'ga4fun': { const fun = await ga4Funnel(G, j.start, j.end); if (fun) await setKV('funnel:' + G.id, fun); return fun ? 1 : 0; }
    case 'admob': {
      const byApp = Object.fromEntries(games.filter(x => x.admobAppId).map(x => [x.admobAppId, x.id]));
      for (const r of await admobDaily(j.start, j.end)) { const gid = byApp[r.app]; if (gid && r.d) put(gid, r.d, { ad: +r.earn.toFixed(4), imp: r.imp }); }
      break;
    }
    case 'admobsrc': {
      const src = (await admobSources(j.start, j.end)).filter(r => r.source).map(r => ({ n: r.source, v: +r.earn.toFixed(2), imp: r.imp }));
      await setKV('mediation', src.sort((a, b) => b.v - a.v)); return src.length;
    }
    case 'asc': {
      const units = await ascDownloads(j.d);
      if (!units) return 0; // Apple has not published this day yet
      for (const x of games.filter(x => x.ascAppleId)) put(x.id, j.d, { inst: units[x.ascAppleId] || 0 });
      break;
    }
    case 'rc':
      for (const d of j.dates) put(G.id, d, { iap: +(await rcRevenue(G.revenuecatProjectId, d)).toFixed(2) });
      break;
    case 'crash':
      for (const r of (await crashCounts(G, j.start, j.end)) || []) put(G.id, r.d, { crashes: r.crashes });
      break;
    case 'ratings': {
      const list = games.filter(x => x.appStoreId || x.ascAppleId);
      const R = await storeRatings(list.map(x => x.appStoreId || x.ascAppleId), storeCountry());
      for (const x of list) { const r = R[String(x.appStoreId || x.ascAppleId)]; if (r) put(x.id, j.d, { rating: r.rating, ratingCount: r.count }); }
      break;
    }
    case 'ads': return saveAdRows(await NETS[j.net].report(j.start, j.end), games);
    case 'storefun': {
      const byDay = await storeFunnel(G.ascAppleId, j.d);
      const terr = (await getKV('storeTerr:' + G.id)) || {};
      for (const [d, v] of Object.entries(byDay)) { put(G.id, d, { sImp: v.imp, sView: v.view }); terr[d] = v.terr; }
      const keep = Object.keys(terr).sort().slice(-35); await setKV('storeTerr:' + G.id, Object.fromEntries(keep.map(k => [k, terr[k]])));
      break;
    }
    case 'reviews': { const list = await reviews(G.ascAppleId, 100); await setKV('reviews:' + G.id, list); return list.length; }
    case 'steamstore': {
      for (const x of games.filter(g => g.steamAppId)) {
        const [ccu, rv] = await Promise.all([steamPlayers(x.steamAppId).catch(() => null), steamReviews(x.steamAppId).catch(() => null)]);
        put(x.id, j.d, { stCcu: ccu, stPos: rv?.pos, stNeg: rv?.neg });
      }
      break;
    }
    case 'steamsales': {
      const by = await steamSalesDay(j.d);
      for (const x of games.filter(g => g.steamAppId)) { const s2 = by[String(x.steamAppId)] || { units: 0, net: 0, gross: 0, ret: 0 }; put(x.id, j.d, { stUnits: s2.units, stNet: Math.round(s2.net * 100) / 100, stGross: Math.round(s2.gross * 100) / 100, stRet: s2.ret }); }
      break;
    }
    default: throw new Error('Unknown job ' + j.t);
  }
  return upsertRows(rows);
}

/** Start a new sync unless one is already queued. */
export async function startSync({ days = 3, by = 'schedule' } = {}) {
  await loadSettings();
  const cur = await db().get(Q);
  if (cur && cur.jobs?.length) return cur;
  const { games } = loadGames();
  const { jobs, off, window } = planJobs(games, { days });
  const connectors = {};
  for (const c of CONNECTORS) connectors[c] = off[c] ? { state: 'off', note: off[c] } : { state: 'ok', rows: 0, ms: 0 };
  const q = { id: Date.now().toString(36), by, days, window, total: jobs.length, jobs, status: { startedAt: new Date().toISOString(), window, connectors }, lease: 0 };
  await db().set(Q, q);
  return q;
}

/**
 * Work through the queue until `deadline` (ms timestamp). Safe to call from several places at once:
 * a lease makes the second caller return immediately.
 */
export async function runQueue(deadline, me = Math.random().toString(36).slice(2)) {
  const leaseMs = Math.max(5000, deadline - Date.now() + 5000);
  const got = await db().tx(async t => {
    const q = await t.get(Q);
    if (!q || !q.jobs?.length) return null;
    if (q.lease > Date.now() && q.leaseBy !== me) return { busy: true, remaining: q.jobs.length, total: q.total };
    await t.set(Q, { ...q, lease: Date.now() + leaseMs, leaseBy: me });
    return q;
  });
  if (!got) return { remaining: 0, total: 0, done: true, status: await getKV('status') };
  if (got.busy) return got;
  await loadSettings();
  const { games } = loadGames();
  const q = got;
  while (q.jobs.length && Date.now() < deadline - 1500) {
    const j = q.jobs[0];
    j.tries = (j.tries || 0) + 1;
    const C = q.status.connectors[j.c] ||= { state: 'ok', rows: 0, ms: 0 };
    if (j.tries > 2) { q.jobs.shift(); Object.assign(C, { state: 'error', error: 'Timed out twice; it will run again next sync' }); continue; }
    await db().set(Q, { ...q, lease: Date.now() + leaseMs, leaseBy: me }); // remember the try before running
    const t0 = Date.now();
    try {
      const n = await runJob(j, games);
      if (C.state !== 'error') { C.state = 'ok'; C.rows = (C.rows || 0) + n; C.ms = (C.ms || 0) + Date.now() - t0; }
    } catch (e) {
      log(`✕ ${j.c}/${j.t}:`, e.message || e);
      Object.assign(C, { state: 'error', error: String(e.message || e).slice(0, 500) });
    }
    q.jobs.shift();
  }
  if (!q.jobs.length) {
    q.status.finishedAt = new Date().toISOString();
    await setKV('status', q.status);
    await db().del(Q);
    return { remaining: 0, total: q.total, done: true, status: q.status };
  }
  await db().set(Q, { ...q, lease: 0, leaseBy: '' });
  return { remaining: q.jobs.length, total: q.total, done: false, status: q.status };
}

export async function queueState() {
  const q = await db().get(Q);
  return q && q.jobs?.length ? { remaining: q.jobs.length, total: q.total, startedAt: q.status?.startedAt } : null;
}
