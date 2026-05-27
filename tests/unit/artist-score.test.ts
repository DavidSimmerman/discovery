import { describe, it, expect } from 'vitest';
import { artistScore } from '../../src/lib/server/artist-score';

describe('artistScore — hit-driven targets', () => {
  it('10 × 5★ → at least 4.95', () => {
    expect(artistScore(Array(10).fill(5))).toBeGreaterThanOrEqual(4.95);
  });

  it('15+ × 5★ → essentially 5.0', () => {
    expect(artistScore(Array(15).fill(5))).toBeGreaterThanOrEqual(4.99);
  });

  it('1 × 5★ → not too high (low-volume pull)', () => {
    const s = artistScore([5]);
    expect(s).toBeGreaterThan(3);
    expect(s).toBeLessThan(3.9);
  });

  it('3 × 5★ → ~4.4 (decent but small sample)', () => {
    const s = artistScore([5, 5, 5]);
    expect(s).toBeGreaterThan(4);
    expect(s).toBeLessThan(4.6);
  });

  it('no hits → neutral (3)', () => {
    expect(artistScore([])).toBe(3);
    expect(artistScore([1, 2, 2.5])).toBe(3);
    expect(artistScore(Array(30).fill(2))).toBe(3);
  });
});

describe('artistScore — misses are ignored', () => {
  it('hits + misses scores identically to hits alone', () => {
    const justHits = artistScore([5, 5, 5]);
    const withMisses = artistScore([5, 5, 5, 0.5, 0.5, 1, 2]);
    expect(withMisses).toBeCloseTo(justHits, 6);
  });

  it('30 songs with 10 hits matches 10 hits alone (the 20 misses are invisible)', () => {
    const withMisses = artistScore([...Array(10).fill(5), ...Array(20).fill(2)]);
    const justHits = artistScore(Array(10).fill(5));
    expect(withMisses).toBeCloseTo(justHits, 6);
  });
});

describe('artistScore — ordering invariants', () => {
  it('deep catalog of hits beats a one-hit-wonder', () => {
    expect(artistScore(Array(20).fill(5))).toBeGreaterThan(artistScore([5]));
  });

  it('volume monotonicity: more hits → higher score', () => {
    const a = artistScore([5]);
    const b = artistScore([5, 5, 5]);
    const c = artistScore(Array(10).fill(5));
    const d = artistScore(Array(20).fill(5));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });

  it('quality of hits matters: 5★ hits score above 3★ hits at same volume', () => {
    const fives = artistScore(Array(5).fill(5));
    const threes = artistScore(Array(5).fill(3));
    expect(fives).toBeGreaterThan(threes);
  });
});
