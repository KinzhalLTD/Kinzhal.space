// "Discover my games": list what each connected account contains and match it to the games in the HQ.
import { env } from './config.js';
import { googleConfigured, admobReady, saMode, gfetch } from './google.js';
import { ascConfigured, ascGet } from './connectors/asc.js';
import { rcConfigured, rcList } from './connectors/revenuecat.js';

// Run async work on a list with limited parallelism (keeps Discover inside the function time limit).
async function pool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}
const settle = async (fn) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; } };
const off = msg => ({ ok: false, off: true, error: msg });

async function gaStreams() {
  const props = []; let token = '';
  do {
    const j = await gfetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    for (const a of j.accountSummaries || []) for (const p of a.propertySummaries || []) props.push({ id: p.property.split('/')[1], name: p.displayName, account: a.displayName });
    token = j.nextPageToken || '';
  } while (token && props.length < 200);
  const out = [];
  const all = await pool(props.slice(0, 80), 8, p => gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams?pageSize=200`).catch(() => ({})));
  for (const [i, p] of props.slice(0, 80).entries()) {
    const streams = all[i].dataStreams || [];
    for (const s of streams) {
      const ios = s.iosAppStreamData, and = s.androidAppStreamData;
      if (!ios && !and) continue;
      out.push({ propertyId: p.id, propertyName: p.name, streamId: s.name.split('/').pop(), name: s.displayName, bundleId: ios ? ios.bundleId : and.packageName, platform: ios ? 'ios' : 'android', streamsInProperty: streams.length });
    }
  }
  return out;
}
async function admobApps() {
  const acc = await gfetch('https://admob.googleapis.com/v1/accounts');
  const pubs = (acc.account || []).map(a => a.publisherId).filter(Boolean);
  const apps = [];
  for (const pub of pubs) {
    let token = '';
    do {
      const j = await gfetch(`https://admob.googleapis.com/v1/accounts/${pub}/apps?pageSize=1000` + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      for (const a of j.apps || []) apps.push({ pub, appId: a.appId, platform: a.platform, name: a.linkedAppInfo?.displayName || a.manualAppInfo?.displayName || '', appStoreId: a.linkedAppInfo?.appStoreId || '' });
      token = j.nextPageToken || '';
    } while (token);
  }
  return { pubs, apps };
}
async function firebaseApps() {
  const j = await gfetch('https://firebase.googleapis.com/v1beta1/projects?pageSize=100');
  const out = [];
  const projects = (j.results || []).slice(0, 40);
  const per = await pool(projects, 6, async p => {
    const [a, tables] = await Promise.all([
      gfetch(`https://firebase.googleapis.com/v1beta1/projects/${p.projectId}/iosApps?pageSize=100`).catch(() => ({})),
      gfetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${p.projectId}/datasets/firebase_crashlytics/tables?maxResults=1000`)
        .then(t => (t.tables || []).map(x => x.tableReference.tableId).filter(id => !/_REALTIME$/i.test(id)))
        .catch(() => []) // no Crashlytics export in this project
    ]);
    return { a, tables };
  });
  projects.forEach((p, i) => {
    const { a, tables } = per[i];
    for (const app of a.apps || []) out.push({ projectId: p.projectId, projectName: p.displayName, bundleId: app.bundleId, name: app.displayName || '', tables });
    if (!(a.apps || []).length && tables.length) out.push({ projectId: p.projectId, projectName: p.displayName, bundleId: '', name: '', tables });
  });
  return out;
}
async function appleApps() {
  const j = await ascGet('/v1/apps?limit=200&fields[apps]=name,bundleId');
  return (j.data || []).map(a => ({ appleId: a.id, name: a.attributes?.name || '', bundleId: a.attributes?.bundleId || '' }));
}
async function rcApps() {
  const projects = await rcList('/projects');
  const out = [];
  const per = await pool(projects, 5, p => rcList(`/projects/${encodeURIComponent(p.id)}/apps`).catch(() => []));
  for (const [i, p] of projects.entries()) {
    const apps = per[i];
    for (const a of apps) out.push({ projectId: p.id, projectName: p.name, appId: a.id, name: a.name, type: a.type, bundleId: a.app_store?.bundle_id || a.mac_app_store?.bundle_id || '' });
    if (!apps.length) out.push({ projectId: p.id, projectName: p.name, appId: '', name: '', type: '', bundleId: '' });
  }
  return out;
}

// ---- matching ----
export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const tokens = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
export function nameScore(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 0.85;
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  const inter = [...A].filter(t => B.has(t)).length;
  return inter ? inter / new Set([...A, ...B]).size : 0;
}
const bundleScore = (bundle, g) => {
  const b = norm(bundle); if (!b) return 0;
  const n = norm(g.name), id = norm(g.id);
  return (n.length >= 4 && b.endsWith(n)) || (id.length >= 4 && b.endsWith(id)) ? 0.95 : (n.length >= 4 && b.includes(n)) ? 0.8 : 0;
};
const best = (list, scoreFn, min = 0.6) => { let top = null, s = 0; for (const it of list) { const v = scoreFn(it); if (v > s) { s = v; top = it; } } return s >= min ? { item: top, score: s } : null; };
const sameBundle = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function matchAll(games, found) {
  const apple = found.apple?.data || [], ga = (found.ga4?.data || []).filter(s => s.platform === 'ios'), fb = found.firebase?.data || [];
  const ad = found.admob?.data?.apps || [], rc = found.revenuecat?.data || [];
  const used = new Set();
  const proposals = games.map(g => {
    const v = {}, how = {};
    // 1) identify the App Store app -> Apple ID + bundle ID
    const ap = best(apple, a => Math.max(nameScore(a.name, g.name), bundleScore(a.bundleId, g)));
    let bundle = '';
    if (ap) { v.ascAppleId = v.appStoreId = ap.item.appleId; bundle = ap.item.bundleId; how.ascAppleId = 'name'; used.add('apple:' + ap.item.appleId); }
    if (!bundle) { const f = best([...ga, ...fb].filter(x => x.bundleId), x => Math.max(nameScore(x.name, g.name), bundleScore(x.bundleId, g))); if (f) bundle = f.item.bundleId; }
    // 2) everything else follows the bundle ID (exact), falling back to the name
    const s = ga.find(x => sameBundle(x.bundleId, bundle)) || best(ga, x => nameScore(x.name, g.name))?.item;
    if (s) { v.ga4PropertyId = s.propertyId; v.ga4StreamId = s.streamsInProperty > 1 ? s.streamId : ''; how.ga4PropertyId = sameBundle(s.bundleId, bundle) ? 'bundle' : 'name'; }
    const a = ad.find(x => v.ascAppleId && x.appStoreId === v.ascAppleId) || best(ad.filter(x => x.platform !== 'ANDROID'), x => nameScore(x.name, g.name))?.item;
    if (a) { v.admobAppId = a.appId; how.admobAppId = a.appStoreId && a.appStoreId === v.ascAppleId ? 'app-store-link' : 'name'; }
    const r = rc.find(x => sameBundle(x.bundleId, bundle)) || best(rc, x => Math.max(nameScore(x.name, g.name), nameScore(x.projectName, g.name)))?.item;
    if (r) { v.revenuecatProjectId = r.projectId; how.revenuecatProjectId = sameBundle(r.bundleId, bundle) ? 'bundle' : 'name'; }
    if (bundle) {
      const tid = bundle.replace(/[^A-Za-z0-9]/g, '_') + '_IOS';
      const p = fb.find(x => x.tables.some(t => t.toLowerCase() === tid.toLowerCase()));
      if (p) { v.crashlyticsTable = `${p.projectId}.firebase_crashlytics.${p.tables.find(t => t.toLowerCase() === tid.toLowerCase())}`; how.crashlyticsTable = 'bundle'; }
    }
    return { id: g.id, name: g.name, bundleId: bundle, values: v, how };
  });
  const newApps = apple.filter(a => !used.has('apple:' + a.appleId)).map(a => ({ appleId: a.appleId, name: a.name, bundleId: a.bundleId }));
  const settings = {};
  const pubs = found.admob?.data?.pubs || [];
  if (pubs.length && !env('ADMOB_PUBLISHER_ID')) settings.ADMOB_PUBLISHER_ID = pubs[0];
  const crashProject = proposals.map(p => p.values.crashlyticsTable).find(Boolean);
  if (crashProject && !env('BIGQUERY_PROJECT')) settings.BIGQUERY_PROJECT = crashProject.split('.')[0];
  return { proposals, newApps, settings };
}

/** games: [{id, name}] — the games in Kinzhal Nest (sent by the page). */
export async function discover(games = []) {
  const g = googleConfigured();
  const [ga4, admob, firebase, apple, revenuecat] = await Promise.all([
    g ? settle(gaStreams) : off('Connect your Google account'),
    admobReady() ? settle(admobApps) : off(saMode() ? 'AdMob needs Sign in with Google' : 'Connect your Google account'),
    g ? settle(firebaseApps) : off('Connect your Google account'),
    ascConfigured() ? settle(appleApps) : off('Add the App Store Connect key'),
    rcConfigured() ? settle(rcApps) : off('Connect RevenueCat or paste its key')
  ]);
  const found = { ga4, admob, firebase, apple, revenuecat };
  const summary = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.ok ? { ok: true, count: Array.isArray(v.data) ? v.data.length : (v.data?.apps?.length ?? 0) } : { ok: false, off: !!v.off, error: v.error }]));
  return { summary, ...matchAll(games.filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name || x.id) })), found) };
}
