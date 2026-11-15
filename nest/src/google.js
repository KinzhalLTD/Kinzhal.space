// Google APIs (Firebase/GA4, BigQuery for Crashlytics, Firebase Management, AdMob).
// Two ways to authenticate, chosen in Connections → Google:
//   • Service account (recommended for many games): the central Kinzhal Nest service account
//     (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY, already in Netlify) gets read-only IAM roles on each game
//     project and Viewer access in Google Analytics. No JSON file per game, nothing that expires.
//   • Google sign-in (OAuth): one person's Google account. Required for AdMob — the AdMob API does not accept
//     service accounts.
import { SignJWT, importPKCS8 } from 'jose';
import { env } from './config.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/admob.readonly',
  'https://www.googleapis.com/auth/admob.report',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/firebase.readonly'
];
/** Google Ads needs one more scope, asked only once a Google Ads developer token is saved. */
export const googleScopes = () => env('GADS_DEVELOPER_TOKEN') ? [...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/adwords'] : GOOGLE_SCOPES;
const SA_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/firebase.readonly',
  'https://www.googleapis.com/auth/cloud-platform.read-only'
];

export const googleClientReady = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
export const googleOAuthReady = () => googleClientReady() && !!env('GOOGLE_REFRESH_TOKEN');
export const saEmail = () => String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
const saKey = () => { let k = String(process.env.FIREBASE_PRIVATE_KEY || ''); if (k && !k.includes('BEGIN')) k = Buffer.from(k, 'base64').toString('utf8'); return k.replace(/\\n/g, '\n'); };
export const saAvailable = () => !!(saEmail() && saKey().includes('PRIVATE KEY'));
export const saMode = () => env('GOOGLE_USE_SA') === '1' && saAvailable();
/** Analytics, Firebase and BigQuery are reachable (by service account or sign-in). */
export const googleConfigured = () => saMode() || googleOAuthReady();
/** AdMob needs a person's Google sign-in. */
export const admobReady = () => googleOAuthReady();

let cache = { token: '', exp: 0, rt: '' };
export async function googleToken() {
  if (cache.token && cache.rt === env('GOOGLE_REFRESH_TOKEN') && Date.now() < cache.exp - 60_000) return cache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'), grant_type: 'refresh_token'
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google sign-in failed (${j.error || r.status}): ${j.error_description || 'connect your Google account again in Kinzhal Nest → Connections'}`);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, rt: env('GOOGLE_REFRESH_TOKEN') };
  return cache.token;
}

let saCache = { token: '', exp: 0 };
/** Access token for the central service account (JWT bearer grant, RS256). */
export async function saToken() {
  if (saCache.token && Date.now() < saCache.exp - 60_000) return saCache.token;
  if (!saAvailable()) throw new Error('The service account is not set (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in Netlify)');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SA_SCOPES.join(' ') })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saEmail()).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(await importPKCS8(saKey(), 'RS256'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Service account sign-in failed (${j.error || r.status}): ${j.error_description || 'check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY'}`);
  saCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return saCache.token;
}

const isAdmob = url => /admob\.googleapis\.com/.test(url);
/** Authenticated Google API call. POST when body is given. AdMob always uses the Google sign-in. */
export async function gfetch(url, body) {
  const useSa = saMode() && !isAdmob(url);
  if (isAdmob(url) && !googleOAuthReady()) throw new Error('AdMob needs “Sign in with Google” (the AdMob API does not accept service accounts)');
  const tok = useSa ? await saToken() : await googleToken();
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = txt; }
  if (!r.ok) {
    let msg = typeof j === 'string' ? j : (j?.error?.message || j?.[0]?.error?.message || JSON.stringify(j));
    if (useSa && (r.status === 403 || r.status === 401)) msg += ` — give ${saEmail()} access (see Academy → API integrations → Service account)`;
    throw new Error(`${new URL(url).host} ${r.status}: ${String(msg).slice(0, 400)}`);
  }
  return j;
}
