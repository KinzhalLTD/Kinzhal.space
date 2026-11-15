// Shapes stored rows into the daily format Kinzhal Nest uses.
import { loadGames } from './config.js';
import { getRows, getKV } from './store.js';
import { isoDay } from './util.js';

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

export function toHqRow(r) {
  const sessions = num(r.sessions), crashes = num(r.crashes), dau = num(r.dau);
  return {
    g: r.g, d: r.d,
    inst: num(r.inst) ?? num(r.newUsers) ?? 0,           // App Store first-time downloads, else GA4 new users
    paid: num(r.paid) ?? 0,
    dau: dau ?? 0,
    ses: num(r.ses), len: num(r.len),
    imp: num(r.imp) ?? 0, ad: num(r.ad) ?? 0, iap: num(r.iap) ?? 0, ua: num(r.ua) ?? 0,
    d1: num(r.d1), d7: num(r.d7), d30: num(r.d30),
    crash: sessions && crashes != null ? +Math.max(0, 100 * (1 - crashes / sessions)).toFixed(2) : null,
    rating: num(r.rating),
    sImp: num(r.sImp), sView: num(r.sView),
    stCcu: num(r.stCcu), stPos: num(r.stPos), stNeg: num(r.stNeg), stUnits: num(r.stUnits), stNet: num(r.stNet), stGross: num(r.stGross), stRet: num(r.stRet)
  };
}

export async function buildLive(days = 120) {
  const { games } = loadGames();
  const rows = (await getRows(isoDay(-days), games.map(g => g.id))).map(toHqRow);
  const funnels = {};
  for (const g of games) { const f = await getKV('funnel:' + g.id); if (f) funnels[g.id] = f; }
  return {
    games: games.map(g => ({ id: g.id, name: g.name })),
    rows, funnels,
    mediation: (await getKV('mediation')) || [],
    status: (await getKV('status')) || null
  };
}

const COLS = ['date', 'game', 'installs', 'paid_installs', 'dau', 'sessions_per_dau', 'session_min', 'impressions', 'ad_revenue', 'iap_revenue', 'ua_spend', 'd1', 'd7', 'd30', 'crash_free', 'rating', 'store_impressions', 'store_page_views', 'steam_players_now', 'steam_reviews_positive', 'steam_reviews_negative', 'steam_units', 'steam_net_usd', 'steam_gross_usd', 'steam_refund_units'];
const KEYS = ['d', 'g', 'inst', 'paid', 'dau', 'ses', 'len', 'imp', 'ad', 'iap', 'ua', 'd1', 'd7', 'd30', 'crash', 'rating', 'sImp', 'sView', 'stCcu', 'stPos', 'stNeg', 'stUnits', 'stNet', 'stGross', 'stRet'];
export const toCsv = rows => COLS.join(',') + '\n' + rows.map(r => KEYS.map(k => r[k] ?? '').join(',')).join('\n') + '\n';
