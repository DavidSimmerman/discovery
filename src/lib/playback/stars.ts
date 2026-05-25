/**
 * Render a rating (in half-step units, 0–10) as a short numeric string for use
 * in window/lock-screen titles. 0/null → "". 1 → "0.5", 2 → "1", 3 → "1.5", …
 * 10 → "5".
 *
 * The exported name stays `stars()` (used widely) — only the output format
 * changes.
 */
export function stars(halfSteps: number | null): string {
  if (halfSteps == null || halfSteps <= 0) return '';
  const v = halfSteps / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
