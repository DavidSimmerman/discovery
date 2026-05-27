// "How many hits do you have?" score. Hits (rating >= HIT_THRESHOLD) drive
// the score. Misses (rating < HIT_THRESHOLD) only matter when there are few
// hits — once an artist has a deep catalog of bangers, the long tail of
// songs you don't love stops counting against them. With zero hits, the
// score sits below NEUTRAL and decays as misses pile up.
//
//   hits-present:  base    = hitAvg * conf(h) + NEUTRAL * (1 − conf(h))
//                  penalty = MISS_PENALTY_WEIGHT * ln(m + 1) / (h + 1)
//                  score   = max(0, base − penalty)
//
//   no hits:       score = NEUTRAL − NO_HIT_PENALTY_WEIGHT * ln(m + 1)
//
//   conf(h) = 1 − exp(−h / CONFIDENCE_SCALE)
//
// Tunable constants:
//   HIT_THRESHOLD          (3)   — ratings at or above this count as hits
//   NEUTRAL                (3)   — score with no info / fully discounted
//   CONFIDENCE_SCALE       (2.5) — h at which we mostly trust the hit average
//   MISS_PENALTY_WEIGHT    (0.3) — how much misses pull a hits-present score
//   NO_HIT_PENALTY_WEIGHT  (0.4) — how much misses pull the no-hits score
export const HIT_THRESHOLD = 3;
export const NEUTRAL = 3;
export const CONFIDENCE_SCALE = 2.5;
export const MISS_PENALTY_WEIGHT = 0.3;
export const NO_HIT_PENALTY_WEIGHT = 0.4;

export function artistScore(ratings: number[]): number {
  let hitSum = 0;
  let h = 0;
  let m = 0;
  for (const r of ratings) {
    if (r >= HIT_THRESHOLD) {
      hitSum += r;
      h += 1;
    } else {
      m += 1;
    }
  }

  if (h === 0) {
    return Math.max(0, NEUTRAL - NO_HIT_PENALTY_WEIGHT * Math.log(m + 1));
  }

  const hitAvg = hitSum / h;
  const confidence = 1 - Math.exp(-h / CONFIDENCE_SCALE);
  const base = hitAvg * confidence + NEUTRAL * (1 - confidence);
  const penalty = (MISS_PENALTY_WEIGHT * Math.log(m + 1)) / (h + 1);
  return Math.max(0, base - penalty);
}
