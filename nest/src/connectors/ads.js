// Ad networks: daily spend, impressions, clicks and installs per campaign.
// Every network returns the same row shape: { net, cid, cname, app, d, spend, imp, clk, inst, cur }.
//   Apple Search Ads  client credentials (ES256 client secret)   api.searchads.apple.com  /api/v5/reports/campaigns
//   Snapchat          OAuth refresh token (Connect Snapchat)      adsapi.snapchat.com      /v1/campaigns/{id}/stats
//   TikTok            long-lived access token                     business-api.tiktok.com  /open_api/v1.3/report/integrated/get/
//   Meta              system-user access token                    graph.facebook.com       /act_{id}/insights
//   Google Ads        Google sign-in + developer token            googleads.googleapis.com googleAds:searchStream
import { SignJWT, importPKCS8 } from 'jose';
import { env } from '../config.js';
import { googleOAuthReady, googleToken } from '../google.js';
import { addDays, dateRange } from '../util.js';

const n = v => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const pem = s => String(s || '').replace(/\\n/g, '\n');
async function jget(url, opt = {}, what = 'request') {
  const r = await fetch(url, opt);
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${what} ${r.status}: ${pickErr(j)}`);
  return j;
}
const pickErr = j => j?.error?.message || j?.error?.errors?.[0]?.message || j?.error_description || j?.message || j?.debug_message
  || j?.error?.[0]?.message || (typeof j?.error === 'string' ? j.error : '') || j?.raw || 'request failed';

/* ---------------- Apple Search Ads ---------------- */
export const asaConfigured = () => !!(env('ASA_CLIENT_ID') && env('ASA_TEAM_ID') && env('ASA_KEY_ID') && env('ASA_PRIVATE_KEY') && env('ASA_ORG_ID'));
let asaTok = { v: '', exp: 0, id: '' };
async function asaToken() {
  const id = env('ASA_CLIENT_ID') + env('ASA_KEY_ID');
  if (asaTok.v && asaTok.id === id && Date.now() < asaTok.exp - 120_000) return asaTok.v;
  const key = await importPKCS8(pem(env('ASA_PRIVATE_KEY')).replace('BEGIN EC PRIVATE KEY', 'BEGIN PRIVATE KEY').replace('END EC PRIVATE KEY', 'END PRIVATE KEY'), 'ES256');
  const secret = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: env('ASA_KEY_ID') })
    .setSubject(env('ASA_CLIENT_ID')).setIssuer(env('ASA_TEAM_ID')).setAudience('https://appleid.apple.com')
    .setIssuedAt().setExpirationTime('1h').sign(key);
  const j = await jget('https://appleid.apple.com/auth/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('ASA_CLIENT_ID'), client_secret: secret, scope: 'searchadsorg' })
  }, 'Apple Search Ads sign-in');
  asaTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, id };
  return asaTok.v;
}
export async function asaReport(start, end) {
  const tok = await asaToken(), out = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const j = await jget('https://api.searchads.apple.com/api/v5/reports/campaigns', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tok, 'x-ap-context': 'orgId=' + env('ASA_ORG_ID'), 'content-type': 'application/json' },
      body: JSON.stringify({
        startTime: start, endTime: end, granularity: 'DAILY', timeZone: 'UTC',
        selector: { orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }], pagination: { offset, limit: 1000 } },
        returnRecordsWithNoMetrics: false, returnRowTotals: false, returnGrandTotals: false
      })
    }, 'Apple Search Ads');
    const rows = j?.data?.reportingDataResponse?.row || [];
    for (const r of rows) {
      const m = r.metadata || {};
      for (const g of r.granularity || []) {
        out.push({ net: 'asa', cid: String(m.campaignId ?? ''), cname: m.campaignName || '', app: String(m.app?.adamId ?? m.adamId ?? ''), d: g.date,
          spend: n(g.localSpend?.amount), cur: g.localSpend?.currency || '', imp: n(g.impressions), clk: n(g.taps), inst: n(g.totalInstalls ?? g.tapInstalls ?? g.installs) });
      }
    }
    const total = j?.pagination?.totalResults ?? rows.length;
    if (offset + 1000 >= total) break;
  }
  return out;
}

/* ---------------- Snapchat ---------------- */
export const snapClientReady = () => !!(env('SNAP_CLIENT_ID') && env('SNAP_CLIENT_SECRET'));
export const snapConfigured = () => snapClientReady() && !!env('SNAP_REFRESH_TOKEN') && !!env('SNAP_AD_ACCOUNT_ID');
export const SNAP_SCOPE = 'snapchat-marketing-api';
let snapTok = { v: '', exp: 0, rt: '' };
export async function snapTokenRequest(params) {
  const j = await jget('https://accounts.snapchat.com/login/oauth2/access_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('SNAP_CLIENT_ID'), client_secret: env('SNAP_CLIENT_SECRET'), ...params })
  }, 'Snapchat sign-in');
  return j;
}
async function snapToken() {
  if (snapTok.v && snapTok.rt === env('SNAP_REFRESH_TOKEN') && Date.now() < snapTok.exp - 60_000) return snapTok.v;
  const j = await snapTokenRequest({ grant_type: 'refresh_token', refresh_token: env('SNAP_REFRESH_TOKEN') });
  snapTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000, rt: env('SNAP_REFRESH_TOKEN') };
  return snapTok.v;
}
const snapGet = async p => jget('https://adsapi.snapchat.com/v1' + p, { headers: { authorization: 'Bearer ' + await snapToken() } }, 'Snapchat');
export async function snapAdAccounts() {
  const me = await snapGet('/me/organizations?with_ad_accounts=true');
  const out = [];
  for (const o of me.organizations || []) for (const a of o.organization?.ad_accounts || []) out.push({ id: a.id, name: a.name, timezone: a.timezone, currency: a.currency });
  return out;
}
/** Midnight of a calendar day in an IANA time zone, as an ISO string with its offset. */
export function zonedMidnight(day, tz) {
  const guess = new Date(day + 'T00:00:00Z');
  let off = 0;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).map(x => [x.type, x.value]));
    off = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess.getTime()) / 60000;
  } catch { off = 0; }
  const s = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${day}T00:00:00.000${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export async function snapReport(start, end) {
  const acc = env('SNAP_AD_ACCOUNT_ID');
  const info = await snapGet(`/adaccounts/${acc}`);
  const a = info.adaccounts?.[0]?.adaccount || {}, tz = a.timezone || 'UTC', cur = a.currency || '';
  const camps = (await snapGet(`/adaccounts/${acc}/campaigns`)).campaigns?.map(x => x.campaign) || [];
  const out = [];
  const q = new URLSearchParams({ granularity: 'DAY', fields: 'impressions,swipes,spend,total_installs', start_time: zonedMidnight(start, tz), end_time: zonedMidnight(addDays(end, 1), tz) });
  for (const c of camps.filter(c => c && c.status !== 'DELETED')) {
    const j = await snapGet(`/campaigns/${c.id}/stats?` + q);
    const ts = j.timeseries_stats?.[0]?.timeseries_stat?.timeseries || [];
    for (const t of ts) {
      const s = t.stats || {}; if (!s.spend && !s.impressions) continue;
      out.push({ net: 'snap', cid: c.id, cname: c.name || '', app: '', d: String(t.start_time).slice(0, 10), spend: n(s.spend) / 1e6, cur, imp: n(s.impressions), clk: n(s.swipes), inst: n(s.total_installs) });
    }
  }
  return out;
}

/* ---------------- TikTok ---------------- */
export const tiktokConfigured = () => !!(env('TIKTOK_ACCESS_TOKEN') && env('TIKTOK_ADVERTISER_ID'));
export async function tiktokReport(start, end) {
  const instMetric = env('TIKTOK_INSTALL_METRIC', 'app_install');
  const run = async metrics => {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({
        advertiser_id: env('TIKTOK_ADVERTISER_ID'), report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', service_type: 'AUCTION',
        dimensions: JSON.stringify(['campaign_id', 'stat_time_day']), metrics: JSON.stringify(metrics),
        start_date: start, end_date: end, page: String(page), page_size: '1000'
      });
      const j = await jget('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + q, { headers: { 'Access-Token': env('TIKTOK_ACCESS_TOKEN') } }, 'TikTok');
      if (j.code !== 0) throw new Error(`TikTok ${j.code}: ${j.message || 'request failed'}`);
      for (const r of j.data?.list || []) {
        const d = r.dimensions || {}, m = r.metrics || {};
        out.push({ net: 'tiktok', cid: String(d.campaign_id || ''), cname: m.campaign_name || '', app: '', d: String(d.stat_time_day || '').slice(0, 10), spend: n(m.spend), cur: m.currency || '', imp: n(m.impressions), clk: n(m.clicks), inst: n(m[instMetric] ?? m.conversion) });
      }
      const pi = j.data?.page_info; if (!pi || page >= (pi.total_page || 1)) break;
    }
    return out;
  };
  try { return await run(['spend', 'impressions', 'clicks', 'campaign_name', instMetric]); }
  catch (e) { if (/metric|field/i.test(e.message)) return run(['spend', 'impressions', 'clicks', 'campaign_name', 'conversion']); throw e; }
}

/* ---------------- Meta (Facebook / Instagram) ---------------- */
export const metaConfigured = () => !!(env('META_ACCESS_TOKEN') && env('META_AD_ACCOUNT_ID'));
const metaAct = () => 'act_' + env('META_AD_ACCOUNT_ID').replace(/^act_/, '');
const INSTALL_ACTIONS = ['mobile_app_install', 'app_install', 'omni_app_install'];
export async function metaReport(start, end) {
  const v = env('META_API_VERSION', 'v23.0'), out = [];
  let url = `https://graph.facebook.com/${v}/${metaAct()}/insights?` + new URLSearchParams({
    level: 'campaign', time_increment: '1', limit: '500', fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency',
    time_range: JSON.stringify({ since: start, until: end }), access_token: env('META_ACCESS_TOKEN')
  });
  for (let i = 0; url && i < 20; i++) {
    const j = await jget(url, {}, 'Meta');
    for (const r of j.data || []) {
      const acts = Object.fromEntries((r.actions || []).map(a => [a.action_type, n(a.value)]));
      const inst = INSTALL_ACTIONS.map(k => acts[k]).find(x => x != null) || 0;
      out.push({ net: 'meta', cid: String(r.campaign_id || ''), cname: r.campaign_name || '', app: '', d: r.date_start, spend: n(r.spend), cur: r.account_currency || '', imp: n(r.impressions), clk: n(r.clicks), inst });
    }
    url = j.paging?.next || '';
  }
  return out;
}

/* ---------------- Google Ads ---------------- */
export const gadsConfigured = () => googleOAuthReady() && !!(env('GADS_DEVELOPER_TOKEN') && env('GADS_CUSTOMER_ID'));
const cid = s => String(s || '').replace(/\D/g, '');
export async function gadsReport(start, end) {
  const v = env('GADS_API_VERSION', 'v21');
  const headers = { authorization: 'Bearer ' + await googleToken(), 'developer-token': env('GADS_DEVELOPER_TOKEN'), 'content-type': 'application/json' };
  if (env('GADS_LOGIN_CUSTOMER_ID')) headers['login-customer-id'] = cid(env('GADS_LOGIN_CUSTOMER_ID'));
  const query = `SELECT segments.date, campaign.id, campaign.name, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}' AND metrics.impressions > 0`;
  const j = await jget(`https://googleads.googleapis.com/${v}/customers/${cid(env('GADS_CUSTOMER_ID'))}/googleAds:searchStream`, { method: 'POST', headers, body: JSON.stringify({ query }) }, 'Google Ads');
  const out = [];
  for (const batch of Array.isArray(j) ? j : [j]) for (const r of batch.results || []) {
    out.push({ net: 'gads', cid: String(r.campaign?.id || ''), cname: r.campaign?.name || '', app: '', d: r.segments?.date, spend: n(r.metrics?.costMicros) / 1e6, cur: r.customer?.currencyCode || '', imp: n(r.metrics?.impressions), clk: n(r.metrics?.clicks), inst: Math.round(n(r.metrics?.conversions)) });
  }
  return out;
}

export const NETS = {
  asa: { name: 'Apple Search Ads', ready: asaConfigured, report: asaReport, maxDays: 90 },
  snap: { name: 'Snapchat', ready: snapConfigured, report: snapReport, maxDays: 31 },
  tiktok: { name: 'TikTok', ready: tiktokConfigured, report: tiktokReport, maxDays: 30 },
  meta: { name: 'Meta', ready: metaConfigured, report: metaReport, maxDays: 90 },
  gads: { name: 'Google Ads', ready: gadsConfigured, report: gadsReport, maxDays: 90 }
};

/* ---------------- matching campaigns to games ---------------- */
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** map: { 'net:cid': gameId } set by hand; then the App Store ID (Apple Search Ads); then the game name inside the campaign name. */
export function gameForCampaign(row, games, map = {}) {
  const k = `${row.net}:${row.cid}`;
  if (map[k] !== undefined) return map[k] || null;
  if (row.app) { const g = games.find(x => String(x.ascAppleId || x.appStoreId || '') === String(row.app)); if (g) return g.id; }
  const c = ' ' + norm(row.cname) + ' ';
  let best = null, len = 0;
  for (const g of games) for (const cand of [g.name, g.id.replace(/-/g, ' ')]) {
    const w = norm(cand); if (w.length >= 3 && c.includes(' ' + w + ' ') && w.length > len) { best = g.id; len = w.length; }
  }
  return best;
}

/* ---------------- CSV exported from any ad manager ---------------- */
const HDR = {
  d: ['date', 'day', 'reporting starts', 'reporting start', 'stat_time_day', 'start time', 'segments.date'],
  cname: ['campaign', 'campaign name', 'campaign_name'], cid: ['campaign id', 'campaign_id'],
  spend: ['spend', 'cost', 'amount spent', 'amount spent (usd)', 'amount spent (sar)', 'local spend', 'spend (usd)'],
  imp: ['impressions', 'impr.', 'paid impressions'], clk: ['clicks', 'taps', 'swipes', 'swipe ups', 'link clicks', 'clicks (all)'],
  inst: ['installs', 'app installs', 'total installs', 'conversions', 'mobile app installs', 'tap-through installs', 'app install']
};
export function parseAdCsv(text, net = 'csv') {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => { const o = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o.map(x => x.trim()); };
  const h = split(lines[0]).map(x => x.toLowerCase().replace(/^"|"$/g, ''));
  const col = k => h.findIndex(x => HDR[k].includes(x));
  const ix = Object.fromEntries(Object.keys(HDR).map(k => [k, col(k)]));
  if (ix.d < 0 || ix.spend < 0) throw new Error('The file needs at least a Date and a Spend (or Cost) column');
  const num = s => n(String(s || '').replace(/[^\d.\-]/g, ''));
  const day = s => { s = String(s || '').trim(); let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; const t = Date.parse(s); return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
  const out = [];
  for (const l of lines.slice(1)) {
    const c = split(l), d = day(c[ix.d]); if (!d) continue;
    const cname = ix.cname >= 0 ? c[ix.cname] : 'All campaigns';
    out.push({ net, cid: ix.cid >= 0 && c[ix.cid] ? c[ix.cid] : norm(cname).replace(/ /g, '-').slice(0, 60) || 'all', cname, app: '', d,
      spend: num(c[ix.spend]), cur: '', imp: ix.imp >= 0 ? num(c[ix.imp]) : 0, clk: ix.clk >= 0 ? num(c[ix.clk]) : 0, inst: ix.inst >= 0 ? num(c[ix.inst]) : 0 });
  }
  return out;
}
export const chunkDates = (start, end, size) => { const all = dateRange(start, end), o = []; for (let i = 0; i < all.length; i += size) o.push([all[i], all[Math.min(all.length, i + size) - 1]]); return o; };
