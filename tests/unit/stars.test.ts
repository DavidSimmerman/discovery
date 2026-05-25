import { describe, it, expect } from 'vitest';
import { stars } from '$lib/playback/stars';

describe('stars()', () => {
  it('returns empty string for null/0', () => {
    expect(stars(null)).toBe('');
    expect(stars(0)).toBe('');
  });
  it('renders integer ratings as integers', () => {
    expect(stars(2)).toBe('1');
    expect(stars(4)).toBe('2');
    expect(stars(10)).toBe('5');
  });
  it('renders half ratings with one decimal', () => {
    expect(stars(1)).toBe('0.5');
    expect(stars(3)).toBe('1.5');
    expect(stars(5)).toBe('2.5');
    expect(stars(9)).toBe('4.5');
  });
});
