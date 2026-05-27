import { describe, it, expect } from 'vitest';
import { sameSong, groupSongs, type Groupable } from '$lib/song-group';
import { canonicalTitle } from '$lib/song-canonical';

function mk(
  uri: string,
  title: string | null,
  family: string | null = null,
  canonical: string | null = null,
): Groupable {
  return { uri, title, songFamilyId: family, canonicalTitle: canonical };
}

describe('sameSong', () => {
  it('matches on shared songFamilyId', () => {
    expect(sameSong(mk('a', 'Love Story', 'fam-1'), mk('b', 'Love Story (TV)', 'fam-1'))).toBe(true);
  });

  it('does not match when canonicals differ and no shared family', () => {
    expect(sameSong(mk('a', 'Love Story'), mk('b', 'Blank Space'))).toBe(false);
  });

  it('matches by runtime-canonicalized title when family id missing', () => {
    expect(sameSong(mk('a', 'Hurt (Acoustic)'), mk('b', 'Hurt'))).toBe(true);
  });

  it('matches collab variants on either side of a "(with X)" suffix', () => {
    expect(
      sameSong(mk('a', 'Calling All Angels (with Quinn XCII)'), mk('b', 'Calling All Angels')),
    ).toBe(true);
    expect(
      sameSong(
        mk('a', 'Calling All Angels (with Quinn XCII)'),
        mk('b', 'Calling All Angels (with Chelsea Cutler)'),
      ),
    ).toBe(true);
  });

  it('strips "- Live from X" dash suffix', () => {
    expect(sameSong(mk('a', 'Candle'), mk('b', 'Candle - Live from Red Rocks'))).toBe(true);
  });

  it('matches when one canonical is a word-bounded substring of another', () => {
    // If runtime canonicalization happens to leave extra tokens, substring catches it.
    expect(
      sameSong(
        mk('a', null, null, 'wonderwall'),
        mk('b', null, null, 'wonderwall unreleased session'),
      ),
    ).toBe(true);
  });

  it('does not match very short canonicals as substrings', () => {
    expect(sameSong(mk('a', null, null, 'a'), mk('b', null, null, 'alphabet song'))).toBe(false);
    expect(sameSong(mk('a', null, null, 'no'), mk('b', null, null, 'no diggity'))).toBe(false);
  });

  it('requires word boundary, not raw substring', () => {
    expect(sameSong(mk('a', null, null, 'love'), mk('b', null, null, 'loveliness'))).toBe(false);
    expect(sameSong(mk('a', null, null, 'love'), mk('b', null, null, 'love story'))).toBe(true);
  });
});

describe('groupSongs', () => {
  it('groups versions and collab variants together', () => {
    const tracks = [
      mk('uri:1', 'Calling All Angels (with Quinn XCII)'),
      mk('uri:2', 'Calling All Angels (with Chelsea Cutler)'),
      mk('uri:3', 'Candle'),
      mk('uri:4', 'Candle - Live from Red Rocks'),
      mk('uri:5', 'Some Other Song'),
    ];
    const groups = groupSongs(tracks);
    expect(groups).toHaveLength(3);
    expect(groups[0].map((t) => t.uri).sort()).toEqual(['uri:1', 'uri:2']);
    expect(groups[1].map((t) => t.uri).sort()).toEqual(['uri:3', 'uri:4']);
    expect(groups[2].map((t) => t.uri)).toEqual(['uri:5']);
  });

  it('returns each track in its own group when nothing matches', () => {
    const tracks = [mk('uri:1', 'A'), mk('uri:2', 'B'), mk('uri:3', 'C')];
    expect(groupSongs(tracks)).toHaveLength(3);
  });
});

describe('canonicalTitle (collab + version suffix handling)', () => {
  it('strips parenthesized collab suffix', () => {
    expect(canonicalTitle('Calling All Angels (with Quinn XCII)')).toBe('calling all angels');
  });

  it('strips dash-tail live suffix', () => {
    expect(canonicalTitle('Candle - Live from Red Rocks')).toBe('candle');
  });

  it('strips remaster suffix', () => {
    expect(canonicalTitle('Lithium [Remastered 2011]')).toBe('lithium');
  });
});
