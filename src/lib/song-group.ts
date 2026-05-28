// Group tracks that are versions of the same song. Used on artist pages so a
// song the user has rated multiple times (album + single + remaster + live +
// duet appearing on each artist's catalog) counts once toward the artist's
// score and shows as a single expandable row.
//
// **Caller contract**: tracks passed in must already share a credited artist
// (e.g. all tracks on one artist's page, or all (track, artist) pairs that
// came out of an unnest grouped by artist). Grouping is then by canonical
// title only — primary_artist_id is NOT consulted, so cross-feature versions
// (Chelsea Cutler ft. Quinn XCII vs. Quinn XCII ft. Chelsea Cutler of the
// same song) merge when viewed on either artist's page.
//
// Grouping rule:
//   1. Tracks sharing a non-null song_family_id are the same song (fast path).
//   2. Otherwise, compute canonical title at runtime (so unenriched tracks
//      with a null canonical_title column still group correctly) and match by
//      equality OR word-bounded substring (shorter canonical ≥ 4 chars).

import { canonicalTitle } from '$lib/song-canonical';

export type Groupable = {
  uri: string;
  title: string | null;
  songFamilyId: string | null;
  canonicalTitle: string | null;
};

const MIN_SUBSTRING_LEN = 4;

function wordBoundedContains(longer: string, shorter: string): boolean {
  if (shorter.length < MIN_SUBSTRING_LEN) return false;
  if (longer === shorter) return true;
  const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(longer);
}

// Prefer the stored canonical (computed at enrichment time with the same
// algorithm). Fall back to a runtime canonicalization of the title so brand
// new ratings — where the enrichment worker hasn't run yet — still dedupe.
function resolveCanonical(t: Groupable): string {
  const stored = t.canonicalTitle?.trim();
  if (stored) return stored;
  if (t.title) return canonicalTitle(t.title);
  return '';
}

export function sameSong(a: Groupable, b: Groupable): boolean {
  if (a.songFamilyId && b.songFamilyId && a.songFamilyId === b.songFamilyId) return true;
  const ca = resolveCanonical(a);
  const cb = resolveCanonical(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return wordBoundedContains(longer, shorter);
}

/**
 * Partition tracks into groups of versions of the same song.
 * Caller must pre-partition by credited artist — see file header.
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
