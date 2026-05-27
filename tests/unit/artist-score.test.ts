import { describe, it, expect } from 'vitest';
import { artistAverage, artistWeightedAverage } from '../../src/lib/server/artist-score';

describe('artistAverage', () => {
  it('returns 0 for no ratings', () => {
    expect(artistAverage([])).toBe(0);
  });

  it('returns the straight mean', () => {
    expect(artistAverage([5, 4, 3])).toBeCloseTo(4);
    expect(artistAverage([5])).toBe(5);
    expect(artistAverage([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe('artistWeightedAverage — tier: count ≤ 5', () => {
  it('returns 0 for no ratings', () => {
    expect(artistWeightedAverage([])).toBe(0);
  });

  it('5×5 ratings get multiplied by 21/25 (max ~4.2)', () => {
    expect(artistWeightedAverage([5, 5, 5, 5, 5])).toBeCloseTo(5 * (21 / 25));
  });

  it('one 5★ caps at 4.2', () => {
    expect(artistWeightedAverage([5])).toBeCloseTo(4.2);
  });

  it('average of [4, 2] × 21/25', () => {
    expect(artistWeightedAverage([4, 2])).toBeCloseTo(3 * (21 / 25));
  });
});

describe('artistWeightedAverage — tier: 6..10', () => {
  it('6 songs all 5★ → top 60% (ceil = 4), capped at 4.6', () => {
    expect(artistWeightedAverage(Array(6).fill(5))).toBe(4.6);
  });

  it('10 songs all 5★ → top 6, capped at 4.6', () => {
    expect(artistWeightedAverage(Array(10).fill(5))).toBe(4.6);
  });

  it('only the top 60% counts: low ratings outside top window are ignored', () => {
    // 10 ratings: top 6 are 5s, rest are 1s → mean = 5, capped at 4.6
    const rs = [...Array(6).fill(5), ...Array(4).fill(1)];
    expect(artistWeightedAverage(rs)).toBe(4.6);
  });

  it('cap applies: a top-60% mean below 4.6 is returned as-is', () => {
    const rs = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
    expect(artistWeightedAverage(rs)).toBe(4);
  });
});

describe('artistWeightedAverage — tier: 11..20', () => {
  it('20 songs all 5★ → top 10, no cap → 5.0', () => {
    expect(artistWeightedAverage(Array(20).fill(5))).toBe(5);
  });

  it('11 songs all 5★ → top 6 (ceil 5.5), 5.0', () => {
    expect(artistWeightedAverage(Array(11).fill(5))).toBe(5);
  });

  it('only top 50% counts', () => {
    const rs = [...Array(10).fill(5), ...Array(10).fill(1)];
    expect(artistWeightedAverage(rs)).toBe(5);
  });
});

describe('artistWeightedAverage — tier: 21+', () => {
  it('100 songs all 5★ → top 10 avg = 5.0', () => {
    expect(artistWeightedAverage(Array(100).fill(5))).toBe(5);
  });

  it('long tail of low ratings does not pull down the top 10', () => {
    const rs = [...Array(10).fill(5), ...Array(90).fill(1)];
    expect(artistWeightedAverage(rs)).toBe(5);
  });
});

describe('artistWeightedAverage — ordering invariants', () => {
  it('deep catalog of 5★s beats a one-hit-wonder', () => {
    expect(artistWeightedAverage(Array(20).fill(5))).toBeGreaterThan(artistWeightedAverage([5]));
  });

  it('stays within [0, 5]', () => {
    expect(artistWeightedAverage([5, 5, 5, 5, 5])).toBeLessThanOrEqual(5);
    expect(artistWeightedAverage(Array(100).fill(0))).toBeGreaterThanOrEqual(0);
  });
});
