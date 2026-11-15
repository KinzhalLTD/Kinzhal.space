// App Store Connect API: daily Sales summary report (gzip TSV) -> first-time downloads per app.
import zlib from 'node:zlib';
import { SignJWT, importPKCS8 } from 'jose';
import { env, ascPrivateKey } from '../config.js';

export const ascConfigured = () => !!(env('ASC_ISSUER_ID') && env('ASC_KEY_ID') && env('ASC_VENDOR_NUMBER') && ascPrivateKey());

let tok = { v: '', exp: 0, id: '' };
async function ascToken() {
  const id = env('ASC_KEY_ID') + env('ASC_ISSUER_ID');
  if (tok.v && tok.id === id && Date.now() < tok.exp - 60_000) return tok.v;
  const key = await importPKCS8(ascPrivateKey(), 'ES256');
  const v = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env('ASC_KEY_ID'), typ: 'JWT' })
    .setIssuer(env('ASC_ISSUER_ID')).setIssuedAt().setExpirationTime('15m').setAudience('appstoreconnect-v1')
    .sign(key);
  tok = { v, exp: Date.now() + 15 * 60_000, id };
  return v;
}

/** Any App Store Connect API JSON resource, e.g. /v1/apps */
export async function ascGet(pathAndQuery) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + pathAndQuery, { headers: { authorization: 'Bearer ' + await ascToken(), accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`App Store Connect ${r.status}: ${j.errors?.[0]?.detail || j.errors?.[0]?.title || 'request failed'}`);
  return j;
}

export async function ascPost(path, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, { method: 'POST', headers: { authorization: 'Bearer ' + await ascToken(), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}

/** Returns { appleId: units } for one day, or null when Apple has not published that day yet. */
export async function ascDownloads(date) {
  const q = new URLSearchParams({
    'filter[frequency]': 'DAILY', 'filter[reportType]': 'SALES', 'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': env('ASC_VENDOR_NUMBER'), 'filter[reportDate]': date,
    'filter[version]': env('ASC_SALES_VERSION', '1_0')
  });
  const r = await fetch('https://api.appstoreconnect.apple.com/v1/salesReports?' + q, {
    headers: { authorization: 'Bearer ' + await ascToken(), accept: 'application/a-gzip' }
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const t = await r.text();
    if (/vendorNumber/i.test(t)) throw new Error(`Apple refused Vendor number ${env('ASC_VENDOR_NUMBER')}. Check: 1) it matches App Store Connect → Payments and Financial Reports (top left); 2) the API key's access is Admin, Finance or Sales (Users and Access → Integrations); 3) the Paid Apps agreement is active (Business → Agreements).`);
    throw new Error(`App Store Connect ${r.status}: ${t.slice(0, 300)}`);
  }
  return parseSales(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
}

// First-time app downloads (not updates "7", not re-downloads, not in-app purchases).
const DOWNLOAD_TYPES = new Set(['1', '1F', '1T', '1E', '1EP', '1EU', 'F1']);
export function parseSales(tsv) {
  const lines = tsv.trim().split(/\r?\n/);
  const h = lines[0].split('\t');
  const iA = h.indexOf('Apple Identifier'), iU = h.indexOf('Units'), iT = h.indexOf('Product Type Identifier');
  if (iA < 0 || iU < 0 || iT < 0) throw new Error('Unexpected sales report columns: ' + h.join(', '));
  const out = {};
  for (const l of lines.slice(1)) {
    const c = l.split('\t');
    if (!DOWNLOAD_TYPES.has((c[iT] || '').trim())) continue;
    out[c[iA]] = (out[c[iA]] || 0) + (Number(c[iU]) || 0);
  }
  return out;
}
