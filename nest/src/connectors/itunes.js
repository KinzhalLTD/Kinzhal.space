// Public App Store lookup (no key): current average rating in a storefront. One request covers many apps.
export async function storeRatings(ids, country = 'sa') {
  const list = [...new Set(ids.map(String).filter(x => /^\d+$/.test(x)))];
  const out = {};
  for (let i = 0; i < list.length; i += 50) {
    const r = await fetch(`https://itunes.apple.com/lookup?id=${list.slice(i, i + 50).join(',')}&country=${encodeURIComponent(country)}`);
    if (!r.ok) throw new Error('App Store lookup ' + r.status);
    const j = await r.json();
    for (const it of j.results || []) if (it.trackId && it.averageUserRating) out[String(it.trackId)] = { rating: +Number(it.averageUserRating).toFixed(2), count: it.userRatingCount || 0 };
  }
  return out;
}
export async function storeRating(id, country) { return (await storeRatings([id], country))[String(id)] || null; }
