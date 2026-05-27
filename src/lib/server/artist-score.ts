// Bayesian shrinkage so a single 5★ rating doesn't outrank an artist with a long
// catalog. m is the prior weight — higher = stricter, harder for small samples
// to climb. m=5 is the project default; tunable per call for tests.
//
// score = (n * artistAvg + m * globalAvg) / (n + m)
export const ARTIST_PRIOR_WEIGHT = 5;

export function bayesianScore(
  artistAvg: number,
  artistCount: number,
  globalAvg: number,
  m: number = ARTIST_PRIOR_WEIGHT,
): number {
  if (artistCount + m === 0) return 0;
  return (artistCount * artistAvg + m * globalAvg) / (artistCount + m);
}
