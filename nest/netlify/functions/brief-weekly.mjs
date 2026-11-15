// Weekly AI marketing brief: Sundays 04:00 UTC (07:00 Riyadh). Stored in kv/brief and shown in Marketing → AI analyst.
import { loadSettings } from '../../src/settings.js';
import { aiConfigured, weeklyBrief } from '../../src/ai.js';

export default async () => {
  try {
    await loadSettings();
    if (!aiConfigured()) { console.log('weekly brief: no Claude API key, skipped'); return new Response('skipped'); }
    const b = await weeklyBrief({ timeoutMs: 25_000 });
    console.log('weekly brief written', b.at);
  } catch (e) { console.error('weekly brief failed:', e.message || e); }
  return new Response('ok');
};

export const config = { schedule: '0 4 * * 0' };
