import { describe, it, expect } from 'vitest';
import { formatPlays } from '$lib/format';

describe('formatPlays', () => {
  it('formats millions with one decimal', () => {
    expect(formatPlays(1_234_567)).toBe('1.2M');
    expect(formatPlays(12_000_000)).toBe('12.0M');
  });

  it('rounds 10K+ to whole thousands', () => {
    expect(formatPlays(45_200)).toBe('45K');
    expect(formatPlays(640_000)).toBe('640K');
  });

  it('keeps one decimal between 1K and 10K', () => {
    expect(formatPlays(1_500)).toBe('1.5K');
  });

  it('shows raw counts under 1000', () => {
    expect(formatPlays(512)).toBe('512');
    expect(formatPlays(0)).toBe('0');
  });
});
