import { describe, it, expect } from 'vitest';
import {
  canonicalTitle,
  detectVersionType,
  songFamilyId,
  isApparentDuplicate,
} from '$lib/server/shuffle/version-detector';

describe('canonicalTitle', () => {
  it('strips version suffix in parens', () => {
    expect(canonicalTitle('Hurt (Acoustic Version)')).toBe('hurt');
    expect(canonicalTitle('Lithium [Remastered 2011]')).toBe('lithium');
  });

  it('strips version suffix after dash', () => {
    expect(canonicalTitle('Hurt - Acoustic')).toBe('hurt');
    expect(canonicalTitle('Hurt – Live at Coachella')).toBe('hurt');
  });

  it('strips feat. credits', () => {
    expect(canonicalTitle('Heat Waves (feat. Glass Animals)')).toBe('heat waves');
    expect(canonicalTitle('Old Town Road ft. Billy Ray Cyrus')).toBe('old town road');
    // Bare-title "Remix" (no suffix delimiters) is NOT stripped — by design,
    // markers must be in a delimited suffix region. "feat." is always stripped.
    expect(canonicalTitle('Savage Remix feat. Beyoncé')).toBe('savage remix');
  });

  it('removes diacritics', () => {
    expect(canonicalTitle('Café del Mar')).toBe('cafe del mar');
    expect(canonicalTitle('Naïve')).toBe('naive');
  });

  it('normalizes punctuation and whitespace', () => {
    expect(canonicalTitle("Don't Stop Me Now")).toBe('don t stop me now');
    expect(canonicalTitle('Mr. Brightside')).toBe('mr brightside');
    expect(canonicalTitle('  Multiple   Spaces  ')).toBe('multiple spaces');
  });

  it('leaves non-version parens alone', () => {
    // "(Sittin' On) The Dock of the Bay" — the parens aren't a version marker.
    // Our detector strips this conservatively because we can't tell semantically;
    // but the test documents current behavior: trailing parens with no marker words
    // are NOT stripped.
    expect(canonicalTitle('Hurt (real song)')).toBe('hurt real song');
  });

  it('handles tracks where a version word IS the title (false-positive guard)', () => {
    expect(canonicalTitle('Live and Let Die')).toBe('live and let die');
    expect(canonicalTitle('Acoustic')).toBe('acoustic');
    expect(canonicalTitle('Demo')).toBe('demo');
  });
});

describe('detectVersionType', () => {
  it('detects acoustic in suffix', () => {
    expect(detectVersionType('Hurt (Acoustic)')).toBe('acoustic');
    expect(detectVersionType('Hurt - Acoustic Version')).toBe('acoustic');
    expect(detectVersionType('Hurt (Stripped)')).toBe('acoustic');
    expect(detectVersionType('Hurt - Unplugged')).toBe('acoustic');
  });

  it('detects live in suffix', () => {
    expect(detectVersionType('Hurt (Live)')).toBe('live');
    expect(detectVersionType('Hurt (Live at Coachella)')).toBe('live');
    expect(detectVersionType('Hurt - Live from MTV')).toBe('live');
  });

  it('detects remix family', () => {
    expect(detectVersionType('Levitating (DaBaby Remix)')).toBe('remix');
    expect(detectVersionType('One More Time - Club Mix')).toBe('remix');
    expect(detectVersionType('Truth Hurts (VIP Mix)')).toBe('remix');
  });

  it('detects demo / alt take', () => {
    expect(detectVersionType('Heroes (Demo)')).toBe('demo');
    expect(detectVersionType('Heroes - Alternate Take')).toBe('demo');
    expect(detectVersionType('Heroes (Early Version)')).toBe('demo');
  });

  it('detects instrumental', () => {
    expect(detectVersionType('Lithium (Instrumental)')).toBe('instrumental');
    expect(detectVersionType('Lithium - Karaoke Version')).toBe('instrumental');
  });

  it('detects sped up / slowed', () => {
    expect(detectVersionType("Cruel Summer (Sped Up)")).toBe('sped_up');
    expect(detectVersionType("Cruel Summer - Sped-Up Version")).toBe('sped_up');
    expect(detectVersionType("Cruel Summer (Nightcore)")).toBe('sped_up');
    expect(detectVersionType("Cruel Summer (Slowed)")).toBe('slowed');
    expect(detectVersionType("Cruel Summer (Slowed + Reverb)")).toBe('slowed');
    expect(detectVersionType("Cruel Summer - Slowed Down")).toBe('slowed');
  });

  it("detects re-recording (Taylor's Version etc.)", () => {
    expect(detectVersionType("Love Story (Taylor's Version)")).toBe('re_recording');
    expect(detectVersionType("Wildest Dreams (Taylors Version)")).toBe('re_recording');
    expect(detectVersionType('Heroes - Re-recorded')).toBe('re_recording');
    expect(detectVersionType('Heroes (2024 Version)')).toBe('re_recording');
  });

  it('prefers re_recording over acoustic when both markers present', () => {
    expect(detectVersionType("Love Story (Taylor's Version) (Acoustic)")).toBe('re_recording');
  });

  it("does NOT mistake version words in the main title as markers", () => {
    expect(detectVersionType('Live and Let Die')).toBe('original');
    expect(detectVersionType('Acoustic')).toBe('original');
    expect(detectVersionType('Demo')).toBe('original');
    expect(detectVersionType('Remix')).toBe('original');
    expect(detectVersionType('The Live Experience')).toBe('original');
  });

  it('falls back to album context when title is bare', () => {
    expect(detectVersionType('Hurt', 'MTV Unplugged in New York')).toBe('live');
    expect(detectVersionType('Hurt', 'Live at Wembley')).toBe('live');
    expect(detectVersionType('Hurt', 'The Acoustic Sessions')).toBe('acoustic');
    expect(detectVersionType('Hurt', 'Studio Album')).toBe('original');
  });

  it('returns original by default', () => {
    expect(detectVersionType('Anti-Hero')).toBe('original');
    expect(detectVersionType('Heat Waves')).toBe('original');
  });
});

describe('songFamilyId', () => {
  it('groups same artist + canonical title', () => {
    const a = songFamilyId('artist_x', canonicalTitle('Hurt'));
    const b = songFamilyId('artist_x', canonicalTitle('Hurt (Acoustic)'));
    const c = songFamilyId('artist_x', canonicalTitle('Hurt - Live'));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('separates different artists with same title (covers handled elsewhere)', () => {
    const nin = songFamilyId('artist_nin', canonicalTitle('Hurt'));
    const cash = songFamilyId('artist_cash', canonicalTitle('Hurt'));
    expect(nin).not.toBe(cash);
  });

  it('returns null when artist id missing', () => {
    expect(songFamilyId(null, 'hurt')).toBeNull();
    expect(songFamilyId(undefined, 'hurt')).toBeNull();
  });
});

describe('isApparentDuplicate', () => {
  it('same ISRC → duplicate', () => {
    expect(
      isApparentDuplicate(
        { isrc: 'USRC17607839', durationMs: 240000, versionType: 'original' },
        { isrc: 'USRC17607839', durationMs: 240050, versionType: 'original' },
      ),
    ).toBe(true);
  });

  it('any version marker on either side → not duplicate', () => {
    expect(
      isApparentDuplicate(
        { isrc: null, durationMs: 240000, versionType: 'original' },
        { isrc: null, durationMs: 240500, versionType: 'acoustic' },
      ),
    ).toBe(false);
  });

  it('two originals with near-identical duration → duplicate', () => {
    expect(
      isApparentDuplicate(
        { isrc: null, durationMs: 240000, versionType: 'original' },
        { isrc: null, durationMs: 240500, versionType: 'original' },
      ),
    ).toBe(true);
  });

  it('two originals with very different duration → not duplicate', () => {
    expect(
      isApparentDuplicate(
        { isrc: null, durationMs: 240000, versionType: 'original' },
        { isrc: null, durationMs: 250000, versionType: 'original' },
      ),
    ).toBe(false);
  });

  it('missing duration → not duplicate (conservative)', () => {
    expect(
      isApparentDuplicate(
        { isrc: null, durationMs: null, versionType: 'original' },
        { isrc: null, durationMs: 240000, versionType: 'original' },
      ),
    ).toBe(false);
  });
});
