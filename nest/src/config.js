// Runtime configuration.
// Netlify environment variables hold only the infrastructure secrets (Firebase service account, APP_SECRET, OWNER_EMAIL).
// Every API key pasted inside Kinzhal Nest is stored encrypted in Firestore and loaded into `platform` per request.
const platform = { values: {}, games: [] };
export function setPlatform(values, games) { platform.values = values || {}; platform.games = Array.isArray(games) ? games : []; }
const clean = v => (v == null ? '' : String(v).trim());
/** A key pasted in the platform, or (if you prefer) the same name set as a Netlify environment variable. */
export const env = (k, d = '') => clean(process.env[k]) || clean(platform.values[k]) || d;
export const envSource = k => clean(process.env[k]) ? 'netlify' : clean(platform.values[k]) ? 'platform' : null;

/** Games with their service IDs (saved from Connections → Game IDs or Discover). */
export const loadGames = () => ({ games: platform.games.filter(g => g && /^[a-z0-9-]+$/.test(g.id || '')) });

/** App Store Connect private key: raw PEM (with real or "\n" newlines) or base64. */
export function ascPrivateKey() {
  const b64 = env('ASC_PRIVATE_KEY_BASE64');
  if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  return env('ASC_PRIVATE_KEY').replace(/\\n/g, '\n');
}

/** Public site address, used for OAuth redirect URIs. */
export function siteUrl(req) {
  const fromEnv = clean(process.env.SITE_URL) || clean(process.env.URL);
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  try { const u = new URL(req.url); return u.origin; } catch { return ''; }
}

/** Store country for ratings (default Saudi Arabia). */
export const storeCountry = () => env('STORE_COUNTRY', 'sa').toLowerCase().slice(0, 2);
