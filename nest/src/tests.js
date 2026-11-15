// One small real call per source, used by the "Test" buttons in the Connections panel.
import { loadGames, env, storeCountry } from './config.js';
import { isoDay } from './util.js';
import { googleConfigured, googleToken, admobReady, saMode, saToken, saEmail, gfetch } from './google.js';
import { ga4Daily } from './connectors/ga4.js';
import { admobDaily } from './connectors/admob.js';
import { ascConfigured, ascDownloads } from './connectors/asc.js';
import { rcConfigured, rcRevenue } from './connectors/revenuecat.js';
import { crashCounts } from './connectors/crashlytics.js';
import { storeRating } from './connectors/itunes.js';
import { NETS } from './connectors/ads.js';
import { steamSalesDay, steamPlayers } from './connectors/steam.js';
import { aiConfigured, aiModel } from './ai.js';

const need = (ok, msg) => { if (!ok) throw new Error(msg); };
/** Tests that belong to each integration in the simplified API. */
export const SERVICE_TESTS = { google: ['google', 'ga4', 'admob', 'crashlytics'], apple: ['asc'], revenuecat: ['revenuecat'], ratings: ['ratings'], searchads: ['ads_asa'], snapchat: ['ads_snap'], tiktok: ['ads_tiktok'], meta: ['ads_meta'], googleads: ['ads_gads'], ai: ['ai'], steam: ['steam'] };
/** Run the tests of one service; "not set up yet" steps are reported as skipped, not failed. */
export async function testService(service) {
  const out = [];
  for (const s of SERVICE_TESTS[service] || []) {
    try { out.push({ test: s, ok: true, message: await testSource(s) }); }
    catch (e) { const m = String(e.message || e).slice(0, 400); out.push({ test: s, ok: /Discover my games|AdMob needs/.test(m) ? null : false, message: m }); }
    if (out[out.length - 1].ok === false && s === 'google') break; // nothing else works without the sign-in
  }
  return out;
}
export async function testSource(src) {
  const { games } = loadGames(), d = isoDay(-2);
  const pick = f => games.find(g => g[f]);
  switch (src) {
    case 'google':
      need(googleConfigured(), 'Choose the service account or paste the Client ID and secret and press "Sign in with Google".');
      if (saMode()) {
        await saToken();
        const [ga, fb] = await Promise.all([
          gfetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200').catch(e => ({ err: e.message })),
          gfetch('https://firebase.googleapis.com/v1beta1/projects?pageSize=100').catch(e => ({ err: e.message }))]);
        if (ga.err) throw new Error('Analytics: ' + ga.err);
        const props = (ga.accountSummaries || []).reduce((n, a) => n + (a.propertySummaries || []).length, 0);
        const projects = fb.err ? null : (fb.results || []).length;
        if (!props) throw new Error(`The service account works but sees no Google Analytics properties. In analytics.google.com → Admin → Account access management add ${saEmail()} as Viewer.`);
        return `Service account works: ${props} Analytics properties${projects != null ? `, ${projects} Firebase projects` : ''}.`;
      }
      await googleToken(); return 'Google sign-in works.';
    case 'ga4': {
      need(googleConfigured(), 'Connect your Google account first.');
      const g = pick('ga4PropertyId'); need(g, 'Press "Discover my games" to fill in GA4 property IDs.');
      const r = await ga4Daily(g, d, d); return `${g.name}: ${r[0]?.dau ?? 0} daily users on ${d}.`;
    }
    case 'admob': {
      need(admobReady(), 'AdMob needs "Sign in with Google" — the AdMob API does not accept service accounts.');
      need(env('ADMOB_PUBLISHER_ID'), 'Press "Discover my games" to find your AdMob account.');
      const r = await admobDaily(d, d); const ids = new Set(games.map(g => g.admobAppId).filter(Boolean));
      const mine = r.filter(x => ids.has(x.app));
      return `AdMob works: ${r.length} app(s) with data on ${d}, ${mine.length} matched to your Game IDs, ${'$' + mine.reduce((a, x) => a + x.earn, 0).toFixed(2)} earned.`;
    }
    case 'crashlytics': {
      need(googleConfigured() && env('BIGQUERY_PROJECT'), 'Connect Google, then press "Discover my games" (Crashlytics needs the BigQuery link in Firebase).');
      const g = pick('crashlyticsTable'); need(g, 'Press "Discover my games" to fill in Crashlytics tables (needs the BigQuery link in Firebase).');
      const r = await crashCounts(g, d, d); return `${g.name}: ${r?.[0]?.crashes ?? 0} fatal crashes on ${d}.`;
    }
    case 'asc': {
      need(ascConfigured(), 'Add the .p8 key file, Issuer ID and Vendor number.');
      const u = await ascDownloads(d);
      if (!u) return `App Store Connect works. Apple has not published the ${d} report yet.`;
      const ids = new Set(games.map(g => g.ascAppleId).filter(Boolean));
      return `App Store Connect works: ${Object.keys(u).length} app(s) in the ${d} report, ${Object.keys(u).filter(k => ids.has(k)).length} matched to your Game IDs.`;
    }
    case 'revenuecat': {
      need(rcConfigured(), 'Paste a RevenueCat secret API key (V2).');
      const g = pick('revenuecatProjectId'); need(g, 'Press "Discover my games" to fill in RevenueCat projects.');
      const v = await rcRevenue(g.revenuecatProjectId, d); return `${g.name}: $${v.toFixed(2)} revenue on ${d}.`;
    }
    case 'ratings': {
      const g = pick('appStoreId') || pick('ascAppleId'); need(g, 'Press "Discover my games" to fill in Apple IDs.');
      const r = await storeRating(g.appStoreId || g.ascAppleId, storeCountry());
      return r ? `${g.name}: ★ ${r.rating} from ${r.count} ratings.` : `${g.name}: no ratings yet in this store.`;
    }
    case 'ads_asa': case 'ads_snap': case 'ads_tiktok': case 'ads_meta': case 'ads_gads': {
      const N = NETS[src.slice(4)];
      need(N.ready(), src === 'ads_snap' ? 'Paste the Client ID and secret, press "Connect Snapchat", then add the Ad account ID.' : src === 'ads_gads' ? 'Google Ads needs Sign in with Google (Reports → Data), a developer token and the customer ID. Sign in with Google again after saving the token.' : 'Fill in every field, then Save and test.');
      const r = await N.report(isoDay(-7), isoDay(-1));
      const spend = r.reduce((a, x) => a + x.spend, 0), camps = new Set(r.map(x => x.cid)).size;
      return `${N.name} works: ${camps} campaign(s) with spend in the last 7 days, ${spend.toFixed(2)} spent, ${r.reduce((a, x) => a + x.inst, 0)} installs.`;
    }
    case 'steam': {
      need(env('STEAM_FINANCIAL_KEY'), 'Paste the Financial Web API key from Steamworks → Users & Permissions → Manage Groups → your Financial API group.');
      const day = isoDay(-2), by = await steamSalesDay(day), apps = Object.keys(by);
      const sg = loadGames().games.filter(g => g.steamAppId);
      if (sg[0]) await steamPlayers(sg[0].steamAppId);
      return `Steam works: ${apps.length} app(s) with sales on ${day}${sg.length ? `, ${sg.length} game(s) with a Steam App ID` : '. Add Steam App IDs in Reports → Data → Game IDs'}.`;
    }
    case 'ai': {
      need(aiConfigured(), 'Paste your Claude API key (console.anthropic.com → API keys).');
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(9000), headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: aiModel(), max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Claude ${r.status}: ${j?.error?.message || 'request failed'}`);
      return `Claude works (${aiModel()}).`;
    }
    default: throw new Error('Unknown source');
  }
}
