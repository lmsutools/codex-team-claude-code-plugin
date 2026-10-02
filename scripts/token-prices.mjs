/** Optional user-supplied rates per million; incomplete coverage never produces a dollar total. */
export function priceUsage(entries, prices) {
  const missing = new Set();
  let total = 0;
  for (const e of entries) {
    const key = `${e.provider}/${e.model || "unknown"}`;
    const rates = prices?.version === 1 ? prices.models?.[key] : null;
    if (!rates || !["input", "cacheRead", "cacheWrite", "output"].every(k => Number.isFinite(rates[k]) && rates[k] >= 0)) { missing.add(key); continue; }
    const write = e.cacheWrite || 0;
    total += (Math.max(0, e.usage.input - e.usage.cached - write) * rates.input + e.usage.cached * rates.cacheRead + write * rates.cacheWrite + e.usage.output * rates.output) / 1e6;
  }
  return { total: missing.size ? null : total, missing: [...missing] };
}
