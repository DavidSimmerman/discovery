// Group tracks that are versions of the same song. Used on artist pages so a
// song the user has rated multiple times (album + single + remaster + live)
// counts once toward the artist's score and shows as a single expandable row.
//
// Grouping rule (per primary artist):
//   1. Tracks sharing a non-null song_family_id are the same song.
//   2. As a fallback, two tracks share a song if they share a primary artist
//      and one's canonical_title is a word-bounded substring of the other's
//      (shorter canonical >= 4 chars to avoid "a" matching "alphabet").
//
// Rule 2 catches cases where the version-stripping in canonicalTitle misses
// a weird suffix, leaving "song title" and "song title weird tag" with
// different family ids but obviously the same song.

export type Groupable = {
  uri: string;
  songFamilyId: string | null;
  canonicalTitle: string | null;
  primaryArtistId: string | null;
};

const MIN_SUBSTRING_LEN = 4;

function wordBoundedContains(longer: string, shorter: string): boolean {
  if (shorter.length < MIN_SUBSTRING_LEN) return false;
  if (longer === shorter) return true;
  // Escape regex metachars in shorter; pad with word boundaries.
  const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(longer);
}

export function sameSong(a: Groupable, b: Groupable): boolean {
  if (a.songFamilyId && b.songFamilyId && a.songFamilyId === b.songFamilyId) return true;
  if (!a.primaryArtistId || !b.primaryArtistId) return false;
  if (a.primaryArtistId !== b.primaryArtistId) return false;
  const ca = a.canonicalTitle?.trim() ?? '';
  const cb = b.canonicalTitle?.trim() ?? '';
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return wordBoundedContains(longer, shorter);
}

/**
 * Partition tracks into groups of versions of the same song.
 * Greedy single-pass: each track joins the first existing group it matches,
 * else starts a new group. Order of returned groups follows first-appearance.
 */
export function groupSongs<T extends Groupable>(tracks: T[]): T[][] {
  const groups: T[][] = [];
  for (const t of tracks) {
    let placed = false;
    for (const g of groups) {
      if (sameSong(g[0], t)) {
        g.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([t]);
  }
  return groups;
}
