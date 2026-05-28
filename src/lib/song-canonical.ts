// Pure title-canonicalization helpers, safe to import from both server and
// client code (no DB or env deps). Used by:
//  - enrichment worker, to persist tracks.canonical_title
//  - song-group.ts, as a runtime fallback when a track hasn't been enriched yet
//    (the schema columns are still null)
//
// Two anti-false-positive rules:
//   1. Version markers are only stripped from delimited *suffixes* —
//      parens "(...)", brackets "[...]", or dash-separated " - ..." tails.
//      "Live and Let Die" stays put.
//   2. Collaboration suffixes ("feat.", "ft.", "with") inside a delimited suffix
//      ARE stripped regardless of marker word — they're never part of the song.

const PUNCT_RX = /[.,;:!?'"()[\]{}\-–—_/\\@#$%^&*+=<>|~`]/g;
const FEAT_RX = /\s*(?:feat(?:uring)?\.?|ft\.?|with)\s+.+$/i;

// Any word that signals a delimited suffix is a version/collab tag, not real
// title text. "with" is included so "(with Quinn XCII)" peels off.
const ANY_MARKER_RX =
  /\b(taylor'?s\s+version|re[\s-]?recorded|re[\s-]?recording|\d{4}\s+version|sped[\s-]?up|nightcore|slowed|chopped|acoustic|stripped|unplugged|live|en\s+vivo|instrumental|karaoke|backing|demo|alt(?:ernate|ernative)?|early|rough|outtake|remix|rmx|club\s+mix|radio|VIP|rework|dub|flip|extended|12["”]\s*(?:mix|version)|edit|short\s+version|single\s+version|cover|remaster(?:ed)?|mono|stereo|deluxe|bonus(?:\s+track)?|feat(?:uring)?\.?|ft\.?|with)\b/i;

function popSuffix(title: string): { stem: string; tail: string } | null {
  const paren = title.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren) return { stem: paren[1], tail: paren[2] };
  const bracket = title.match(/^(.*?)\s*\[([^\[\]]*)\]\s*$/);
  if (bracket) return { stem: bracket[1], tail: bracket[2] };
  const dash = title.match(/^(.*?)\s+[-–—]\s+(.+)$/);
  if (dash) return { stem: dash[1], tail: dash[2] };
  return null;
}

function stripVersionSuffix(title: string): string {
  let current = title.trim();
  while (true) {
    const popped = popSuffix(current);
    if (!popped || !ANY_MARKER_RX.test(popped.tail)) return current;
    current = popped.stem.trim();
  }
}

/**
 * Build a canonical title for grouping versions/collabs of the same song:
 *  - strip version-marker suffixes ((Acoustic), [Remastered 2011], - Live)
 *  - strip collab suffixes ((with Quinn XCII), feat. Beyoncé)
 *  - remove diacritics
 *  - strip punctuation
 *  - lowercase, collapse whitespace
 */
export function canonicalTitle(title: string): string {
  let t = stripVersionSuffix(title);
  t = t.replace(FEAT_RX, '');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(PUNCT_RX, ' ');
  t = t.toLowerCase().replace(/\s+/g, ' ').trim();
  return t;
}
