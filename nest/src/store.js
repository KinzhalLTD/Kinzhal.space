// Metrics and small server-side values in Firestore.
//   metricsByGame/{gameId}  { rows: { 'YYYY-MM-DD': { dau, inst, ad, ... } } }   (one document per game)
//   kv/{key}                { json: '<value>' }                                       (status, funnels, mediation, games, sync queue)
import { db } from './db.js';
import { isoDay } from './util.js';

const KEEP_DAYS = 420; // a game-year of history per document keeps each document far below Firestore's 1 MB limit
const safeId = s => String(s).replace(/[^a-z0-9-]/gi, '_').slice(0, 120);

/** Merge partial rows {g, d, ...fields} into what is stored. */
export async function upsertRows(rows) {
  if (!rows.length) return 0;
  const byGame = new Map();
  for (const { g, d, ...f } of rows) {
    if (!g || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const clean = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && !Number.isNaN(v)) clean[k] = v;
    if (!byGame.has(g)) byGame.set(g, {});
    byGame.get(g)[d] = { ...(byGame.get(g)[d] || {}), ...clean };
  }
  for (const [g, days] of byGame) await db().set(`metricsByGame/${safeId(g)}`, { rows: days }, { merge: true });
  return rows.length;
}

/** All rows since a date, for every game (or the given ids). */
export async function getRows(sinceDate, ids) {
  const out = [];
  const docs = await db().list('metricsByGame');
  const oldest = isoDay(-KEEP_DAYS);
  for (const { id, data } of docs) {
    if (ids && !ids.includes(id)) continue;
    const rows = data?.rows || {};
    const stale = Object.keys(rows).filter(d => d < oldest);
    if (stale.length) { // trim history beyond KEEP_DAYS
      const kept = Object.fromEntries(Object.entries(rows).filter(([d]) => d >= oldest));
      await db().set(`metricsByGame/${id}`, { rows: kept });
    }
    for (const [d, f] of Object.entries(rows)) if (d >= sinceDate && d >= oldest) out.push({ g: id, d, ...f });
  }
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

// Values are stored as JSON text: Firestore cannot hold nested arrays (e.g. level funnels [[level, %], ...]).
export async function getKV(k) { const d = await db().get(`kv/${safeId(k)}`); if (!d || d.json == null) return null; try { return JSON.parse(d.json); } catch { return null; } }
export async function setKV(k, v) { await db().set(`kv/${safeId(k)}`, { json: JSON.stringify(v ?? null), at: new Date().toISOString() }); }
export async function delKV(k) { await db().del(`kv/${safeId(k)}`); }
