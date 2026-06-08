// Client-safe formatting helpers (no server-only imports — usable in components).

/** Human-friendly playcount, e.g. 1234567 → "1.2M", 45200 → "45K", 1500 → "1.5K". */
export function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
