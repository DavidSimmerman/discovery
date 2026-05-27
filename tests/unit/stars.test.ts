import { describe, it, expect } from 'vitest';
import { stars } from '$lib/playback/stars';

describe('stars()', () => {
  it('returns empty string for null/0', () => {
    expect(stars(null)).toBe('');
    expect(stars(0)).toBe('');
  });
  it('renders whole-star ratings as integer + ★', () => {
    expect(stars(1)).toBe('1★');
    expect(stars(2)).toBe('2★');
    expect(stars(3)).toBe('3★');
    expect(stars(4)).toBe('4★');
    expect(stars(5)).toBe('5★');
  });
});
