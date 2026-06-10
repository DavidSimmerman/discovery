// Hard candidate pre-filter: applies ShuffleFilters (rating mode/range,
// artist/genre/label include-only + exclude, version excludes, explicit)
// AFTER source merging and BEFORE the sampler. Pure — unit-testable without
// DB or Spotify.
//
// Semantics, per axis:
// - exclude always wins (a track matching any exclude is out, even if it also
//   matches an include).
// - include non-empty = "only these": a track must match at least one include
//   entry on that axis. Empty include = no restriction.
// - A track with NO value on an axis (no genres, unknown version) passes
//   include-only restrictions on that axis only when the axis has no includes;
//   with includes set, valueless tracks are excluded (they can't match).
// - Explicit: allowExplicit=false drops only KNOWN-explicit tracks; unknown
//   (null, not yet enriched) passes — we don't hide what we can't classify.

import type { Candidate } from './sampler';
import type { ShuffleFilters } from './config';

export function applyFilters(
  candidates: Candidate[],
  filters: ShuffleFilters,
  // label ids applied to each URI by this user (track_labels)
  labelsByUri: Map<string, string[]>,
): Candidate[] {
  const artistInclude = new Set(filters.artists.include.map((e) => e.id));
  const artistExclude = new Set(filters.artists.exclude.map((e) => e.id));
  const genreInclude = new Set(filters.genres.include.map((e) => e.id));
  const genreExclude = new Set(filters.genres.exclude.map((e) => e.id));
  const labelInclude = new Set(filters.labels.include.map((e) => e.id));
  const labelExclude = new Set(filters.labels.exclude.map((e) => e.id));
  const versionExclude = new Set(filters.versionTypes.exclude);
  const { mode, minStars, maxStars } = filters.rating;

  return candidates.filter((c) => {
    // Rating mode + star range (range judges rated candidates only).
    if (mode === 'unrated' && c.rating != null) return false;
    if (mode === 'rated' && c.rating == null) return false;
    if (c.rating != null && (c.rating < minStars || c.rating > maxStars)) return false;

    // Artists
    if (c.artistIds.some((a) => artistExclude.has(a))) return false;
    if (artistInclude.size > 0 && !c.artistIds.some((a) => artistInclude.has(a))) return false;

    // Genres
    if (c.genres.some((g) => genreExclude.has(g))) return false;
    if (genreInclude.size > 0 && !c.genres.some((g) => genreInclude.has(g))) return false;

    // Labels
    const labels = labelsByUri.get(c.uri) ?? [];
    if (labels.some((l) => labelExclude.has(l))) return false;
    if (labelInclude.size > 0 && !labels.some((l) => labelInclude.has(l))) return false;

    // Version type (exclude-only; null/undetected never matches an exclude)
    if (c.versionType != null && versionExclude.has(c.versionType)) return false;

    // Explicit
    if (!filters.allowExplicit && c.explicit === true) return false;

    return true;
  });
}
