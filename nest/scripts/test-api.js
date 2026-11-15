// npm test (part) -> the whole API offline: in-memory Firestore, fake Firebase Auth, stubbed Google / Apple / RevenueCat.
import assert from 'node:assert/strict';
Object.assign(process.env, {
  FIREBASE_PROJECT_ID: 'kinzhal-test', FIREBASE_CLIENT_EMAIL: 'sa@kinzhal-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: Buffer.from('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n').toString('base64'), FIREBASE_WEB_API_KEY: 'web-key',
  APP_SECRET: 'a'.repeat(40), OWNER_EMAIL: 'Owner@Kinzhal.sa', SITE_URL: 'https://nest.example.com'
});
const { useDb, memoryDb } = await import('../src/db.js');
const { useAuth } = await import('../src/auth.js');
const mem = useDb(memoryDb());
const now = () => Math.floor(Date.now() / 1000);
const TOK = {
  owner: { uid: 'u-owner', email: 'owner@kinzhal.sa', email_verified: true, auth_time: now() - 10, firebase: {} },
  ed: { uid: 'u-ed', email: 'editor@kinzhal.sa', email_verified: true, auth_time: now() - 10, firebase: {} },
  view: { uid: 'u-view', email: 'viewer@kinzhal.sa', email_verified: true, auth_time: now() - 10, firebase: {} },
  stranger: { uid: 'u-x', email: 'x@evil.com', email_verified: true, auth_time: now() - 10, firebase: {} },
  unverified: { uid: 'u-uv', email: 'editor@kinzhal.sa', email_verified: false, auth_time: now() - 10, firebase: {} },
  ownerMfa: { uid: 'u-owner', email: 'owner@kinzhal.sa', email_verified: true, auth_time: now() + 5, firebase: { sign_in_second_factor: 'totp' } }
};
const revoked = new Set();
useAuth({
  async verifyIdToken(t, check) { const d = TOK[t.split('.')[0]]; if (!d) throw Object.assign(new Error('bad'), { code: 'auth/argument-error' }); if (check && revoked.has(t.split('.')[0])) throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' }); return { ...d }; },
  async revokeRefreshTokens(uid) { for (const [k, v] of Object.entries(TOK)) if (v.uid === uid) revoked.add(k); },
  async getUser() { return null; }
});

const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
let googleTokenBody = '', saTokenCalls = 0;
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  if (u.includes('oauth2.googleapis.com/token') && String(opt.body).includes('jwt-bearer')) { saTokenCalls++; return J({ access_token: 'sa-token', expires_in: 3600 }); }
  if (opt.headers?.authorization === 'Bearer sa-token' && u.includes('admob')) throw new Error('AdMob must never get the service-account token');
  if (u.includes('oauth2.googleapis.com/token')) { googleTokenBody = String(opt.body); if (googleTokenBody.includes('authorization_code')) return J({ access_token: 'g', refresh_token: 'g-refresh', expires_in: 3600 }); return J({ access_token: 'g', expires_in: 3600 }); }
  if (u.includes('accountSummaries')) return J({ accountSummaries: [{ displayName: 'Kinzhal', propertySummaries: [{ property: 'properties/111', displayName: 'Brick Blast' }, { property: 'properties/222', displayName: 'Orbit Rush' }] }] });
  if (u.includes('properties/111/dataStreams')) return J({ dataStreams: [{ name: 'properties/111/dataStreams/S1', displayName: 'Brick iOS', iosAppStreamData: { bundleId: 'com.kinzhal.brickblast' } }] });
  if (u.includes('properties/222/dataStreams')) return J({ dataStreams: [{ name: 'properties/222/dataStreams/S2', displayName: 'Orbit', iosAppStreamData: { bundleId: 'com.kinzhal.orbitrush' } }] });
  if (u.endsWith('admob.googleapis.com/v1/accounts')) return J({ account: [{ publisherId: 'pub-777' }] });
  if (u.includes('admob.googleapis.com/v1/accounts/pub-777/apps')) return J({ apps: [{ appId: 'ca-app-pub-777~1', platform: 'IOS', linkedAppInfo: { appStoreId: '640001', displayName: 'Brick Blast' } }] });
  if (u.includes('firebase.googleapis.com/v1beta1/projects?')) return J({ results: [{ projectId: 'kinzhal-games', displayName: 'Kinzhal Games' }] });
  if (u.includes('/iosApps')) return J({ apps: [{ bundleId: 'com.kinzhal.brickblast', displayName: 'Brick' }] });
  if (u.includes('datasets/firebase_crashlytics/tables')) return J({ tables: [{ tableReference: { tableId: 'com_kinzhal_brickblast_IOS' } }] });
  if (u.includes('appstoreconnect.apple.com/v1/apps') && !/customerReviews|analyticsReportRequests/.test(u)) return J({ data: [{ id: '640001', attributes: { name: 'Brick Blast', bundleId: 'com.kinzhal.brickblast' } }, { id: '640011', attributes: { name: 'Orbit Rush', bundleId: 'com.kinzhal.orbitrush' } }] });
  if (u.includes('appstoreconnect.apple.com/v1/salesReports')) { const zlib = await import('node:zlib'); return new Response(zlib.gzipSync('Provider\tApple Identifier\tUnits\tProduct Type Identifier\nAPPLE\t640001\t300\t1\nAPPLE\t640011\t40\t1\n'), { status: 200 }); }
  if (u.includes('api.revenuecat.com/v2/projects?')) return J({ items: [{ id: 'projA', name: 'Brick Blast' }], next_page: null });
  if (u.includes('/v2/projects/projA/apps')) return J({ items: [{ id: 'a1', name: 'Brick iOS', type: 'app_store', app_store: { bundle_id: 'com.kinzhal.brickblast' } }], next_page: null });
  if (u.includes('/v2/projects/projA/metrics/revenue')) return J({ value: 12.5 });
  if (u.includes('analyticsdata.googleapis.com')) {
    const b = JSON.parse(opt.body);
    if (b.cohortSpec) return J({ rows: b.cohortSpec.cohorts.map(c => ({ dimensionValues: [{ value: c.name }, { value: '0001' }], metricValues: [{ value: '40' }, { value: '100' }] })) });
    return J({ rows: [{ dimensionValues: [{ value: b.dateRanges[0].endDate.replace(/-/g, '') }], metricValues: [{ value: '1000' }, { value: '120' }, { value: '4000' }, { value: '540' }] }] });
  }
  if (u.includes('mediationReport:generate')) { const b = JSON.parse(opt.body); if (b.reportSpec.dimensions.includes('AD_SOURCE')) return J([{ header: {} }, { row: { dimensionValues: { AD_SOURCE: { value: '1', displayLabel: 'AdMob Network' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '5000000' }, IMPRESSIONS: { integerValue: '900' } } } }]); const d = b.reportSpec.dateRange.endDate; return J([{ row: { dimensionValues: { DATE: { value: `${d.year}${String(d.month).padStart(2, '0')}${String(d.day).padStart(2, '0')}` }, APP: { value: 'ca-app-pub-777~1' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '42000000' }, IMPRESSIONS: { integerValue: '5000' } } } }]); }
  if (u.includes('bigquery.googleapis.com') && u.endsWith('/queries')) return J({ jobComplete: true, rows: [] });
  if (u.includes('itunes.apple.com/lookup')) return J({ results: [{ trackId: 640001, averageUserRating: 4.7, userRatingCount: 50 }] });
  // --- steam ---
  if (u.includes('GetNumberOfCurrentPlayers')) return J({ response: { player_count: 321, result: 1 } });
  if (u.includes('store.steampowered.com/appreviews/')) return J({ success: 1, query_summary: { total_positive: 90, total_negative: 10, total_reviews: 100, review_score_desc: 'Very Positive' } });
  if (u.includes('partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales')) { const hw = new URL(u).searchParams.get('highwatermark_id'); assert.ok(new URL(u).searchParams.get('key')); return J({ response: hw === '0' ? { results: [{ primary_appid: 2400, net_units_sold: 12, gross_sales_usd: 180, net_sales_usd: 150, gross_units_returned: 1 }, { primary_appid: 9999, net_units_sold: 5, net_sales_usd: 40 }], max_id: '77' } : { results: [], max_id: '77' } }); }
  // --- marketing sources ---
  if (u.includes('appstoreconnect.apple.com/v1/analyticsReportRequests') && opt.method === 'POST') return J({ data: { id: 'req-1', type: 'analyticsReportRequests' } });
  if (u.includes('/v1/analyticsReportRequests/req-1/reports')) return J({ data: [{ id: 'rep-1', attributes: { name: 'App Store Discovery and Engagement Standard' } }] });
  if (u.includes('/v1/analyticsReports/rep-1/instances')) return J({ data: [{ id: 'inst-1' }] });
  if (u.includes('/v1/analyticsReportInstances/inst-1/segments')) return J({ data: [{ attributes: { url: 'https://files.example/seg1.gz' } }] });
  if (u === 'https://files.example/seg1.gz') { const zlib = await import('node:zlib'); return new Response(zlib.gzipSync('Date\tApp Apple Identifier\tEvent\tTerritory\tCounts\tUnique Counts\n2026-10-30\t640001\tImpression\tSA\t900\t800\n2026-10-30\t640001\tPage view\tSA\t120\t100\n2026-10-30\t640001\tImpression\tAE\t50\t40\n'), { status: 200 }); }
  if (u.includes('/customerReviews')) return J({ data: [{ id: 'rv1', attributes: { rating: 2, title: 'اعلانات كثيرة', body: 'اللعبة حلوة بس الاعلانات كثير', createdDate: '2026-10-30T10:00:00Z', territory: 'SAU' } }] });
  if (u.includes('appleid.apple.com/auth/oauth2/token')) { assert.ok(String(opt.body).includes('client_credentials') && String(opt.body).includes('scope=searchadsorg')); return J({ access_token: 'asa-tok', expires_in: 3600 }); }
  if (u.includes('api.searchads.apple.com/api/v5/reports/campaigns')) { assert.equal(opt.headers['x-ap-context'], 'orgId=4242'); const b = JSON.parse(opt.body); return J({ data: { reportingDataResponse: { row: [{ metadata: { campaignId: 77, campaignName: 'Search KSA', app: { adamId: 640001, appName: 'Brick Blast' } }, granularity: [{ date: b.endTime, impressions: 1000, taps: 80, totalInstalls: 40, localSpend: { amount: '30.50', currency: 'USD' } }] }] } }, pagination: { totalResults: 1 } }); }
  if (u.includes('business-api.tiktok.com')) { assert.ok(opt.headers['Access-Token']); return J({ code: 0, data: { list: [{ dimensions: { campaign_id: '9001', stat_time_day: '2026-10-30 00:00:00' }, metrics: { spend: '20', impressions: '5000', clicks: '100', app_install: '25', campaign_name: 'Orbit Rush TT' } }], page_info: { total_page: 1 } } }); }
  if (u.includes('graph.facebook.com')) return J({ data: [{ campaign_id: '555', campaign_name: 'Mystery campaign', spend: '10', impressions: '2000', clicks: '30', actions: [{ action_type: 'mobile_app_install', value: '8' }], date_start: '2026-10-30' }], paging: {} });
  if (u.includes('api.anthropic.com/v1/messages')) { const b = JSON.parse(opt.body); assert.equal(opt.headers['x-api-key'], 'sk-ant-test-123456'); if (b.max_tokens >= 50) assert.ok(b.messages[0].content.includes('<DATA>') && b.messages[0].content.includes('Brick Blast'), b.messages[0].content.slice(0, 400)); return J({ content: [{ type: 'text', text: b.max_tokens < 50 ? 'ok' : 'Brick Blast: raise budget.' }] }); }
  throw new Error('unexpected fetch ' + u);
};

const { handle } = await import('../src/api.js');
const call = async (method, path, who, body) => {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${who}.payload.sig`;
  const res = await handle(new Request('https://nest.example.com' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }));
  const txt = await res.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: res.status, j, h: res.headers };
};

// --- public config ---
let r = await call('GET', '/api/config');
assert.equal(r.s, 200); assert.equal(r.j.ready, true); assert.equal(r.j.firebase.authDomain, 'kinzhal-test.firebaseapp.com'); assert.ok(!JSON.stringify(r.j).includes('a'.repeat(40)), 'never exposes APP_SECRET');
assert.equal(r.h.get('cache-control'), 'no-store');

// --- sign-in rules ---
assert.equal((await call('GET', '/api/me')).s, 401, 'no token');
assert.equal((await call('GET', '/api/me', 'garbage')).j.code, 'signed_out');
assert.equal((await call('GET', '/api/me', 'unverified')).j.code, 'verify_email');
assert.equal((await call('GET', '/api/me', 'stranger')).j.code, 'not_invited');
r = await call('GET', '/api/me', 'owner'); assert.equal(r.j.role, 'owner', 'OWNER_EMAIL becomes owner (case-insensitive)');
assert.equal((await call('GET', '/api/team', 'stranger')).s, 403);

// --- team: invite editor + viewer ---
assert.equal((await call('POST', '/api/team/invites', 'owner', { email: 'not-an-email', role: 'editor' })).s, 400);
assert.equal((await call('POST', '/api/team/invites', 'owner', { email: 'editor@kinzhal.sa', role: 'owner' })).s, 400, 'cannot invite a second owner');
assert.equal((await call('POST', '/api/team/invites', 'owner', { email: 'Editor@Kinzhal.sa', role: 'editor' })).s, 200);
assert.equal((await call('POST', '/api/team/invites', 'owner', { email: 'viewer@kinzhal.sa', role: 'viewer' })).s, 200);
assert.equal((await call('POST', '/api/team/invites', 'ed', { email: 'z@z.com', role: 'viewer' })).s, 403, 'not a member yet → forbidden');
assert.equal((await call('GET', '/api/me', 'ed')).j.role, 'editor');
assert.equal((await call('GET', '/api/me', 'view')).j.role, 'viewer');
assert.equal(mem.docs.has('invites/editor@kinzhal.sa'), false, 'invite is used once');
assert.equal((await call('POST', '/api/team/invites', 'ed', { email: 'z@z.com', role: 'viewer' })).s, 403, 'editor cannot invite');
r = await call('GET', '/api/team', 'owner'); assert.equal(r.j.members.length, 3);

// --- integrations: only the owner saves keys; values are encrypted at rest and never returned ---
assert.equal((await call('POST', '/api/integrations/google', 'ed', { values: { GOOGLE_CLIENT_ID: 'cid' } })).s, 403);
assert.equal((await call('POST', '/api/integrations/google', 'owner', { values: { ASC_KEY_ID: 'x' } })).s, 400, 'field must belong to the service');
assert.equal((await call('POST', '/api/integrations/google', 'owner', { values: { GOOGLE_REFRESH_TOKEN: 'x' } })).s, 400, 'internal tokens cannot be set by hand');
r = await call('POST', '/api/integrations/google', 'owner', { values: { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-supersecretvalue' }, test: false });
assert.equal(r.s, 200); assert.equal(r.j.services.google.clientReady, true); assert.equal(r.j.services.google.signedIn, false);
const raw = JSON.stringify(mem.docs.get('secrets/keys'));
assert.ok(!raw.includes('supersecretvalue') && !raw.includes('cid.apps'), 'stored encrypted');
r = await call('GET', '/api/integrations', 'owner');
assert.ok(!JSON.stringify(r.j).includes('supersecretvalue'), 'secret never returned'); assert.ok(r.j.fields.GOOGLE_CLIENT_SECRET.hint.startsWith('••••'));
assert.equal(r.j.redirect.google, 'https://nest.example.com/api/oauth/google/callback');
r = await call('GET', '/api/integrations', 'view'); assert.equal(r.j.fields.GOOGLE_CLIENT_ID.hint, '••••', 'non-owners see no hints');

// --- Google sign-in (OAuth with signed state + PKCE) ---
assert.equal((await call('POST', '/api/oauth/google/start', 'ed')).s, 403);
r = await call('POST', '/api/oauth/google/start', 'owner'); assert.equal(r.s, 200);
const authUrl = new URL(r.j.url); const state = authUrl.searchParams.get('state');
assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authUrl.searchParams.get('access_type'), 'offline');
const tampered = state.slice(0, -2) + (state.endsWith('A') ? 'BB' : 'AA');
r = await call('GET', `/api/oauth/google/callback?state=${encodeURIComponent(tampered)}&code=c1`);
assert.equal(r.s, 302); assert.ok(r.h.get('location').includes('#conn=google:err'), 'tampered state rejected');
r = await call('GET', `/api/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`);
assert.ok(r.h.get('location').endsWith('#conn=google:ok'), r.h.get('location')); assert.ok(googleTokenBody.includes('code_verifier='));
r = await call('GET', `/api/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`);
assert.ok(r.h.get('location').includes(':err'), 'state is single-use');

// --- Apple: .p8 upload fills the Key ID from the file name; bad key rejected ---
assert.equal((await call('POST', '/api/integrations/apple', 'owner', { values: { ASC_PRIVATE_KEY: 'hello' } })).s, 400);
r = await call('POST', '/api/integrations/apple', 'owner', { values: { ASC_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----', ASC_ISSUER_ID: 'iss-1', ASC_VENDOR_NUMBER: '95030693' }, fileName: 'AuthKey_AB12CD34EF.p8' });
assert.equal(r.j.services.apple.connected, true); assert.equal(r.j.fields.ASC_KEY_ID.hint, 'AB12CD34EF');
assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests));
r = await call('POST', '/api/integrations/revenuecat', 'owner', { values: { REVENUECAT_API_KEY: 'sk_live_123456789' } });
assert.equal(r.j.services.revenuecat.connected, true); assert.equal(r.j.tests[0].ok, null, 'no project yet → skipped, not failed');

// --- Discover (editor) + save game IDs ---
const appGames = [{ id: 'brick', name: 'Brick Blast' }, { id: 'orbit', name: 'Orbit Rush' }, { id: 'chess', name: 'Nuha Chess' }];
assert.equal((await call('POST', '/api/discover', 'view', { games: appGames })).s, 403);
r = await call('POST', '/api/discover', 'ed', { games: appGames }); assert.equal(r.s, 200);
const P = Object.fromEntries(r.j.proposals.map(p => [p.id, p]));
assert.equal(P.brick.values.ascAppleId, '640001'); assert.equal(P.brick.values.admobAppId, 'ca-app-pub-777~1'); assert.equal(P.brick.values.revenuecatProjectId, 'projA');
assert.equal(P.orbit.values.ga4PropertyId, '222'); assert.equal(P.orbit.values.ascAppleId, '640011');
assert.deepEqual(r.j.settings, { ADMOB_PUBLISHER_ID: 'pub-777', BIGQUERY_PROJECT: 'kinzhal-games' });
const mapped = r.j.proposals.map(p => ({ id: p.id, name: p.name, ...p.values }));
assert.equal((await call('PUT', '/api/games', 'ed', { games: mapped, settings: { GOOGLE_CLIENT_SECRET: 'hack' } })).s, 400, 'only auto settings allowed');
r = await call('PUT', '/api/games', 'ed', { games: mapped, settings: r.j.settings }); assert.equal(r.s, 200); assert.equal(r.j.games.length, 3);
assert.equal((await call('PUT', '/api/games', 'ed', { games: [{ id: 'Bad Id' }] })).s, 400);

// --- Sync runs as small jobs; the page keeps calling until remaining = 0 ---
assert.equal((await call('POST', '/api/sync', 'view', {})).s, 403);
let loops = 0; r = { j: { remaining: 1 } };
while (r.j.remaining > 0 && loops < 20) { r = await call('POST', '/api/sync', 'ed', { days: 3 }); loops++; }
assert.equal(r.j.done, true); const C = r.j.status.connectors;
for (const k of ['firebase_ga4', 'admob', 'app_store_connect', 'revenuecat', 'ratings']) assert.equal(C[k].state, 'ok', k + ' ' + JSON.stringify(C[k]));
assert.ok(C.crashlytics.state === 'ok');
r = await call('GET', '/api/live?days=10', 'view');
const brick = r.j.rows.filter(x => x.g === 'brick'); assert.ok(brick.length >= 3);
const last = brick[brick.length - 1]; assert.equal(last.inst, 300); assert.equal(last.ad, 42); assert.equal(last.iap, 12.5); assert.equal(last.dau, 1000); assert.equal(last.rating, 4.7);
assert.ok(brick.some(x => x.d1 === 0.4)); assert.deepEqual(r.j.mediation[0], { n: 'AdMob Network', v: 5, imp: 900 });
assert.ok(r.j.rows.some(x => x.g === 'orbit' && x.inst === 40));
r = await call('GET', '/api/daily.csv', 'view'); assert.ok(r.j.startsWith('date,game,installs'));

// queue lease: a second runner returns immediately while the first holds it
const { startSync, runQueue } = await import('../src/jobs.js');
await startSync({ days: 2 }); await mem.set('kv/syncQueue', { lease: Date.now() + 60000, leaseBy: 'other' }, { merge: true });
assert.equal((await runQueue(Date.now() + 5000)).busy, true); await mem.del('kv/syncQueue');

// --- 2-step rule: owner must have it first; then members without it are blocked ---
assert.equal((await call('PUT', '/api/team/settings', 'owner', { requireMfa: true })).j.code, 'mfa_self');
assert.equal((await call('PUT', '/api/team/settings', 'ownerMfa', { requireMfa: true })).s, 200);
assert.equal((await call('GET', '/api/live', 'view')).j.code, 'mfa_required');
assert.equal(mem.docs.get('members/u-view').mfa, true, 'Firestore rules see the flag too');
assert.equal((await call('PUT', '/api/team/settings', 'ownerMfa', { requireMfa: false })).s, 200);

// --- roles, removal, sign out everywhere ---
const viewUid = 'u-view';
assert.equal((await call('PATCH', `/api/team/members/${viewUid}`, 'owner', { role: 'owner' })).s, 400);
assert.equal((await call('PATCH', '/api/team/members/u-owner', 'ownerMfa', { role: 'viewer' })).s, 400, 'owner cannot demote self');
assert.equal((await call('PATCH', `/api/team/members/${viewUid}`, 'owner', { role: 'editor' })).s, 200);
assert.equal(mem.docs.get('members/u-view').role, 'editor');
assert.equal((await call('POST', '/api/auth/revoke', 'ed')).s, 200);
assert.equal((await call('GET', '/api/me', 'ed')).j.code, 'revoked', 'old session rejected after sign-out everywhere');
assert.ok(mem.docs.get('members/u-ed').revokedAt > 0);
assert.equal((await call('DELETE', `/api/team/members/${viewUid}`, 'owner')).s, 200);
assert.equal(mem.docs.has('members/u-view'), false);
assert.equal((await call('DELETE', '/api/integrations/google', 'owner')).j.services.google.clientReady, false);
assert.ok([...mem.docs.keys()].some(k => k.startsWith('audit/')), 'changes are audited');

// --- service-account mode: one central account for all game projects; AdMob stays on Google sign-in ---
assert.equal((await call('POST', '/api/integrations/google', 'owner', { values: { GOOGLE_USE_SA: '1' }, test: false })).j.services.google.mode, 'service');
r = await call('GET', '/api/integrations', 'owner');
assert.equal(r.j.services.google.connected, true); assert.equal(r.j.services.google.saEmail, 'sa@kinzhal-test.iam.gserviceaccount.com'); assert.equal(r.j.services.google.admobReady, false);
r = await call('POST', '/api/integrations/google/test', 'owner');
assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests)); assert.ok(/2 Analytics properties/.test(r.j.tests[0].message));
assert.equal(r.j.tests.find(x => x.test === 'admob').ok, null, 'AdMob is skipped, not failed');
r = await call('POST', '/api/discover', 'owner', { games: appGames });
assert.equal(r.j.summary.ga4.ok, true); assert.equal(r.j.summary.admob.off, true);
loops = 0; r = { j: { remaining: 1 } };
while (r.j.remaining > 0 && loops < 20) { r = await call('POST', '/api/sync', 'owner', { days: 2 }); loops++; }
assert.equal(r.j.status.connectors.firebase_ga4.state, 'ok'); assert.equal(r.j.status.connectors.admob.state, 'off');
assert.ok(saTokenCalls >= 1);

// --- marketing: ad networks, store funnel, reviews, AI ---
r = await call('POST', '/api/integrations/searchads', 'ownerMfa', { values: { ASA_CLIENT_ID: 'SEARCHADS.abc', ASA_TEAM_ID: 'SEARCHADS.abc', ASA_KEY_ID: 'k1', ASA_ORG_ID: '4242', ASA_PRIVATE_KEY: '-----BEGIN EC PRIVATE KEY-----\nMHc\n-----END EC PRIVATE KEY-----' } });
assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.services.searchads.connected, true); assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests));
assert.equal((await call('POST', '/api/integrations/searchads', 'ownerMfa', { values: { ASA_PRIVATE_KEY: 'nope' } })).s, 400);
r = await call('POST', '/api/integrations/tiktok', 'ownerMfa', { values: { TIKTOK_ACCESS_TOKEN: 'tt-token-123', TIKTOK_ADVERTISER_ID: '700' } }); assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests));
r = await call('POST', '/api/integrations/meta', 'ownerMfa', { values: { META_ACCESS_TOKEN: 'EAAB-token', META_AD_ACCOUNT_ID: 'act_123' } }); assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests));
assert.equal((await call('POST', '/api/integrations/snapchat', 'ownerMfa', { values: { SNAP_REFRESH_TOKEN: 'x' } })).s, 400, 'refresh token only via Connect Snapchat');
r = await call('POST', '/api/integrations/snapchat', 'ownerMfa', { values: { SNAP_CLIENT_ID: 'snap-cid', SNAP_CLIENT_SECRET: 'snap-secret' }, test: false });
assert.equal(r.j.services.snapchat.clientReady, true); assert.equal(r.j.services.snapchat.connected, false);
r = await call('POST', '/api/oauth/snapchat/start', 'ownerMfa'); assert.ok(new URL(r.j.url).searchParams.get('scope') === 'snapchat-marketing-api');
r = await call('POST', '/api/integrations/ai', 'ownerMfa', { values: { ANTHROPIC_API_KEY: 'sk-ant-test-123456' } }); assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests));
loops = 0; r = { j: { remaining: 1 } };
while (r.j.remaining > 0 && loops < 40) { r = await call('POST', '/api/sync', 'ownerMfa', { days: 3 }); loops++; }
const MC = r.j.status.connectors;
for (const k of ['ads_asa', 'ads_tiktok', 'ads_meta', 'store_funnel', 'reviews']) assert.equal(MC[k].state, 'ok', k + ' ' + JSON.stringify(MC[k]));
assert.equal(MC.ads_snap.state, 'off'); assert.equal(MC.ads_gads.state, 'off');
r = await call('GET', '/api/marketing', 'ownerMfa'); assert.equal(r.s, 200);
const asa = r.j.ads.find(x => x.net === 'asa'); assert.equal(asa.g, 'brick', 'Apple Search Ads matched by App Store ID'); assert.equal(asa.spend, 30.5); assert.equal(asa.inst, 40);
assert.equal(r.j.ads.find(x => x.net === 'tiktok').g, 'orbit', 'matched by game name in the campaign name');
assert.equal(r.j.ads.find(x => x.net === 'meta').g, null, 'unknown campaign stays unassigned');
assert.equal(r.j.reviews.brick[0].r, 2); assert.equal(r.j.storeTerr.brick['2026-10-30'].SA.imp, 800);
assert.equal((await call('PUT', '/api/ads/map', 'ownerMfa', { map: { 'meta:555': 'chess', 'meta:bad id!': 'chess' } })).j.adMap['meta:555'], 'chess');
r = await call('GET', '/api/marketing', 'ownerMfa'); assert.equal(r.j.ads.find(x => x.net === 'meta').g, 'chess');
r = await call('GET', '/api/live?days=10', 'ownerMfa');
const bk = r.j.rows.find(x => x.g === 'brick' && x.d === '2026-10-30'); if (bk) { assert.equal(bk.sImp, 840); assert.equal(bk.sView, 100); }
assert.ok(r.j.rows.some(x => x.g === 'brick' && x.ua === 30.5 && x.paid === 40), 'spend rolled into daily ua/paid');
assert.ok(r.j.rows.some(x => x.g === 'chess' && x.ua === 10), 'manual mapping rolls up too');
r = await call('POST', '/api/ads/import', 'ownerMfa', { net: 'snap', csv: 'Date,Campaign Name,Amount Spent,Impressions,Swipe Ups,Installs\n2026-10-29,Ruby Bounce Ramadan,15.5,3000,90,12\n' });
assert.equal(r.j.rows, 1);
assert.equal((await call('POST', '/api/ads/import', 'ownerMfa', { csv: 'foo,bar\n1,2' })).s, 400);
assert.equal((await call('POST', '/api/ai', 'stranger', { q: 'hi' })).s, 403, 'strangers cannot use the AI');
r = await call('POST', '/api/ai', 'ownerMfa', { q: 'Which game should get more budget?' }); assert.equal(r.j.answer, 'Brick Blast: raise budget.');
r = await call('POST', '/api/brief', 'ownerMfa'); assert.ok(r.j.brief.text.length > 3);
r = await call('GET', '/api/marketing', 'ownerMfa'); assert.ok(r.j.brief.at); assert.equal(r.j.ai.ready, true);
assert.ok(!JSON.stringify(mem.docs.get('secrets/keys')).includes('sk-ant-test'), 'Claude key encrypted at rest');

// --- steam ---
r = await call('GET', '/api/integrations', 'ownerMfa');
const SG = r.j.games.map((g, i) => i === 0 ? { ...g, steamAppId: '2400' } : g); const SGID = SG[0].id;
assert.equal((await call('PUT', '/api/games', 'ownerMfa', { games: SG })).s, 200);
r = await call('POST', '/api/integrations/steam', 'ownerMfa', { values: { STEAM_FINANCIAL_KEY: 'ABCDEF0123456789' } });
assert.equal(r.j.tests[0].ok, true, JSON.stringify(r.j.tests)); assert.equal(r.j.services.steam.connected, true);
loops = 0; r = { j: { remaining: 1 } };
while (r.j.remaining > 0 && loops < 60) { r = await call('POST', '/api/sync', 'ownerMfa', { days: 2 }); loops++; }
assert.equal(r.j.status.connectors.steam_store.state, 'ok', JSON.stringify(r.j.status.connectors.steam_store)); assert.equal(r.j.status.connectors.steam_sales.state, 'ok');
r = await call('GET', '/api/live?days=5', 'ownerMfa');
assert.ok(r.j.rows.some(x => x.g === SGID && x.stCcu === 321 && x.stPos === 90), 'steam players and reviews');
assert.ok(r.j.rows.some(x => x.g === SGID && x.stUnits === 12 && x.stNet === 150 && x.stRet === 1), 'steam sales by app');
assert.ok(!JSON.stringify(mem.docs.get('secrets/keys')).includes('ABCDEF0123456789'), 'steam key encrypted');

// --- autofilled logins are refused ---
assert.equal((await call('POST', '/api/integrations/google', 'ownerMfa', { values: { GOOGLE_CLIENT_ID: 'it@kinbss.org' } })).s, 400);
assert.equal((await call('POST', '/api/integrations/google', 'ownerMfa', { values: { GOOGLE_CLIENT_SECRET: 'MyPassw0rdCo1@' } })).s, 400);
assert.equal((await call('POST', '/api/integrations/google', 'ownerMfa', { values: { GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuv' }, test: false })).s, 200);

// --- request hardening ---
r = await handle(new Request('https://nest.example.com/api/team/invites', { method: 'POST', headers: { authorization: 'Bearer ownerMfa.p.s', 'content-type': 'text/plain' }, body: 'x' }));
assert.equal(r.status, 415);
r = await handle(new Request('https://nest.example.com/api/team/invites', { method: 'POST', headers: { authorization: 'Bearer ownerMfa.p.s', 'content-type': 'application/json' }, body: 'x'.repeat(70000) }));
assert.equal(r.status, 413);
assert.equal((await call('GET', '/api/nope', 'owner')).s, 404);
console.log('API, auth, team, integrations, discover and sync tests passed ✓');
