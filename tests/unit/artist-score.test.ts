import { describe, it, expect } from 'vitest';
import { artistScore } from '../../src/lib/server/artist-score';

describe('artistScore — hit volume', () => {
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

  it('volume monotonicity: more hits → higher score', () => {
    const a = artistScore([5]);
    const b = artistScore([5, 5, 5]);
    const c = artistScore(Array(10).fill(5));
    const d = artistScore(Array(20).fill(5));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });
});

describe('artistScore — misses matter when hits are few', () => {
  it('1 hit + 2 misses ≈ 1 hit + 0 misses (small drop)', () => {
    const clean = artistScore([5]);
    const fewMisses = artistScore([5, 0.5, 0.5]);
    expect(fewMisses).toBeLessThan(clean);
    expect(clean - fewMisses).toBeLessThan(0.4);
  });

  it('1 hit + 10 misses < 1 hit + 0 misses (meaningful drop)', () => {
    const clean = artistScore([5]);
    const manyMisses = artistScore([5, ...Array(10).fill(1)]);
    expect(manyMisses).toBeLessThan(clean - 0.3);
  });

  it('many hits absorb misses: 10H + 20M still scores high (~4.5+)', () => {
    const s = artistScore([...Array(10).fill(5), ...Array(20).fill(2)]);
    expect(s).toBeGreaterThan(4.5);
  });

  it('15 hits + many misses still ~5', () => {
    const s = artistScore([...Array(15).fill(5), ...Array(50).fill(2)]);
    expect(s).toBeGreaterThan(4.8);
  });
});

describe('artistScore — no hits', () => {
  it('no ratings at all → neutral (3)', () => {
    expect(artistScore([])).toBe(3);
  });

  it('only misses → below 3, decays with miss count', () => {
    const oneMiss = artistScore([1]);
    const fiveMisses = artistScore([1, 1, 1, 1, 1]);
    const manyMisses = artistScore(Array(20).fill(1));
    expect(oneMiss).toBeLessThan(3);
    expect(fiveMisses).toBeLessThan(oneMiss);
    expect(manyMisses).toBeLessThan(fiveMisses);
  });
});

describe('artistScore — ordering invariants', () => {
  it('deep catalog of hits beats a one-hit-wonder', () => {
    expect(artistScore(Array(20).fill(5))).toBeGreaterThan(artistScore([5]));
  });

  it('quality of hits matters: 5★ hits score above 3★ hits at same volume', () => {
    expect(artistScore(Array(5).fill(5))).toBeGreaterThan(artistScore(Array(5).fill(3)));
  });

  it('score stays within [0, 5]', () => {
    expect(artistScore([5, 5, 5, 5, 5])).toBeLessThanOrEqual(5);
    expect(artistScore(Array(100).fill(0.5))).toBeGreaterThanOrEqual(0);
  });
});
