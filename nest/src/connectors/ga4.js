// Firebase Analytics data through the Google Analytics Data API (v1beta).
import { gfetch } from '../google.js';
import { ymd } from '../util.js';

const BASE = 'https://analyticsdata.googleapis.com/v1beta/properties/';
const streamExpr = g => g.ga4StreamId ? [{ filter: { fieldName: 'streamId', stringFilter: { value: String(g.ga4StreamId) } } }] : [];
const andFilter = exprs => exprs.length === 0 ? undefined : exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };

export async function ga4Daily(g, start, end) {
  const j = await gfetch(`${BASE}${g.ga4PropertyId}:runReport`, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }, { name: 'averageSessionDuration' }],
    dimensionFilter: andFilter(streamExpr(g)),
    limit: 1000
  });
  return parseGa4Daily(j);
}
export function parseGa4Daily(j) {
  return (j.rows || []).map(r => {
    const [dau, newUsers, sessions, avgSec] = r.metricValues.map(x => Number(x.value) || 0);
    return { d: ymd(r.dimensionValues[0].value), dau, newUsers, sessions, ses: dau ? +(sessions / dau).toFixed(2) : 0, len: +(avgSec / 60).toFixed(1) };
  });
}

/** Cohort retention for install (first-session) dates. Returns { 'YYYY-MM-DD': { n: rate } } for n in 1,7,30. */
export async function ga4Retention(g, dates) {
  const out = {};
  for (let i = 0; i < dates.length; i += 6) {
    const chunk = dates.slice(i, i + 6);
    const j = await gfetch(`${BASE}${g.ga4PropertyId}:runReport`, {
      dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }],
      metrics: [{ name: 'cohortActiveUsers' }, { name: 'cohortTotalUsers' }],
      dimensionFilter: andFilter(streamExpr(g)),
      cohortSpec: {
        cohorts: chunk.map(d => ({ name: d, dimension: 'firstSessionDate', dateRange: { startDate: d, endDate: d } })),
        cohortsRange: { granularity: 'DAILY', startOffset: 0, endOffset: 30 }
      }
    });
    Object.assign(out, parseGa4Retention(j));
  }
  return out;
}
export function parseGa4Retention(j) {
  const o = {};
  for (const r of j.rows || []) {
    const cohort = r.dimensionValues[0].value, n = parseInt(r.dimensionValues[1].value, 10);
    const act = Number(r.metricValues[0].value) || 0, tot = Number(r.metricValues[1].value) || 0;
    if (!tot || ![1, 7, 30].includes(n)) continue;
    (o[cohort] ||= {})[n] = +(act / tot).toFixed(4);
  }
  return o;
}

/** Players reaching each level (needs a registered custom dimension for the level parameter). */
export async function ga4Funnel(g, start, end) {
  if (!g.ga4LevelDimension) return null;
  const j = await gfetch(`${BASE}${g.ga4PropertyId}:runReport`, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: g.ga4LevelDimension }],
    metrics: [{ name: 'totalUsers' }],
    dimensionFilter: andFilter([{ filter: { fieldName: 'eventName', stringFilter: { value: g.ga4LevelEvent || 'level_start' } } }, ...streamExpr(g)]),
    limit: 5000
  });
  return parseGa4Funnel(j);
}
export function parseGa4Funnel(j) {
  const users = new Map();
  for (const r of j.rows || []) {
    const lvl = parseInt(r.dimensionValues[0].value, 10);
    if (Number.isFinite(lvl) && lvl > 0) users.set(lvl, (users.get(lvl) || 0) + (Number(r.metricValues[0].value) || 0));
  }
  if (!users.size) return null;
  const max = Math.max(...users.keys()), base = users.get(1) || Math.max(...users.values());
  const marks = [1, 3, 5, 10, 15, 20, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300].filter(m => m <= max);
  if (!marks.includes(max) && marks.length < 14) marks.push(max);
  return marks.filter(m => users.has(m)).map(m => [m, +Math.min(100, users.get(m) / base * 100).toFixed(1)]);
}
