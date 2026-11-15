// The Kinzhal Nest API (one Netlify function). Small and explicit:
//
//   GET    /api/config                         public: Firebase web config for the login page
//   GET    /api/me                             who am I (creates the owner / accepts an invite on first sign-in)
//   POST   /api/auth/revoke                    sign out on every device
//   GET    /api/live?days=150                  metrics for the dashboard            (viewer)
//   GET    /api/daily.csv                      same as CSV                          (viewer)
//   GET    /api/integrations                   status of Google, Apple, RevenueCat, ratings + game IDs
//   POST   /api/integrations/:service          save keys for one service, then test it      (owner)
//   POST   /api/integrations/:service/test     test one service                             (editor)
//   DELETE /api/integrations/:service          disconnect one service                       (owner)
//   POST   /api/oauth/:provider/start          get the Google / RevenueCat sign-in URL      (owner)
//   GET    /api/oauth/:provider/callback       return from Google / RevenueCat
//   POST   /api/discover                       find your apps in every connected account    (editor)
//   PUT    /api/games                          save game IDs                                (editor)
//   POST   /api/sync   GET /api/sync           run / check a sync                           (editor / viewer)
//   GET    /api/team …                         members, invites, 2-step rule                (owner)
import { db } from './db.js';
import { loadSettings, saveSettings, saveGames, settingsStatus, clearService, SERVICES, FIELDS, keyIdFromFileName } from './settings.js';
import { loadGames, env } from './config.js';
import { HttpError, verify, member, requireRole, revokeAll, can, ROLES, emailKey, ownerEmail } from './auth.js';
import { buildLive, toCsv } from './live.js';
import { testService } from './tests.js';
import { discover } from './discover.js';
import { startOAuth, finishOAuth, redirectUri } from './oauth.js';
import { startSync, runQueue, queueState } from './jobs.js';
import { getKV } from './store.js';
import { googleConfigured, saMode, saAvailable, saEmail, admobReady } from './google.js';
import { ascConfigured } from './connectors/asc.js';
import { rcConfigured } from './connectors/revenuecat.js';
import { NETS, parseAdCsv, snapClientReady } from './connectors/ads.js';
import { loadAdRows, saveAdRows, saveAdMap, AD_NETS } from './adstore.js';
import { aiConfigured, aiModel, askClaude, weeklyBrief } from './ai.js';
import { isoDay } from './util.js';

const SEC_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS } });
const redirect = loc => new Response(null, { status: 302, headers: { location: loc, ...SEC_HEADERS } });

async function body(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 64 * 1024) throw new HttpError(413, 'too_large', 'Request too large');
  const txt = await req.text();
  if (txt.length > 64 * 1024) throw new HttpError(413, 'too_large', 'Request too large');
  if (!txt) return {};
  if (!/application\/json/.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'json_only', 'Send JSON');
  try { return JSON.parse(txt); } catch { throw new HttpError(400, 'bad_json', 'Invalid JSON'); }
}
async function audit(m, action, detail = {}) {
  try { await db().set(`audit/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, { at: new Date().toISOString(), uid: m.uid, email: m.email, action, ...detail }); } catch { /* best effort */ }
}
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(e || '').trim());

export function servicesStatus() {
  const F = settingsStatus();
  const has = k => !!F[k].source;
  return {
    google: { connected: googleConfigured(), mode: saMode() ? 'service' : (has('GOOGLE_REFRESH_TOKEN') ? 'oauth' : null), saEmail: saAvailable() ? saEmail() : '', admobReady: admobReady(), clientReady: has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET'), signedIn: has('GOOGLE_REFRESH_TOKEN'), admob: has('ADMOB_PUBLISHER_ID'), bigquery: has('BIGQUERY_PROJECT') },
    apple: { connected: ascConfigured(), missing: ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_VENDOR_NUMBER', 'ASC_PRIVATE_KEY'].filter(k => !has(k)) },
    revenuecat: { connected: rcConfigured(), via: has('REVENUECAT_API_KEY') ? 'key' : has('RC_REFRESH_TOKEN') ? 'oauth' : null },
    ratings: { connected: true, country: env('STORE_COUNTRY', 'sa') },
    searchads: { connected: NETS.asa.ready() }, snapchat: { connected: NETS.snap.ready(), clientReady: snapClientReady(), signedIn: has('SNAP_REFRESH_TOKEN') },
    tiktok: { connected: NETS.tiktok.ready() }, meta: { connected: NETS.meta.ready() }, googleads: { connected: NETS.gads.ready(), googleSignedIn: has('GOOGLE_REFRESH_TOKEN') },
    ai: { connected: aiConfigured(), model: aiModel() },
    steam: { connected: has('STEAM_FINANCIAL_KEY') }
  };
}

export async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '').replace(/^\/\.netlify\/functions\/api/, '/api');
  const parts = path.split('/').filter(Boolean).slice(1); // after "api"
  const M = req.method.toUpperCase();
  const route = (m, p) => M === m && new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$').exec(parts.join('/'));
  let r;
  try {
    // ---------- public ----------
    if (route('GET', 'config')) {
      const pid = process.env.FIREBASE_PROJECT_ID || '';
      const firebase = { apiKey: process.env.FIREBASE_WEB_API_KEY || '', authDomain: process.env.FIREBASE_AUTH_DOMAIN || (pid ? pid + '.firebaseapp.com' : ''), projectId: pid, appId: process.env.FIREBASE_APP_ID || '' };
      const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_WEB_API_KEY', 'APP_SECRET', 'OWNER_EMAIL'].filter(k => !process.env[k]);
      if ((process.env.APP_SECRET || '').length && process.env.APP_SECRET.length < 32) missing.push('APP_SECRET (too short)');
      return json({ firebase, ready: !missing.length, missing });
    }
    if ((r = route('GET', 'oauth/:p/callback'))) {
      const p = r[1]; if (!['google', 'revenuecat', 'snapchat'].includes(p)) throw new HttpError(404, 'not_found');
      const isOwner = async uid => { const m = await db().get(`members/${uid}`); return !!m && m.role === 'owner' && !m.disabled; };
      return redirect(await finishOAuth(req, p, url, isOwner));
    }

    // ---------- signed in ----------
    if (route('GET', 'me')) {
      const t = await verify(req);
      const m = await member(t, { bootstrap: true });
      const team = (await db().get('team/settings')) || {};
      return json({ uid: m.uid, email: m.email, role: m.role, mfaActive: m.mfaActive, team: { requireMfa: !!team.requireMfa, idleMinutes: team.idleMinutes || 30 } });
    }
    if (route('POST', 'auth/revoke')) {
      const t = await verify(req);
      await revokeAll(t.uid);
      return json({ ok: true });
    }
    if (route('GET', 'live')) {
      await requireRole(req, 'viewer'); await loadSettings();
      return json(await buildLive(Math.min(400, Math.max(1, +url.searchParams.get('days') || 150))));
    }
    if (route('GET', 'daily.csv')) {
      await requireRole(req, 'viewer'); await loadSettings();
      const L = await buildLive(Math.min(400, Math.max(1, +url.searchParams.get('days') || 150)));
      return new Response(toCsv(L.rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="kinzhal-nest-daily.csv"', ...SEC_HEADERS } });
    }
    if (route('GET', 'integrations')) {
      const { m } = await requireRole(req, 'viewer'); await loadSettings();
      const F = settingsStatus();
      if (m.role !== 'owner') for (const k of Object.keys(F)) F[k].hint = F[k].source ? '••••' : null; // only the owner sees hints
      return json({ services: servicesStatus(), fields: F, games: loadGames().games, redirect: { google: redirectUri(req, 'google'), revenuecat: redirectUri(req, 'revenuecat'), snapchat: redirectUri(req, 'snapchat') }, origin: new URL(redirectUri(req, 'google')).origin, sync: { status: await getKV('status'), queue: await queueState() }, role: m.role });
    }
    if ((r = route('POST', 'integrations/:s/test'))) {
      await requireRole(req, 'editor'); if (!SERVICES.includes(r[1])) throw new HttpError(404, 'not_found');
      await loadSettings();
      return json({ ok: true, tests: await testService(r[1]), services: servicesStatus() });
    }
    if ((r = route('POST', 'integrations/:s'))) {
      const { m } = await requireRole(req, 'owner'); const s = r[1]; if (!SERVICES.includes(s)) throw new HttpError(404, 'not_found');
      const b = await body(req), values = {};
      for (const [k, v] of Object.entries(b.values || {})) {
        if (!FIELDS[k] || FIELDS[k].service !== s || FIELDS[k].internal) throw new HttpError(400, 'bad_field', `${k} does not belong to ${s}`);
        values[k] = v === null ? null : String(v);
      }
      if (s === 'apple' && b.fileName && !values.ASC_KEY_ID) { const kid = keyIdFromFileName(b.fileName); if (kid) values.ASC_KEY_ID = kid; }
      if (values.ASC_PRIVATE_KEY && !/BEGIN PRIVATE KEY/.test(values.ASC_PRIVATE_KEY)) throw new HttpError(400, 'bad_key', 'That does not look like an App Store Connect .p8 key');
      // Browsers sometimes autofill a saved login into key boxes: refuse emails and passwords early, with a clear message.
      for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim())) throw new HttpError(400, 'bad_value', `${k} looks like an email address. Your browser may have filled in your saved login — clear the box and paste the key instead.`);
      if (values.ASC_VENDOR_NUMBER && !/^\d{8,9}$/.test(values.ASC_VENDOR_NUMBER.trim())) throw new HttpError(400, 'bad_value', 'The Vendor number is 8 digits (App Store Connect → Payments and Financial Reports, top left). It is not the Team ID or the Apple ID.');
      if (values.GOOGLE_CLIENT_ID && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(values.GOOGLE_CLIENT_ID.trim())) throw new HttpError(400, 'bad_value', 'The OAuth Client ID ends with .apps.googleusercontent.com (Google Cloud → Clients → your Web client).');
      if (values.GOOGLE_CLIENT_SECRET && (/[\s@]/.test(values.GOOGLE_CLIENT_SECRET.trim()) || values.GOOGLE_CLIENT_SECRET.trim().length < 20)) throw new HttpError(400, 'bad_value', 'That is not a Google client secret (it usually starts with GOCSPX-). Copy it from Google Cloud → Clients → your Web client.');
      if (values.ASA_PRIVATE_KEY && !/PRIVATE KEY/.test(values.ASA_PRIVATE_KEY)) throw new HttpError(400, 'bad_key', 'That does not look like an Apple Search Ads private key (.pem)');
      try { await saveSettings(values); } catch (e) { throw new HttpError(400, 'bad_value', e.message); }
      await audit(m, 'integration.save', { service: s, keys: Object.keys(values) });
      const tests = b.test === false ? [] : await testService(s);
      return json({ ok: true, tests, services: servicesStatus(), fields: settingsStatus() });
    }
    if ((r = route('DELETE', 'integrations/:s'))) {
      const { m } = await requireRole(req, 'owner'); if (!SERVICES.includes(r[1])) throw new HttpError(404, 'not_found');
      await clearService(r[1]); await audit(m, 'integration.disconnect', { service: r[1] });
      return json({ ok: true, services: servicesStatus(), fields: settingsStatus() });
    }
    if ((r = route('POST', 'oauth/:p/start'))) {
      const { m } = await requireRole(req, 'owner'); if (!['google', 'revenuecat', 'snapchat'].includes(r[1])) throw new HttpError(404, 'not_found');
      return json({ url: await startOAuth(req, r[1], m.uid) });
    }
    if (route('POST', 'discover')) {
      await requireRole(req, 'editor'); await loadSettings();
      const b = await body(req);
      const games = (Array.isArray(b.games) ? b.games : loadGames().games).slice(0, 200);
      return json(await discover(games));
    }
    if (route('PUT', 'games')) {
      const { m } = await requireRole(req, 'editor'); await loadSettings();
      const b = await body(req);
      const auto = {};
      for (const [k, v] of Object.entries(b.settings || {})) { if (!FIELDS[k]?.auto) throw new HttpError(400, 'bad_field', k); auto[k] = String(v); }
      if (Object.keys(auto).length) await saveSettings(auto);
      try { await saveGames(b.games); } catch (e) { throw new HttpError(400, 'bad_games', e.message); }
      await audit(m, 'games.save', { count: loadGames().games.length });
      return json({ ok: true, games: loadGames().games });
    }
    if (route('POST', 'sync')) {
      const { m } = await requireRole(req, 'editor');
      const b = await body(req);
      const started = Date.now();
      await startSync({ days: Math.min(120, Math.max(1, +b.days || 3)), by: m.email });
      return json(await runQueue(started + 7000)); // the page calls again while `remaining` > 0
    }
    if (route('GET', 'sync')) {
      await requireRole(req, 'viewer');
      return json({ queue: await queueState(), status: await getKV('status') });
    }

    // ---------- marketing ----------
    if (route('GET', 'marketing')) {
      await requireRole(req, 'viewer'); await loadSettings();
      const { games } = loadGames();
      const ads = (await loadAdRows(games, isoDay(-Math.min(150, Math.max(7, +url.searchParams.get('days') || 120))))).map(({ net, cid, cname, g, d, spend, imp, clk, inst, cur }) => ({ net, cid, n: cname, g, d, spend, imp, clk, inst, cur }));
      const reviews = {}, storeTerr = {};
      const [rv, st, adMap, brief] = await Promise.all([Promise.all(games.map(g => getKV('reviews:' + g.id))), Promise.all(games.map(g => getKV('storeTerr:' + g.id))), getKV('adMap'), getKV('brief')]);
      games.forEach((g, i) => { if (rv[i]) reviews[g.id] = rv[i]; if (st[i]) storeTerr[g.id] = st[i]; });
      return json({ ads, adMap: adMap || {}, reviews, storeTerr, brief, ai: { ready: aiConfigured(), model: aiModel() }, nets: Object.fromEntries(Object.entries(NETS).map(([k, N]) => [k, { name: N.name, ready: N.ready() }])) });
    }
    if (route('PUT', 'ads/map')) {
      const { m } = await requireRole(req, 'editor'); await loadSettings();
      const b = await body(req); const map = await saveAdMap(b.map, loadGames().games);
      await audit(m, 'ads.map', { count: Object.keys(b.map || {}).length });
      return json({ ok: true, adMap: map });
    }
    if (route('POST', 'ads/import')) {
      const { m } = await requireRole(req, 'editor'); await loadSettings();
      const b = await body(req), net = AD_NETS.includes(b.net) ? b.net : 'csv';
      let rows; try { rows = parseAdCsv(b.csv, net); } catch (e) { throw new HttpError(400, 'bad_csv', e.message); }
      if (!rows.length) throw new HttpError(400, 'bad_csv', 'No rows with a date found');
      await saveAdRows(rows, loadGames().games); await audit(m, 'ads.import', { net, rows: rows.length });
      return json({ ok: true, rows: rows.length, campaigns: new Set(rows.map(r => r.cid)).size });
    }
    if (route('POST', 'ai')) {
      await requireRole(req, 'editor'); await loadSettings();
      const b = await body(req); const q = String(b.q || '').trim();
      if (!q) throw new HttpError(400, 'empty', 'Ask a question');
      try { return json({ ok: true, answer: await askClaude(q, { extra: b.extra || '', maxTokens: 900, timeoutMs: 9200 }) }); }
      catch (e) { throw new HttpError(502, 'ai', e.message); }
    }
    if (route('POST', 'brief')) {
      await requireRole(req, 'editor'); await loadSettings();
      try { return json({ ok: true, brief: await weeklyBrief({ timeoutMs: 9200 }) }); }
      catch (e) { throw new HttpError(502, 'ai', e.message + ' — the full brief is written automatically every Sunday at 07:00 Riyadh time.'); }
    }

    // ---------- team (owner) ----------
    if (route('GET', 'team')) {
      await requireRole(req, 'owner');
      const [members, invites, team] = await Promise.all([db().list('members'), db().list('invites'), db().get('team/settings')]);
      return json({ members: members.map(x => ({ uid: x.id, email: x.data.email, role: x.data.role, disabled: !!x.data.disabled, joinedAt: x.data.joinedAt })), invites: invites.map(x => ({ email: x.data.email, role: x.data.role, expires: x.data.expires, by: x.data.by })), settings: { requireMfa: !!team?.requireMfa, idleMinutes: team?.idleMinutes || 30 } });
    }
    if (route('POST', 'team/invites')) {
      const { m } = await requireRole(req, 'owner');
      const b = await body(req), email = String(b.email || '').trim().toLowerCase(), role = b.role;
      if (!okEmail(email)) throw new HttpError(400, 'bad_email', 'Enter a valid email');
      if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'bad_role', 'Role must be editor or viewer');
      if (email === ownerEmail()) throw new HttpError(400, 'owner', 'That is the owner account');
      const inv = { email, role, by: m.email, at: new Date().toISOString(), expires: new Date(Date.now() + 14 * 864e5).toISOString() };
      await db().set(`invites/${emailKey(email)}`, inv); await audit(m, 'team.invite', { email, role });
      return json({ ok: true, invite: inv });
    }
    if ((r = route('DELETE', 'team/invites/:e'))) {
      const { m } = await requireRole(req, 'owner');
      const email = decodeURIComponent(r[1]).toLowerCase();
      await db().del(`invites/${emailKey(email)}`); await audit(m, 'team.invite.cancel', { email });
      return json({ ok: true });
    }
    if ((r = route('PATCH', 'team/members/:u'))) {
      const { m } = await requireRole(req, 'owner');
      const uid = decodeURIComponent(r[1]); if (uid === m.uid) throw new HttpError(400, 'self', 'You cannot change your own role');
      const cur = await db().get(`members/${uid}`); if (!cur) throw new HttpError(404, 'not_found');
      const b = await body(req), patch = {};
      if (b.role !== undefined) { if (!['editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'bad_role', 'Role must be editor or viewer'); patch.role = b.role; }
      if (b.disabled !== undefined) patch.disabled = !!b.disabled;
      await db().set(`members/${uid}`, patch, { merge: true });
      if (patch.disabled) await revokeAll(uid);
      await audit(m, 'team.member', { target: cur.email, ...patch });
      return json({ ok: true });
    }
    if ((r = route('DELETE', 'team/members/:u'))) {
      const { m } = await requireRole(req, 'owner');
      const uid = decodeURIComponent(r[1]); if (uid === m.uid) throw new HttpError(400, 'self', 'You cannot remove yourself');
      const cur = await db().get(`members/${uid}`); if (!cur) throw new HttpError(404, 'not_found');
      await revokeAll(uid).catch(() => {}); await db().del(`members/${uid}`);
      await audit(m, 'team.remove', { target: cur.email });
      return json({ ok: true });
    }
    if (route('PUT', 'team/settings')) {
      const { m } = await requireRole(req, 'owner');
      const b = await body(req), cur = (await db().get('team/settings')) || {};
      const next = { ...cur };
      if (b.requireMfa !== undefined) {
        if (b.requireMfa && !m.mfaActive) throw new HttpError(400, 'mfa_self', 'Turn on 2-step verification for your own account first (and sign in with it), so you cannot lock yourself out.');
        next.requireMfa = !!b.requireMfa;
        for (const x of await db().list('members')) await db().set(`members/${x.id}`, { mfa: next.requireMfa }, { merge: true });
      }
      if (b.idleMinutes !== undefined) next.idleMinutes = Math.min(240, Math.max(5, Math.round(+b.idleMinutes || 30)));
      await db().set('team/settings', next); await audit(m, 'team.settings', next);
      return json({ ok: true, settings: { requireMfa: !!next.requireMfa, idleMinutes: next.idleMinutes || 30 } });
    }
    throw new HttpError(404, 'not_found', 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(path, e);
    return json({ error: String(e.message || e).slice(0, 400), code: 'server' }, 500);
  }
}
// unused import guards (kept explicit for readers)
void can; void ROLES;
