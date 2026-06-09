// Client-safe formatting helpers (no server-only imports — usable in components).

/** Human-friendly playcount, e.g. 1234567 → "1.2M", 45200 → "45K", 1500 → "1.5K". */
export function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Compact relative time for a recent timestamp, e.g. "just now", "2m ago",
 * "3h ago", "2d ago". Falls back to a short date ("Mar 4") past a week.
 * `nowMs` is injectable for deterministic tests.
 */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = nowMs - then;
  const MIN = 60_000;
  const HR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return 'just now';
  if (diff < HR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
