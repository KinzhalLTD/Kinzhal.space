// "Sign in with Google" / "Connect RevenueCat" for the data connections (not for logging into Kinzhal Nest).
// The browser asks the API for a sign-in URL (with its Firebase token), then leaves for Google/RevenueCat.
// The `state` parameter is HMAC-signed with APP_SECRET and points to a one-time Firestore record holding the PKCE verifier.
import crypto from 'node:crypto';
import { env, siteUrl } from './config.js';
import { db } from './db.js';
import { googleScopes, googleClientReady } from './google.js';
import { snapClientReady, snapTokenRequest, SNAP_SCOPE, snapAdAccounts } from './connectors/ads.js';
import { RC_SCOPES, rcOauthClientReady, rcTokenRequest } from './connectors/revenuecat.js';
import { saveSettings, loadSettings } from './settings.js';

const TTL = 10 * 60_000;
const hmac = s => crypto.createHmac('sha256', process.env.APP_SECRET || '').update(s).digest('base64url');
export const redirectUri = (req, p) => `${siteUrl(req)}/api/oauth/${p}/callback`;

export function signState(o) { const body = Buffer.from(JSON.stringify(o)).toString('base64url'); return body + '.' + hmac(body); }
export function readState(s) {
  const [body, sig] = String(s || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return o.exp > Date.now() ? o : null; } catch { return null; }
}

export async function startOAuth(req, provider, uid) {
  await loadSettings();
  if (!(process.env.APP_SECRET || '').length) throw new Error('APP_SECRET is missing');
  const n = crypto.randomBytes(16).toString('hex'), verifier = crypto.randomBytes(48).toString('base64url');
  const exp = Date.now() + TTL;
  await db().set(`oauthStates/${n}`, { uid, provider, verifier, exp });
  const state = signState({ n, p: provider, u: uid, exp });
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (provider === 'google') {
    if (!googleClientReady()) throw new Error('Paste the Google OAuth Client ID and Client secret first');
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: redirectUri(req, 'google'), response_type: 'code',
      scope: googleScopes().join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      state, code_challenge: challenge, code_challenge_method: 'S256'
    });
  }
  if (provider === 'revenuecat') {
    if (!rcOauthClientReady()) throw new Error('Add the RevenueCat OAuth Client ID and secret first (Advanced)');
    return 'https://api.revenuecat.com/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: env('RC_OAUTH_CLIENT_ID'), redirect_uri: redirectUri(req, 'revenuecat'), scope: RC_SCOPES, state,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
  }
  if (provider === 'snapchat') {
    if (!snapClientReady()) throw new Error('Paste the Snapchat OAuth Client ID and secret first');
    return 'https://accounts.snapchat.com/login/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: env('SNAP_CLIENT_ID'), redirect_uri: redirectUri(req, 'snapchat'), scope: SNAP_SCOPE, state
    });
  }
  throw new Error('Unknown provider');
}

/** Returns the URL to send the browser back to. */
export async function finishOAuth(req, provider, url, isOwner) {
  const back = (ok, msg) => `${siteUrl(req)}/#conn=${provider}:${ok ? 'ok' : 'err'}${msg ? ':' + encodeURIComponent(String(msg).slice(0, 160)) : ''}`;
  const st = readState(url.searchParams.get('state'));
  if (!st || st.p !== provider) return back(false, 'Sign-in session expired. Try again.');
  const rec = await db().tx(async t => { const r = await t.get(`oauthStates/${st.n}`); if (r) await t.del(`oauthStates/${st.n}`); return r; });
  if (!rec || rec.uid !== st.u || rec.exp < Date.now()) return back(false, 'Sign-in session expired. Try again.');
  if (!(await isOwner(rec.uid))) return back(false, 'Only the owner can connect accounts.');
  if (url.searchParams.get('error')) return back(false, url.searchParams.get('error'));
  const code = url.searchParams.get('code') || '';
  await loadSettings();
  try {
    if (provider === 'google') {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: redirectUri(req, 'google'), grant_type: 'authorization_code', code_verifier: rec.verifier })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
      await saveSettings({ GOOGLE_REFRESH_TOKEN: j.refresh_token });
    } else if (provider === 'snapchat') {
      const j = await snapTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req, 'snapchat') });
      if (!j.refresh_token) throw new Error('Snapchat did not return a refresh token');
      await saveSettings({ SNAP_REFRESH_TOKEN: j.refresh_token });
      await loadSettings();
      if (!env('SNAP_AD_ACCOUNT_ID')) { const acc = await snapAdAccounts().catch(() => []); if (acc.length === 1) await saveSettings({ SNAP_AD_ACCOUNT_ID: acc[0].id }); }
    } else {
      await rcTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req, 'revenuecat'), code_verifier: rec.verifier });
    }
    return back(true);
  } catch (e) { return back(false, e.message); }
}
