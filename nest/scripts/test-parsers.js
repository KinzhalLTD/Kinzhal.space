// npm test -> checks the response parsers and the HQ row mapping with sample payloads (offline).
import assert from 'node:assert/strict';
import { parseGa4Daily, parseGa4Retention, parseGa4Funnel } from '../src/connectors/ga4.js';
import { parseAdmob } from '../src/connectors/admob.js';
import { parseSales } from '../src/connectors/asc.js';
import { toHqRow, toCsv } from '../src/live.js';

const daily = parseGa4Daily({ rows: [{ dimensionValues: [{ value: '20261030' }], metricValues: [{ value: '3100' }, { value: '420' }, { value: '12710' }, { value: '570' }] }] });
assert.deepEqual(daily[0], { d: '2026-10-30', dau: 3100, newUsers: 420, sessions: 12710, ses: 4.1, len: 9.5 });

const ret = parseGa4Retention({ rows: [
  { dimensionValues: [{ value: '2026-10-01' }, { value: '0001' }], metricValues: [{ value: '41' }, { value: '100' }] },
  { dimensionValues: [{ value: '2026-10-01' }, { value: '0007' }], metricValues: [{ value: '16' }, { value: '100' }] },
  { dimensionValues: [{ value: '2026-10-01' }, { value: '0003' }], metricValues: [{ value: '25' }, { value: '100' }] }] });
assert.deepEqual(ret, { '2026-10-01': { 1: 0.41, 7: 0.16 } });

const fun = parseGa4Funnel({ rows: [['1', 1000], ['5', 800], ['10', 700], ['20', 420], ['30', 300]].map(([l, u]) => ({ dimensionValues: [{ value: l }], metricValues: [{ value: String(u) }] })) });
assert.deepEqual(fun, [[1, 100], [5, 80], [10, 70], [20, 42], [30, 30]]);

const ad = parseAdmob([{ header: {} }, { row: { dimensionValues: { DATE: { value: '20261030' }, APP: { value: 'ca-app-pub-1~2', displayLabel: 'Brick' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '210500000' }, IMPRESSIONS: { integerValue: '22000' } } } }, { footer: {} }]);
assert.deepEqual(ad, [{ d: '2026-10-30', app: 'ca-app-pub-1~2', source: null, earn: 210.5, imp: 22000 }]);

const tsv = ['Provider\tApple Identifier\tUnits\tProduct Type Identifier', 'APPLE\t6400000001\t300\t1', 'APPLE\t6400000001\t120\t1F', 'APPLE\t6400000001\t900\t7', 'APPLE\t6400000001\t5\tIA1'].join('\n');
assert.deepEqual(parseSales(tsv), { '6400000001': 420 });

const hq = toHqRow({ g: 'brick', d: '2026-10-30', dau: 3100, newUsers: 420, sessions: 12710, ses: 4.1, len: 9.5, crashes: 48, ad: 210.5, imp: 22000 });
assert.equal(hq.inst, 420); assert.equal(hq.crash, 99.62); assert.equal(hq.d1, null); assert.equal(hq.iap, 0);
assert.ok(toCsv([hq]).startsWith('date,game,installs'));
// ratings: one lookup for many apps
const realFetch = global.fetch;
global.fetch = async u => { assert.ok(String(u).includes('id=640001,640002') && String(u).includes('country=sa')); return new Response(JSON.stringify({ results: [{ trackId: 640001, averageUserRating: 4.6123, userRatingCount: 88 }] })); };
const { storeRatings } = await import('../src/connectors/itunes.js');
assert.deepEqual(await storeRatings(['640001', '640002', 'bad'], 'sa'), { '640001': { rating: 4.61, count: 88 } });
global.fetch = realFetch;
// App Store key file name -> Key ID
const { keyIdFromFileName } = await import('../src/settings.js');
assert.equal(keyIdFromFileName('AuthKey_AB12CD34EF.p8'), 'AB12CD34EF'); assert.equal(keyIdFromFileName('key.p8'), '');
console.log('All parser tests passed ✓');
