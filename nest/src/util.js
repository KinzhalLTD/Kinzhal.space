export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const iso = d => d.toISOString().slice(0, 10);
/** Date string N days from today (UTC). isoDay(-1) = yesterday. */
export const isoDay = (n = 0) => iso(new Date(Date.now() + n * 864e5));
export const addDays = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5));
export function dateRange(start, end) { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; }
export const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; // 20261031 -> 2026-10-31
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const log = (...a) => console.log(new Date().toISOString(), ...a);
