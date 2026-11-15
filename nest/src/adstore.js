// Ad spend storage. One kv document per network keeps days compact:
//   kv/ads:{net}   { rows: [[cid, 'YYYY-MM-DD', spend, imp, clk, inst], ...] }   (last KEEP days)
//   kv/adCamps     { 'net:cid': { n: name, cur, app } }
//   kv/adMap       { 'net:cid': gameId | '' }   set by hand in Marketing → Ad accounts
// After each import the per-game totals go into the daily metrics as `ua` (spend) and `paid` (installs).
import { getKV, setKV, upsertRows } from './store.js';
import { gameForCampaign } from './connectors/ads.js';
import { isoDay } from './util.js';

export const AD_NETS = ['asa', 'snap', 'tiktok', 'meta', 'gads', 'csv'];
const KEEP = 150;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

export async function saveAdRows(rows, games) {
  if (!rows.length) return 0;
  const camps = (await getKV('adCamps')) || {};
  const byNet = {};
  for (const r of rows) {
    if (!AD_NETS.includes(r.net) || !r.cid || !/^\d{4}-\d{2}-\d{2}$/.test(r.d || '')) continue;
    (byNet[r.net] ||= []).push(r);
    const k = `${r.net}:${r.cid}`;
    camps[k] = { n: String(r.cname || camps[k]?.n || r.cid).slice(0, 120), cur: r.cur || camps[k]?.cur || '', app: r.app || camps[k]?.app || '' };
  }
  const oldest = isoDay(-KEEP), days = new Set();
  for (const [net, list] of Object.entries(byNet)) {
    const cur = new Map(((await getKV('ads:' + net))?.rows || []).filter(x => x[1] >= oldest).map(x => [x[0] + '|' + x[1], x]));
    for (const r of list) { cur.set(r.cid + '|' + r.d, [String(r.cid), r.d, r2(r.spend), Math.round(r.imp || 0), Math.round(r.clk || 0), Math.round(r.inst || 0)]); days.add(r.d); }
    await setKV('ads:' + net, { rows: [...cur.values()].sort((a, b) => a[1].localeCompare(b[1])) });
  }
  await setKV('adCamps', camps);
  await rollupToGames([...days], games);
  return rows.length;
}

/** All ad rows (optionally since a date) with their game. */
export async function loadAdRows(games, since = isoDay(-KEEP)) {
  const [campsR, mapR, ...nets] = await Promise.all([getKV('adCamps'), getKV('adMap'), ...AD_NETS.map(n => getKV('ads:' + n))]);
  const camps = campsR || {}, map = mapR || {};
  const out = [];
  for (const [ni, net] of AD_NETS.entries()) {
    for (const [cid, d, spend, imp, clk, inst] of nets[ni]?.rows || []) {
      if (d < since) continue;
      const c = camps[`${net}:${cid}`] || {};
      const row = { net, cid, cname: c.n || cid, app: c.app || '', cur: c.cur || '', d, spend, imp, clk, inst };
      row.g = gameForCampaign(row, games, map);
      out.push(row);
    }
  }
  return out;
}

/** Recompute daily `ua` and `paid` per game for the given days from every network. */
export async function rollupToGames(days, games) {
  if (!days.length) return;
  const want = new Set(days), all = await loadAdRows(games, days.slice().sort()[0]);
  const sum = {};
  for (const r of all) if (r.g && want.has(r.d)) { const k = r.g + '|' + r.d; const s = (sum[k] ||= { ua: 0, paid: 0 }); s.ua += r.spend; s.paid += r.inst; }
  const rows = [];
  for (const g of games) for (const d of want) { const s = sum[g.id + '|' + d] || { ua: 0, paid: 0 }; rows.push({ g: g.id, d, ua: r2(s.ua), paid: s.paid }); }
  await upsertRows(rows);
}

export async function saveAdMap(map, games) {
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) if (/^[a-z]+:[\w.\-]{1,80}$/.test(k) && (v === '' || games.some(g => g.id === v))) clean[k] = v;
  const cur = { ...((await getKV('adMap')) || {}), ...clean };
  await setKV('adMap', cur);
  const all = await loadAdRows(games);
  await rollupToGames([...new Set(all.map(r => r.d))], games);
  return cur;
}
