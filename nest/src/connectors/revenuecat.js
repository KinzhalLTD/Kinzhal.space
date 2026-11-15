// RevenueCat REST API v2. Auth: a secret API key (simplest), or a RevenueCat account connected through OAuth sign-in.
import { env } from '../config.js';
import { sleep } from '../util.js';
import { saveSettings } from '../settings.js';

export const RC_SCOPES = 'charts_metrics:overview:read charts_metrics:charts:read project_configuration:projects:read project_configuration:apps:read';
export const rcOauthClientReady = () => !!(env('RC_OAUTH_CLIENT_ID') && env('RC_OAUTH_CLIENT_SECRET'));
export const rcConfigured = () => !!env('REVENUECAT_API_KEY') || (rcOauthClientReady() && !!env('RC_REFRESH_TOKEN'));
const basic = () => 'Basic ' + Buffer.from(`${env('RC_OAUTH_CLIENT_ID')}:${env('RC_OAUTH_CLIENT_SECRET')}`).toString('base64');

/** Exchange an authorization code (sign-in) or a refresh token for a new token pair, and save it encrypted. */
export async function rcTokenRequest(params) {
  const r = await fetch('https://api.revenuecat.com/oauth2/token', {
    method: 'POST',
    headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`RevenueCat sign-in ${r.status}: ${j.error_description || j.error || 'token request failed'}${j.error === 'invalid_grant' ? ' — connect RevenueCat again' : ''}`);
  await saveSettings({ RC_ACCESS_TOKEN: j.access_token, RC_REFRESH_TOKEN: j.refresh_token || env('RC_REFRESH_TOKEN'), RC_TOKEN_EXP: String(Date.now() + (j.expires_in || 3600) * 1000) });
  return j.access_token;
}

let refreshing = null; // one refresh at a time: RevenueCat rotates (and revokes) the old pair on every refresh
async function bearer() {
  if (env('REVENUECAT_API_KEY')) return env('REVENUECAT_API_KEY');
  if (!rcConfigured()) throw new Error('RevenueCat is not connected');
  if (env('RC_ACCESS_TOKEN') && Date.now() < Number(env('RC_TOKEN_EXP', '0')) - 60_000) return env('RC_ACCESS_TOKEN');
  refreshing ||= rcTokenRequest({ grant_type: 'refresh_token', refresh_token: env('RC_REFRESH_TOKEN') }).finally(() => { refreshing = null; });
  return refreshing;
}

export async function rcGet(pathAndQuery, tries = 0) {
  const r = await fetch('https://api.revenuecat.com/v2' + pathAndQuery, { headers: { authorization: 'Bearer ' + await bearer(), accept: 'application/json' } });
  if (r.status === 429 && tries < 2) { await sleep(1500 * (tries + 1)); return rcGet(pathAndQuery, tries + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`RevenueCat ${r.status}: ${j.message || j.type || 'request failed'}`);
  return j;
}

export async function rcRevenue(projectId, date) {
  const q = new URLSearchParams({ start_date: date, end_date: date, currency: 'USD', revenue_type: env('REVENUECAT_REVENUE_TYPE', 'revenue_net_of_taxes') });
  const j = await rcGet(`/projects/${encodeURIComponent(projectId)}/metrics/revenue?${q}`);
  return Number(j.value) || 0;
}

/** All pages of a v2 list endpoint (items + next_page). */
export async function rcList(path, max = 500) {
  const out = []; let next = path + (path.includes('?') ? '&' : '?') + 'limit=100';
  while (next && out.length < max) {
    const j = await rcGet(next);
    out.push(...(j.items || []));
    next = j.next_page ? String(j.next_page).replace(/^https?:\/\/[^/]+\/v2/, '') : null;
  }
  return out;
}
