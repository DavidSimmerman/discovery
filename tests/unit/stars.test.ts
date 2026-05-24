import { describe, it, expect } from 'vitest';
import { stars } from '$lib/playback/stars';

describe('stars()', () => {
  it('returns empty string for null/0', () => {
    expect(stars(null)).toBe('');
    expect(stars(0)).toBe('');
  });
  it('renders half stars', () => {
    expect(stars(1)).toBe('½');
    // We use 0–10 half-steps. 1 = ½, 2 = ★, 3 = ★½, …, 10 = ★★★★★.
  });
  it('renders integer ratings', () => {
    expect(stars(2)).toBe('★');
    expect(stars(4)).toBe('★★');
    expect(stars(10)).toBe('★★★★★');
  });
  it('renders mixed half ratings', () => {
    expect(stars(3)).toBe('★½');
    expect(stars(5)).toBe('★★½');
    expect(stars(9)).toBe('★★★★½');
  });
});
