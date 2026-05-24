/**
 * Render a rating (in half-step units, 0–10) as Unicode stars.
 * 0 / null → "". 1 → "½", 2 → "★", 3 → "★½", … 10 → "★★★★★".
 */
export function stars(halfSteps: number | null): string {
  if (halfSteps == null || halfSteps <= 0) return '';
  const full = Math.floor(halfSteps / 2);
  const half = halfSteps % 2 === 1;
  return '★'.repeat(full) + (half ? '½' : '');
}
