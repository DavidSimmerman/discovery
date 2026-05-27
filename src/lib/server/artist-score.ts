// "How many hits do you have?" score. Misses (ratings below HIT_THRESHOLD)
// are ignored entirely — every favorite artist has a long tail of songs you
// don't actually like, and those shouldn't drag the score down. The whole
// signal is the count and quality of songs above the threshold, gated by
// volume so a single 5★ doesn't claim the same score as a deep catalog of 5★s.
//
// score = hitAvg * confidence(h) + NEUTRAL * (1 − confidence(h))
//   where confidence(h) = 1 − exp(−h / CONFIDENCE_SCALE)
//
// Tunable constants:
//   HIT_THRESHOLD    (3)   — ratings at or above this count as "hits"
//   NEUTRAL          (3)   — score with no hits / fully discounted
//   CONFIDENCE_SCALE (2.5) — h at which we mostly trust the hit average
export const HIT_THRESHOLD = 3;
export const NEUTRAL = 3;
export const CONFIDENCE_SCALE = 2.5;

export function artistScore(ratings: number[]): number {
  const hits = ratings.filter((r) => r >= HIT_THRESHOLD);
  const h = hits.length;
  if (h === 0) return NEUTRAL;
  const hitAvg = hits.reduce((a, b) => a + b, 0) / h;
  const confidence = 1 - Math.exp(-h / CONFIDENCE_SCALE);
  return hitAvg * confidence + NEUTRAL * (1 - confidence);
}
