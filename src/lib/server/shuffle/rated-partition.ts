// Rated/unrated split for a track list against the user's ratings.
// Rated = URI match OR ISRC match, mirroring the shuffle candidate loader —
// any "N unrated" count shown in the UI must agree with what an "Unrated
// only" shuffle actually plays.

export interface RatedRow {
  uri: string;
  isrc: string | null;
}

export function partitionRated<T extends { uri: string; isrc?: string | null }>(
  tracks: T[],
  ratedRows: RatedRow[],
): { total: number; rated: number; unrated: T[] } {
  const ratedUris = new Set(ratedRows.map((r) => r.uri));
  const ratedIsrcs = new Set(
    ratedRows.map((r) => r.isrc).filter((i): i is string => i != null),
  );

  const seen = new Set<string>();
  let total = 0;
  let rated = 0;
  const unrated: T[] = [];
  for (const t of tracks) {
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    total++;
    if (ratedUris.has(t.uri) || (t.isrc != null && ratedIsrcs.has(t.isrc))) rated++;
    else unrated.push(t);
  }
  return { total, rated, unrated };
}
