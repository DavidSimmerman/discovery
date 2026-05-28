// Artist scoring: sum per-song points (with a per-song listening bonus for
// the user's most-played tracks), then apply a percentage boost if the artist
// is one of the user's most-played artists.
//
// Spotify caps /me/top/{artists,tracks} at 50 entries, so the highest tiers
// here all live within that ceiling.

export const STAR_POINTS: Record<number, number> = {
  0: -2,
  1: -1,
  2: 1,
  3: 2,
  4: 5,
  5: 10,
};

export function starPoints(stars: number): number {
  return STAR_POINTS[stars] ?? 0;
}

// Per-song bonus when the rated track itself is one of the user's top tracks.
// `rank` is 1-indexed; null/undefined = not in top list.
export function trackRankBonus(rank: number | null | undefined): number {
  if (rank == null) return 0;
  if (rank <= 10) return 10;
  if (rank <= 25) return 5;
  if (rank <= 50) return 3;
  return 0;
}

// Multiplier applied to the artist's total score when the artist is among the
// user's top artists. Returns 1.0 when not in the top list.
export function artistRankMultiplier(rank: number | null | undefined): number {
  if (rank == null) return 1;
  if (rank <= 1) return 1.15;
  if (rank <= 5) return 1.10;
  if (rank <= 15) return 1.075;
  if (rank <= 30) return 1.05;
  if (rank <= 50) return 1.025;
  return 1;
}

export type ScoredTrack = {
  stars: number;          // 0..5
  trackRank?: number | null; // 1-indexed position in user's top tracks, or null
};

export function artistScore(
  tracks: ScoredTrack[],
  artistRank: number | null | undefined,
): number {
  let base = 0;
  for (const t of tracks) {
    base += starPoints(t.stars) + trackRankBonus(t.trackRank);
  }
  return base * artistRankMultiplier(artistRank);
}
