// AI marketing analyst: Claude answers from a compact summary of the workspace's live numbers.
// The API key (ANTHROPIC_API_KEY) is stored encrypted like every other key and never reaches the browser.
import { env, loadGames } from './config.js';
import { getRows, getKV, setKV } from './store.js';
import { loadAdRows } from './adstore.js';
import { isoDay } from './util.js';

export const aiConfigured = () => !!env('ANTHROPIC_API_KEY');
export const aiModel = () => env('AI_MODEL', 'claude-sonnet-5-5');
const sum = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
const avg = (a, k) => { const v = a.map(x => x[k]).filter(x => x != null && !Number.isNaN(Number(x))); return v.length ? v.reduce((s, x) => s + Number(x), 0) / v.length : null; };
const f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

/** Plain-text summary of the last 28 days vs the 28 before, per game, plus ad campaigns and review themes. */
export async function buildContext() {
  const { games } = loadGames();
  const rows = await getRows(isoDay(-56), games.map(g => g.id));
  const cut = isoDay(-28), lines = [];
  lines.push(`Today: ${isoDay(0)}. Window: last 28 days (vs previous 28). Currency USD unless noted.`);
  lines.push('GAME | installs | paid installs | avg DAU | ad rev | IAP rev | UA spend | D1 | D7 | D30 | rating | prev ad+IAP rev');
  for (const g of games) {
    const cur = rows.filter(r => r.g === g.id && r.d >= cut), prev = rows.filter(r => r.g === g.id && r.d < cut);
    if (!cur.length && !prev.length) continue;
    lines.push(`${g.name} (${g.id}) | ${sum(cur, 'inst') || sum(cur, 'newUsers')} | ${sum(cur, 'paid')} | ${Math.round(avg(cur, 'dau') || 0)} | ${f(sum(cur, 'ad'))} | ${f(sum(cur, 'iap'))} | ${f(sum(cur, 'ua'))} | ${f(avg(cur, 'd1'))} | ${f(avg(cur, 'd7'))} | ${f(avg(cur, 'd30'))} | ${f(avg(cur, 'rating'), 1)} | ${f(sum(prev, 'ad') + sum(prev, 'iap'))}`);
  }
  const ads = await loadAdRows(games, isoDay(-14));
  if (ads.length) {
    const by = {};
    for (const r of ads) { const k = `${r.net}|${r.cname}|${r.g || '?'}`; const s = (by[k] ||= { spend: 0, inst: 0, imp: 0, clk: 0 }); s.spend += r.spend; s.inst += r.inst; s.imp += r.imp; s.clk += r.clk; }
    lines.push('', 'AD CAMPAIGNS last 14 days: network | campaign | game | spend | installs | CPI | CTR');
    for (const [k, s] of Object.entries(by).sort((a, b) => b[1].spend - a[1].spend).slice(0, 40)) {
      const [net, n, g] = k.split('|');
      lines.push(`${net} | ${n} | ${g} | ${f(s.spend)} | ${s.inst} | ${s.inst ? f(s.spend / s.inst) : '—'} | ${s.imp ? f(100 * s.clk / s.imp) + '%' : '—'}`);
    }
  }
  const rv = [];
  for (const g of games) { const list = (await getKV('reviews:' + g.id)) || []; for (const r of list.slice(0, 8)) rv.push(`${g.name} ★${r.r}: ${(r.t + ' — ' + r.b).slice(0, 160)}`); }
  if (rv.length) lines.push('', 'RECENT APP STORE REVIEWS:', ...rv.slice(0, 40));
  const med = (await getKV('mediation')) || [];
  if (med.length) lines.push('', 'AD MEDIATION last 30 days: ' + med.slice(0, 8).map(m => `${m.n} $${f(m.v)}`).join(', '));
  return lines.join('\n').slice(0, 60000);
}

const SYSTEM = `You are the marketing analyst inside Kinzhal Nest, the private dashboard of Kinzhal LTD Co., a small Saudi mobile games studio (iOS, ad-supported games with AdMob mediation and some in-app purchases).
Answer from the DATA block. Be specific: name games, numbers and dates. When data is missing, say what is missing instead of guessing.
Prefer short sections and bullet points, then a clear "Do this next" list of at most 5 actions with expected impact.
Think in unit economics: CPI vs predicted LTV, payback days, ROAS, retention (D1/D7/D30), ARPDAU, store conversion.
Saudi context matters: Snapchat and TikTok are the biggest channels, Ramadan and Eid shift play to night time, Arabic-first creatives usually win.
Reply in the language of the question (Arabic questions get Modern Standard Arabic with a light Saudi tone).
Never invent figures, never recommend manipulative or misleading tactics, and never suggest spending money without a test budget and a stop rule.`;

export async function askClaude(question, { extra = '', maxTokens = 1200, timeoutMs = 9000, model } = {}) {
  if (!aiConfigured()) throw new Error('Add your Claude API key in Marketing → Ad accounts → AI analyst');
  const data = await buildContext();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || aiModel(), max_tokens: maxTokens, system: SYSTEM, messages: [{ role: 'user', content: `<DATA>\n${data}\n</DATA>\n${extra ? `<PAGE>\n${String(extra).slice(0, 6000)}\n</PAGE>\n` : ''}\n${String(question).slice(0, 2000)}` }] })
  }).catch(e => { throw new Error(/abort|timeout/i.test(String(e?.name || e?.message)) ? 'The AI took too long. Ask a shorter question, or choose a faster model (claude-haiku-5-5) in Ad accounts → AI analyst.' : 'Could not reach Claude: ' + (e.message || e)); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude ${r.status}: ${j?.error?.message || 'request failed'}`);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

export async function weeklyBrief({ timeoutMs = 25000 } = {}) {
  const text = await askClaude(
    'Write this week\'s marketing brief for the owner. Sections: 1) Headline (one line). 2) What changed vs last period (per game, only meaningful moves). 3) Money: where ad spend paid back and where it did not. 4) Risks (retention drops, crash or review problems, creative fatigue). 5) Do this next (max 5 actions, each with the game, the action and the expected impact). Keep it under 450 words. English first, then a short Arabic summary (5 bullets).',
    { maxTokens: 1800, timeoutMs });
  const brief = { at: new Date().toISOString(), text, model: aiModel() };
  await setKV('brief', brief);
  return brief;
}
