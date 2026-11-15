// Steam: public store data (no key) and sales from the Steamworks Financial Web API (publisher key).
//   players now   api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=
//   reviews       store.steampowered.com/appreviews/{appid}?json=1&language=all&purchase_type=all&num_per_page=0
//   store page    store.steampowered.com/api/appdetails?appids=&cc=
//   sales         partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales/v001/?key=&date=&highwatermark_id=
import { env } from '../config.js';

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
async function jget(url, what) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* html error page */ }
  if (!r.ok || j == null) throw new Error(`${what} ${r.status}${r.status === 403 ? ': key missing Financial permission, or this server IP is not allowed for the key' : ''}`);
  return j;
}
export const steamSalesReady = () => !!env('STEAM_FINANCIAL_KEY');

export async function steamPlayers(appid) {
  const j = await jget(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(appid)}`, 'Steam players');
  return n(j?.response?.player_count);
}
export async function steamReviews(appid) {
  const j = await jget(`https://store.steampowered.com/appreviews/${encodeURIComponent(appid)}?json=1&language=all&purchase_type=all&num_per_page=0&filter=all`, 'Steam reviews');
  const q = j?.query_summary || {};
  return { pos: n(q.total_positive), neg: n(q.total_negative), total: n(q.total_reviews), desc: q.review_score_desc || '' };
}
export async function steamDetails(appid, cc = 'us') {
  const j = await jget(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=${encodeURIComponent(cc)}`, 'Steam store');
  const d = j?.[appid]?.data; if (!d) return null;
  return { name: d.name, price: d.price_overview ? n(d.price_overview.final) / 100 : (d.is_free ? 0 : null), currency: d.price_overview?.currency || '', discount: n(d.price_overview?.discount_percent), release: d.release_date?.date || '', comingSoon: !!d.release_date?.coming_soon, deck: '' };
}
/** Sum every sales line of one Pacific-time day by primary app. */
export async function steamSalesDay(day) {
  const key = env('STEAM_FINANCIAL_KEY'); const out = {}; let hw = '0';
  for (let i = 0; i < 50; i++) {
    const j = await jget(`https://partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales/v001/?key=${encodeURIComponent(key)}&date=${day}&highwatermark_id=${hw}&include_view_grants=true`, 'Steam sales');
    const r = j?.response || j || {}, rows = r.results || [];
    for (const x of rows) {
      const app = String(x.primary_appid || x.appid || ''); if (!app) continue;
      const o = (out[app] ||= { units: 0, net: 0, gross: 0, ret: 0, retUsd: 0, tax: 0 });
      o.units += n(x.net_units_sold); o.gross += n(x.gross_sales_usd); o.net += n(x.net_sales_usd); o.ret += n(x.gross_units_returned); o.retUsd += n(x.gross_returns_usd); o.tax += n(x.net_tax_usd);
    }
    const next = String(r.max_id ?? '');
    if (!rows.length || !next || next === hw) break;
    hw = next;
  }
  return out;
}
