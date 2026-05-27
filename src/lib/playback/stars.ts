/**
 * Render a rating (in whole stars, 1–5) as a short numeric string with a
 * trailing ★ for use in window/lock-screen titles. 0/null → "".
 * 1 → "1★", 2 → "2★", … 5 → "5★".
 */
export function stars(ratingStars: number | null): string {
  if (ratingStars == null || ratingStars <= 0) return '';
  return `${ratingStars}★`;
}
