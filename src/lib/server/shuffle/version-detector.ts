// Pure functions for detecting song versions and grouping families/duplicates.
// No I/O — input is track metadata, output is derived columns.
//
// Two anti-false-positive rules drive everything here:
//   1. Version markers are only recognized inside delimited *suffixes* —
//      parens "(...)", brackets "[...]", or dash-separated " - ..." tails.
//      A title like "Live and Let Die" must NOT be detected as a live version.
//   2. Detection prefers specificity: re_recording > sped_up/slowed > acoustic
//      > live > remix > demo > instrumental > edit/extended > cover > other.
//      A "Taylor's Version (Acoustic)" is a re-recording first, acoustic second.

export type VersionType =
  | 'original'
  | 'acoustic'
  | 'live'
  | 'remix'
  | 'demo'
  | 'instrumental'
  | 'extended'
  | 'edit'
  | 'cover'
  | 'sped_up'
  | 'slowed'
  | 're_recording'
  | 'other';

const VERSION_PATTERNS: Array<{ type: VersionType; rx: RegExp }> = [
  // Most-specific first — first match wins.
  { type: 're_recording', rx: /\b(taylor'?s\s+version|re[\s-]?recorded|re[\s-]?recording|\d{4}\s+version)\b/i },
  { type: 'sped_up', rx: /\b(sped[\s-]?up|nightcore)\b/i },
  { type: 'slowed', rx: /\b(slowed(?:\s*(?:\+|and|&)\s*reverb)?|slowed\s+down|chopped\s+and\s+screwed)\b/i },
  { type: 'acoustic', rx: /\b(acoustic|stripped(?:\s+(?:back|down))?|unplugged)\b/i },
  { type: 'live', rx: /\b(live(?:\s+(?:at|from|in|on|version|recording|performance))?|en\s+vivo|concert\s+version)\b/i },
  { type: 'instrumental', rx: /\b(instrumental|karaoke|backing\s+track)\b/i },
  { type: 'demo', rx: /\b(demo|alt(?:ernate|ernative)?(?:\s+(?:take|version|mix))?|early\s+(?:take|version|recording)|rough\s+(?:mix|cut)|outtake)\b/i },
  // remix family — broad. Keep after demo/acoustic/live so those win.
  { type: 'remix', rx: /\b(remix|rmx|club\s+mix|radio\s+mix|VIP\s+mix|rework|dub\s+mix|flip)\b/i },
  { type: 'extended', rx: /\b(extended(?:\s+(?:mix|version|cut))?|12["”]\s*(?:mix|version))\b/i },
  { type: 'edit', rx: /\b(radio\s+edit|edit|short\s+version|single\s+version)\b/i },
  // Cover detection in title is rare; usually inferred from artist mismatch elsewhere.
  { type: 'cover', rx: /\b(cover(?:\s+version|ed)?)\b/i },
];

// Album-context patterns — when the album title implies the whole record is a variant.
const ALBUM_VERSION_PATTERNS: Array<{ type: VersionType; rx: RegExp }> = [
  { type: 'live', rx: /\b(live\s+(?:at|from|in)|unplugged|in\s+concert|live\s+album)\b/i },
  { type: 'acoustic', rx: /\b(acoustic\s+(?:sessions?|version|album)|stripped(?:\s+down)?(?:\s+sessions?)?)\b/i },
  { type: 'demo', rx: /\b(demos?(?:\s+(?:album|collection))?|early\s+years|outtakes)\b/i },
];

// Diacritics + symbol normalization for canonical title.
const PUNCT_RX = /[.,;:!?'"()[\]{}\-–—_/\\@#$%^&*+=<>|~`]/g;
const FEAT_RX = /\s*(?:feat(?:uring)?\.?|ft\.?|with)\s+.+$/i;

// Any word that signals "this title's tail is a version marker, not real title text."
// Used both to decide whether to strip a (...) / [...] / - ... suffix and to extract
// the full set of suffix regions for version-type detection.
const ANY_MARKER_RX =
  /\b(taylor'?s\s+version|re[\s-]?recorded|re[\s-]?recording|\d{4}\s+version|sped[\s-]?up|nightcore|slowed|chopped|acoustic|stripped|unplugged|live|en\s+vivo|instrumental|karaoke|backing|demo|alt(?:ernate|ernative)?|early|rough|outtake|remix|rmx|club\s+mix|radio|VIP|rework|dub|flip|extended|12["”]\s*(?:mix|version)|edit|short\s+version|single\s+version|cover|remaster(?:ed)?|mono|stereo|deluxe|bonus(?:\s+track)?)\b/i;

// Trailing (paren) | [bracket] | - dash-tail region — properly matched braces required.
// Tries each in turn; returns { stem, tail } if found.
function popSuffix(title: string): { stem: string; tail: string } | null {
  const paren = title.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren) return { stem: paren[1], tail: paren[2] };
  const bracket = title.match(/^(.*?)\s*\[([^\[\]]*)\]\s*$/);
  if (bracket) return { stem: bracket[1], tail: bracket[2] };
  const dash = title.match(/^(.*?)\s+[-–—]\s+(.+)$/);
  if (dash) return { stem: dash[1], tail: dash[2] };
  return null;
}

/**
 * Iteratively peel version-marker suffixes off the right side of a title.
 * "Love Story (Taylor's Version) (Acoustic)" → "Love Story"
 * "Lithium [Remastered 2011]" → "Lithium"
 * "Hurt - Acoustic Version" → "Hurt"
 * Non-marker tails are preserved: "(Sittin' On) The Dock of the Bay" stays put
 * because the parens come at the head, not the tail.
 */
function stripVersionSuffix(title: string): string {
  let current = title.trim();
  while (true) {
    const popped = popSuffix(current);
    if (!popped || !ANY_MARKER_RX.test(popped.tail)) return current;
    current = popped.stem.trim();
  }
}

/**
 * Extract ALL trailing version-marker regions concatenated. Used so that
 * "Love Story (Taylor's Version) (Acoustic)" considers both markers and picks
 * the most specific (re_recording).
 */
function extractAllSuffixes(title: string): string {
  const tails: string[] = [];
  let current = title.trim();
  while (true) {
    const popped = popSuffix(current);
    if (!popped || !ANY_MARKER_RX.test(popped.tail)) break;
    tails.unshift(popped.tail);
    current = popped.stem.trim();
  }
  return tails.join(' || ');
}

/**
 * Build a canonical title for family grouping.
 * - strips version suffix
 * - strips "feat." credits
 * - removes diacritics
 * - removes most punctuation
 * - lowercases
 * - collapses whitespace
 *
 * Two tracks with the same canonical title + primary artist are versions of
 * the same composition.
 */
export function canonicalTitle(title: string): string {
  let t = stripVersionSuffix(title);
  t = t.replace(FEAT_RX, '');
  // Unicode-normalize then strip combining marks (diacritics).
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(PUNCT_RX, ' ');
  t = t.toLowerCase().replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Detect version type from title + (optional) album context.
 * Returns 'original' when no version markers found.
 */
export function detectVersionType(title: string, album?: string | null): VersionType {
  // Look at ALL suffix regions — "Title (TV) (Acoustic)" should consider both,
  // and the most-specific pattern in VERSION_PATTERNS wins.
  const suffixes = extractAllSuffixes(title);
  if (suffixes) {
    for (const { type, rx } of VERSION_PATTERNS) {
      if (rx.test(suffixes)) return type;
    }
  }

  if (album) {
    for (const { type, rx } of ALBUM_VERSION_PATTERNS) {
      if (rx.test(album)) return type;
    }
  }

  return 'original';
}

/**
 * Stable, human-readable family ID. All versions of the same composition
 * share this. Returns null when primaryArtistId is missing (track hasn't
 * been enriched yet — leave the family column null too).
 *
 * Format: "<artist_id>::<canonical_title>". Long but indexable and trivially
 * debuggable. If collisions ever become a problem, switch to a hash; for now,
 * readability wins.
 */
export function songFamilyId(
  primaryArtistId: string | null | undefined,
  canonical: string,
): string | null {
  if (!primaryArtistId || !canonical) return null;
  return `${primaryArtistId}::${canonical}`;
}

/**
 * Tells the caller whether two tracks in the same family are likely the
 * SAME recording (so they should share rating + cooldown via duplicate_group_id).
 *
 * Rules:
 *  - Same ISRC → definitely same recording.
 *  - Same family + no version markers in either title + duration within 1s → likely same.
 *  - Otherwise → different recordings (variant).
 *
 * The caller groups apparent-duplicates into a duplicate_group_id; the sampler
 * then rotates URIs round-robin within the group to surface hidden variants.
 */
export function isApparentDuplicate(
  a: { isrc?: string | null; durationMs?: number | null; versionType: VersionType },
  b: { isrc?: string | null; durationMs?: number | null; versionType: VersionType },
): boolean {
  if (a.isrc && b.isrc && a.isrc === b.isrc) return true;
  if (a.versionType !== 'original' || b.versionType !== 'original') return false;
  if (!a.durationMs || !b.durationMs) return false;
  return Math.abs(a.durationMs - b.durationMs) <= 1000;
}
