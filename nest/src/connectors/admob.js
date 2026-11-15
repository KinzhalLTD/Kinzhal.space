// AdMob API v1: mediation report = earnings from AdMob + every mediated network.
import { gfetch } from '../google.js';
import { ymd } from '../util.js';

const ds = s => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };
import { env } from '../config.js';
const pubPath = () => {
  const p = env('ADMOB_PUBLISHER_ID');
  return 'accounts/' + (p.startsWith('pub-') ? p : 'pub-' + p);
};

export async function admobDaily(start, end) {
  const j = await gfetch(`https://admob.googleapis.com/v1/${pubPath()}/mediationReport:generate`, {
    reportSpec: {
      dateRange: { startDate: ds(start), endDate: ds(end) },
      dimensions: ['DATE', 'APP'],
      metrics: ['ESTIMATED_EARNINGS', 'IMPRESSIONS'],
      localizationSettings: { currencyCode: 'USD' }
    }
  });
  return parseAdmob(j);
}
export async function admobSources(start, end) {
  const j = await gfetch(`https://admob.googleapis.com/v1/${pubPath()}/mediationReport:generate`, {
    reportSpec: {
      dateRange: { startDate: ds(start), endDate: ds(end) },
      dimensions: ['AD_SOURCE'],
      metrics: ['ESTIMATED_EARNINGS', 'IMPRESSIONS'],
      localizationSettings: { currencyCode: 'USD' }
    }
  });
  return parseAdmob(j);
}
/** The API streams an array: [{header}, {row}, ..., {footer}]. */
export function parseAdmob(j) {
  const arr = Array.isArray(j) ? j : [j];
  const rows = [];
  for (const it of arr) {
    if (!it || !it.row) continue;
    const dv = it.row.dimensionValues || {}, mv = it.row.metricValues || {};
    rows.push({
      d: dv.DATE?.value ? ymd(dv.DATE.value) : null,
      app: dv.APP?.value || null,
      source: dv.AD_SOURCE ? (dv.AD_SOURCE.displayLabel || dv.AD_SOURCE.value) : null,
      earn: Number(mv.ESTIMATED_EARNINGS?.microsValue || 0) / 1e6,
      imp: Number(mv.IMPRESSIONS?.integerValue || 0)
    });
  }
  return rows;
}
