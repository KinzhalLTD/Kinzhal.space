// App Store Connect: store funnel (Analytics Reports API) and customer reviews.
//   Funnel: one ONGOING analytics report request per app (Apple then publishes daily reports).
//           "App Store Discovery and Engagement" gives impressions and product page views by territory.
//   Reviews: /v1/apps/{id}/customerReviews, newest first.
import zlib from 'node:zlib';
import { ascGet, ascPost } from './asc.js';
import { getKV, setKV } from '../store.js';

/** Find or create the ongoing analytics request for an app. Returns its id (null while Apple refuses). */
export async function ensureReportRequest(appleId) {
  const key = 'ascReq:' + appleId;
  const saved = await getKV(key);
  if (saved?.id) return saved.id;
  const r = await ascPost('/v1/analyticsReportRequests', { data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' }, relationships: { app: { data: { type: 'apps', id: String(appleId) } } } } });
  let id = r.ok ? r.j?.data?.id : null;
  if (!id) {
    const list = await ascGet(`/v1/apps/${appleId}/analyticsReportRequests?filter[accessType]=ONGOING`);
    id = list.data?.find(x => !x.attributes?.stoppedDueToInactivity)?.id || list.data?.[0]?.id || null;
    if (!id && !r.ok) throw new Error(`App Store analytics request failed (${r.status}): ${r.j?.errors?.[0]?.detail || 'check that the API key has the Admin or Sales role'}`);
  }
  await setKV(key, { id, at: new Date().toISOString() });
  return id;
}

/** Tab or comma separated text -> objects with lower-case keys. */
export function parseTable(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const h = lines[0].split(sep).map(x => x.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).map(l => { const c = l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')); return Object.fromEntries(h.map((k, i) => [k, c[i]])); });
}

/** Impressions / product page views per data date. Returns { 'YYYY-MM-DD': { imp, view, terr:{SA:{imp,view}} } } (empty when not ready). */
export function funnelFromRows(rows, fallbackDay) {
  const out = {};
  for (const r of rows) {
    const ev = String(r.event || r['event type'] || '').toLowerCase();
    const k = /impression/.test(ev) ? 'imp' : /page view/.test(ev) ? 'view' : null;
    if (!k) continue;
    const v = Number(r['unique counts'] ?? r['unique devices'] ?? r.counts ?? r.count ?? 0) || 0;
    const d = /^\d{4}-\d{2}-\d{2}/.test(r.date || '') ? r.date.slice(0, 10) : fallbackDay;
    const t = String(r.territory || r.storefront || '??').toUpperCase().slice(0, 2);
    const o = (out[d] ||= { imp: 0, view: 0, terr: {} });
    o[k] += v; (o.terr[t] ||= { imp: 0, view: 0 })[k] += v;
  }
  return out;
}

export async function storeFunnel(appleId, day) {
  const reqId = await ensureReportRequest(appleId);
  if (!reqId) return {};
  const reps = await ascGet(`/v1/analyticsReportRequests/${reqId}/reports?filter[category]=APP_STORE_ENGAGEMENT`);
  const rep = (reps.data || []).find(x => /discovery and engagement standard/i.test(x.attributes?.name || '')) || (reps.data || []).find(x => /discovery and engagement/i.test(x.attributes?.name || ''));
  if (!rep) return {}; // Apple creates reports 1–2 days after the first request
  const inst = await ascGet(`/v1/analyticsReports/${rep.id}/instances?filter[granularity]=DAILY&filter[processingDate]=${day}`);
  const rows = [];
  for (const i of inst.data || []) {
    const seg = await ascGet(`/v1/analyticsReportInstances/${i.id}/segments`);
    for (const s of seg.data || []) {
      const url = s.attributes?.url; if (!url) continue;
      const r = await fetch(url); if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      let txt; try { txt = zlib.gunzipSync(buf).toString('utf8'); } catch { txt = buf.toString('utf8'); }
      rows.push(...parseTable(txt));
    }
  }
  return funnelFromRows(rows, day);
}

export async function reviews(appleId, limit = 100) {
  const j = await ascGet(`/v1/apps/${appleId}/customerReviews?sort=-createdDate&limit=${Math.min(200, limit)}`);
  return (j.data || []).map(x => ({ id: x.id, r: Number(x.attributes?.rating) || 0, t: String(x.attributes?.title || '').slice(0, 200), b: String(x.attributes?.body || '').slice(0, 1200), d: String(x.attributes?.createdDate || '').slice(0, 10), c: x.attributes?.territory || '' }));
}
