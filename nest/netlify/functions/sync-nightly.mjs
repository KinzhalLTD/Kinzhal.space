// Nightly sync. Runs every 15 minutes between 03:00 and 04:45 UTC (06:00–07:45 Riyadh).
// The first run of the day queues the last 3 days; every run works through the queue for up to ~24 s
// (scheduled functions may run for 30 s), so large portfolios finish over several runs.
import { startSync, runQueue, queueState } from '../../src/jobs.js';
import { getKV } from '../../src/store.js';

export default async () => {
  const started = Date.now();
  try {
    if (!(await queueState())) {
      const last = await getKV('status');
      const today = new Date().toISOString().slice(0, 10);
      if (!last || String(last.startedAt || '').slice(0, 10) !== today) await startSync({ days: 3, by: 'schedule' });
    }
    const r = await runQueue(started + 24_000);
    console.log('nightly sync:', JSON.stringify({ remaining: r.remaining, total: r.total, done: r.done }));
  } catch (e) {
    console.error('nightly sync failed:', e.message || e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 3-4 * * *' };
