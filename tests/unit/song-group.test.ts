import { describe, it, expect } from 'vitest';
import { sameSong, groupSongs, type Groupable } from '$lib/song-group';

function mk(
  uri: string,
  family: string | null,
  canonical: string | null,
  primary: string | null = 'artist-1',
): Groupable {
  return { uri, songFamilyId: family, canonicalTitle: canonical, primaryArtistId: primary };
}

describe('sameSong', () => {
  it('matches on shared songFamilyId', () => {
    expect(sameSong(mk('a', 'fam-1', 'love story'), mk('b', 'fam-1', 'love story'))).toBe(true);
  });

  it('does not match when family ids differ and canonicals differ', () => {
    expect(sameSong(mk('a', 'fam-1', 'love story'), mk('b', 'fam-2', 'blank space'))).toBe(false);
  });

  it('falls back to canonical equality when family id missing', () => {
    expect(sameSong(mk('a', null, 'love story'), mk('b', null, 'love story'))).toBe(true);
  });

  it('matches when shorter canonical is a word-bounded substring of longer', () => {
    // Normalization missed a weird tag, but base title is contained.
    expect(
      sameSong(mk('a', 'fam-1', 'wonderwall'), mk('b', 'fam-2', 'wonderwall demo unreleased')),
    ).toBe(true);
  });

  it('does not match very short canonicals as substrings', () => {
    expect(sameSong(mk('a', 'fam-1', 'a'), mk('b', 'fam-2', 'alphabet song'))).toBe(false);
    expect(sameSong(mk('a', 'fam-1', 'no'), mk('b', 'fam-2', 'no diggity'))).toBe(false);
  });

  it('requires word boundary, not raw substring', () => {
    // "love" should not match "loveliness" — not a word-bounded match.
    expect(sameSong(mk('a', 'fam-1', 'love'), mk('b', 'fam-2', 'loveliness'))).toBe(false);
    // But "love" does match "love story".
    expect(sameSong(mk('a', 'fam-1', 'love'), mk('b', 'fam-2', 'love story'))).toBe(true);
  });

  it('requires the same primary artist for substring fallback', () => {
    expect(
      sameSong(
        mk('a', null, 'wonderwall', 'oasis'),
        mk('b', null, 'wonderwall acoustic cover', 'ryan-adams'),
      ),
    ).toBe(false);
  });

  it('does not match when primary artist is missing', () => {
    expect(sameSong(mk('a', null, 'song', null), mk('b', null, 'song', null))).toBe(false);
  });
});

describe('groupSongs', () => {
  it('groups versions together and keeps singletons separate', () => {
    const tracks = [
      mk('uri:1', 'fam-1', 'love story'),
      mk('uri:2', 'fam-1', 'love story'), // taylor's version, same family
      mk('uri:3', 'fam-2', 'blank space'),
      mk('uri:4', null, 'love story extra tag'), // substring fallback
    ];
    const groups = groupSongs(tracks);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((t) => t.uri).sort()).toEqual(['uri:1', 'uri:2', 'uri:4']);
    expect(groups[1].map((t) => t.uri)).toEqual(['uri:3']);
  });

  it('returns each track in its own group when nothing matches', () => {
    const tracks = [
      mk('uri:1', 'fam-1', 'a'),
      mk('uri:2', 'fam-2', 'b'),
      mk('uri:3', 'fam-3', 'c'),
    ];
    expect(groupSongs(tracks)).toHaveLength(3);
  });
});
