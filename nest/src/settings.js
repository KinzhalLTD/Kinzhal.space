// API keys pasted inside Kinzhal Nest: AES-256-GCM encrypted in Firestore (secrets/keys), decrypted only inside the function.
// Firestore security rules deny every browser read of /secrets, and the API only ever returns a masked hint.
import crypto from 'node:crypto';
import { env, envSource, setPlatform } from './config.js';
import { db } from './db.js';
import { getKV, setKV } from './store.js';

// service: which integration a key belongs to (used by the simplified API: POST /api/integrations/:service)
export const FIELDS = {
  GOOGLE_CLIENT_ID: { service: 'google' }, GOOGLE_CLIENT_SECRET: { service: 'google', secret: true },
  GOOGLE_REFRESH_TOKEN: { service: 'google', secret: true, internal: true },
  GOOGLE_USE_SA: { service: 'google' },
  ADMOB_PUBLISHER_ID: { service: 'google', auto: true }, BIGQUERY_PROJECT: { service: 'google', auto: true },
  ASC_ISSUER_ID: { service: 'apple' }, ASC_KEY_ID: { service: 'apple' }, ASC_VENDOR_NUMBER: { service: 'apple' },
  ASC_PRIVATE_KEY: { service: 'apple', secret: true, multiline: true }, ASC_SALES_VERSION: { service: 'apple', advanced: true },
  REVENUECAT_API_KEY: { service: 'revenuecat', secret: true },
  RC_OAUTH_CLIENT_ID: { service: 'revenuecat', advanced: true }, RC_OAUTH_CLIENT_SECRET: { service: 'revenuecat', secret: true, advanced: true },
  RC_ACCESS_TOKEN: { service: 'revenuecat', secret: true, internal: true }, RC_REFRESH_TOKEN: { service: 'revenuecat', secret: true, internal: true },
  RC_TOKEN_EXP: { service: 'revenuecat', internal: true },
  STORE_COUNTRY: { service: 'ratings', advanced: true },
  // ad networks (Marketing → Ad accounts)
  ASA_CLIENT_ID: { service: 'searchads' }, ASA_TEAM_ID: { service: 'searchads' }, ASA_KEY_ID: { service: 'searchads' }, ASA_ORG_ID: { service: 'searchads' },
  ASA_PRIVATE_KEY: { service: 'searchads', secret: true, multiline: true },
  SNAP_CLIENT_ID: { service: 'snapchat' }, SNAP_CLIENT_SECRET: { service: 'snapchat', secret: true }, SNAP_AD_ACCOUNT_ID: { service: 'snapchat' },
  SNAP_REFRESH_TOKEN: { service: 'snapchat', secret: true, internal: true },
  TIKTOK_ACCESS_TOKEN: { service: 'tiktok', secret: true }, TIKTOK_ADVERTISER_ID: { service: 'tiktok' }, TIKTOK_INSTALL_METRIC: { service: 'tiktok', advanced: true },
  META_ACCESS_TOKEN: { service: 'meta', secret: true }, META_AD_ACCOUNT_ID: { service: 'meta' }, META_API_VERSION: { service: 'meta', advanced: true },
  GADS_DEVELOPER_TOKEN: { service: 'googleads', secret: true }, GADS_CUSTOMER_ID: { service: 'googleads' }, GADS_LOGIN_CUSTOMER_ID: { service: 'googleads', advanced: true }, GADS_API_VERSION: { service: 'googleads', advanced: true },
  // Steam (Steamworks → Users & Permissions → Manage Groups → Financial API group)
  STEAM_FINANCIAL_KEY: { service: 'steam', secret: true },
  // AI analyst
  ANTHROPIC_API_KEY: { service: 'ai', secret: true }, AI_MODEL: { service: 'ai', advanced: true }
};
export const SERVICES = ['google', 'apple', 'revenuecat', 'ratings', 'searchads', 'snapchat', 'tiktok', 'meta', 'googleads', 'ai', 'steam'];
export const GAME_FIELDS = ['id', 'name', 'steamAppId', 'ga4PropertyId', 'ga4StreamId', 'ga4LevelDimension', 'ga4LevelEvent', 'admobAppId', 'ascAppleId', 'appStoreId', 'revenuecatProjectId', 'crashlyticsTable'];

function cryptoKey() {
  const base = process.env.APP_SECRET || '';
  if (base.length < 32) throw new Error('Set APP_SECRET (at least 32 random characters) in Netlify environment variables');
  return crypto.scryptSync(base, 'kinzhal-nest/settings/v1', 32);
}
export const enc = v => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const d = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
};
export const dec = s => {
  const [iv, tag, d] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
};

let unreadable = [];
export async function loadSettings() {
  const raw = (await db().get('secrets/keys'))?.v || {};
  const vals = {}; unreadable = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELDS[k]) continue;
    try { vals[k] = dec(v); } catch { unreadable.push(k); } // APP_SECRET changed since saving
  }
  const games = await getKV('games');
  setPlatform(vals, Array.isArray(games) ? games : []);
  return vals;
}

/** values: { KEY: 'new value' | null (remove) }. Empty strings are ignored. */
export async function saveSettings(values) {
  const cur = (await db().get('secrets/keys'))?.v || {};
  const raw = { ...cur };
  for (const [k, v] of Object.entries(values || {})) {
    if (!FIELDS[k]) continue;
    if (v === null) { delete raw[k]; continue; }
    const s = String(v).trim();
    if (!s) continue;
    if (s.length > 8000) throw new Error(`${k} is too long`);
    raw[k] = enc(FIELDS[k].multiline ? s.replace(/\\n/g, '\n') : s.replace(/\s+/g, ''));
  }
  await db().set('secrets/keys', { v: raw, at: new Date().toISOString() });
  return loadSettings();
}

/** Remove every key of one service (Disconnect). */
export async function clearService(service) {
  const values = {};
  for (const [k, f] of Object.entries(FIELDS)) if (f.service === service) values[k] = null;
  return saveSettings(values);
}

export async function saveGames(games) {
  if (!Array.isArray(games)) throw new Error('games must be a list');
  if (games.length > 200) throw new Error('Too many games');
  const seen = new Set(), out = [];
  for (const g of games) {
    const o = {};
    for (const f of GAME_FIELDS) o[f] = String(g?.[f] ?? '').trim().slice(0, 200);
    if (!o.id) continue;
    if (!/^[a-z0-9-]+$/.test(o.id)) throw new Error(`Game id "${o.id}" may use only a–z, 0–9 and -`);
    if (seen.has(o.id)) throw new Error(`Game id "${o.id}" is used twice`);
    if (!o.appStoreId) o.appStoreId = o.ascAppleId;
    if (!o.ga4LevelEvent) o.ga4LevelEvent = 'level_start';
    if (o.crashlyticsTable && !/^[\w-]+(\.[\w-]+){1,2}$/.test(o.crashlyticsTable)) throw new Error(`Crashlytics table for "${o.id}" looks wrong`);
    seen.add(o.id); out.push(o);
  }
  await setKV('games', out);
  return loadSettings();
}

/** What the browser may see: where each value comes from and a masked hint, never a secret. */
export function settingsStatus() {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const src = envSource(k), v = env(k);
    out[k] = {
      service: f.service, secret: !!f.secret, multiline: !!f.multiline, advanced: !!f.advanced, internal: !!f.internal, auto: !!f.auto,
      source: src, unreadable: unreadable.includes(k),
      hint: !src ? null : f.multiline ? '•••• (key saved)' : f.secret ? '••••' + (v.length > 12 ? v.slice(-4) : '') : v
    };
  }
  return out;
}

/** Key ID from an App Store Connect key file name: AuthKey_ABCDE12345.p8 */
export const keyIdFromFileName = n => (String(n || '').match(/AuthKey_([A-Z0-9]{8,12})\.p8$/i) || [])[1]?.toUpperCase() || '';
