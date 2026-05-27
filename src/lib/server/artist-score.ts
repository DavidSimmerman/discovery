// Artist scoring: two views of "how good is this artist?"
//
//   artistAverage(ratings)         — straight mean of every rating
//   artistWeightedAverage(ratings) — tiered top-K mean with caps that scale
//                                    by sample size, so an artist with one
//                                    5★ song can't outrank an artist with
//                                    a deep catalog of bangers.
//
// Weighted tiers (count = number of rated songs):
//   count ≤ 5    → mean of all ratings × 21/25  (effective cap ≈ 4.2)
//   count ≤ 10   → mean of top 60%, capped at 4.6
//   count ≤ 20   → mean of top 50%, capped at 5.0
//   count >  20  → mean of top 10 songs,  capped at 5.0

export function artistAverage(ratings: number[]): number {
  if (ratings.length === 0) return 0;
  const sum = ratings.reduce((a, b) => a + b, 0);
  return sum / ratings.length;
}

export function artistWeightedAverage(ratings: number[]): number {
  const n = ratings.length;
  if (n === 0) return 0;

  if (n <= 5) {
    return artistAverage(ratings) * (21 / 25);
  }

  const sorted = [...ratings].sort((a, b) => b - a);
  const topMean = (k: number) => {
    const slice = sorted.slice(0, Math.max(1, k));
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };

  if (n <= 10) {
    return Math.min(4.6, topMean(Math.ceil(n * 0.6)));
  }
  if (n <= 20) {
    return Math.min(5, topMean(Math.ceil(n * 0.5)));
  }
  return Math.min(5, topMean(10));
}
