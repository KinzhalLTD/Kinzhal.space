// Crashlytics BigQuery export: fatal crashes per day. Crash-free % = 1 - crashes / GA4 sessions (approximation).
import { gfetch } from '../google.js';
import { env } from '../config.js';
import { isDate } from '../util.js';

export async function crashCounts(g, start, end) {
  const project = env('BIGQUERY_PROJECT');
  const table = String(g.crashlyticsTable || '');
  if (!project || !table) return null;
  if (!/^[\w-]+(\.[\w-]+){1,2}$/.test(table) || !isDate(start) || !isDate(end)) throw new Error('Invalid crashlyticsTable or dates');
  const full = table.split('.').length === 2 ? `${project}.${table}` : table;
  const query = `SELECT FORMAT_DATE('%Y-%m-%d', DATE(event_timestamp)) AS d, COUNTIF(is_fatal) AS crashes
    FROM \`${full}\` WHERE DATE(event_timestamp) BETWEEN '${start}' AND '${end}' GROUP BY d`;
  const j = await gfetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, { query, useLegacySql: false, timeoutMs: 5000 });
  if (j.jobComplete === false) throw new Error('BigQuery query did not finish in time; it will retry on the next sync');
  return (j.rows || []).map(r => ({ d: r.f[0].v, crashes: Number(r.f[1].v) || 0 }));
}
