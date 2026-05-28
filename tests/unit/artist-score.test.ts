import { describe, it, expect } from 'vitest';
import {
  starPoints,
  trackRankBonus,
  artistRankMultiplier,
  artistScore,
} from '../../src/lib/server/artist-score';

describe('starPoints', () => {
  it('maps stars to the documented point values', () => {
    expect(starPoints(0)).toBe(-2);
    expect(starPoints(1)).toBe(-1);
    expect(starPoints(2)).toBe(1);
    expect(starPoints(3)).toBe(2);
    expect(starPoints(4)).toBe(5);
    expect(starPoints(5)).toBe(10);
  });

  it('returns 0 for out-of-range values', () => {
    expect(starPoints(-1)).toBe(0);
    expect(starPoints(6)).toBe(0);
  });
});

describe('trackRankBonus', () => {
  it('is 0 when not in top tracks', () => {
    expect(trackRankBonus(null)).toBe(0);
    expect(trackRankBonus(undefined)).toBe(0);
    expect(trackRankBonus(51)).toBe(0);
  });

  it('applies tiered bonuses', () => {
    expect(trackRankBonus(1)).toBe(10);
    expect(trackRankBonus(10)).toBe(10);
    expect(trackRankBonus(11)).toBe(5);
    expect(trackRankBonus(25)).toBe(5);
    expect(trackRankBonus(26)).toBe(3);
    expect(trackRankBonus(50)).toBe(3);
  });
});

describe('artistRankMultiplier', () => {
  it('is 1.0 when not in top artists', () => {
    expect(artistRankMultiplier(null)).toBe(1);
    expect(artistRankMultiplier(51)).toBe(1);
  });

  it('applies tiered multipliers', () => {
    expect(artistRankMultiplier(1)).toBe(1.15);
    expect(artistRankMultiplier(2)).toBe(1.10);
    expect(artistRankMultiplier(5)).toBe(1.10);
    expect(artistRankMultiplier(6)).toBe(1.075);
    expect(artistRankMultiplier(15)).toBe(1.075);
    expect(artistRankMultiplier(16)).toBe(1.05);
    expect(artistRankMultiplier(30)).toBe(1.05);
    expect(artistRankMultiplier(31)).toBe(1.025);
    expect(artistRankMultiplier(50)).toBe(1.025);
  });
});

describe('artistScore', () => {
  it('returns 0 for no tracks', () => {
    expect(artistScore([], null)).toBe(0);
  });

  it('sums star points without bonuses', () => {
    // 5★ + 4★ + 1★ = 10 + 5 + (-1) = 14
    expect(artistScore([{ stars: 5 }, { stars: 4 }, { stars: 1 }], null)).toBe(14);
  });

  it('adds per-track rank bonus to each qualifying track', () => {
    // 5★ + top-10 bonus = 10 + 10 = 20
    expect(artistScore([{ stars: 5, trackRank: 1 }], null)).toBe(20);
  });

  it('multiplies the summed total by the artist rank multiplier', () => {
    // (10 + 10) * 1.15 = 23
    expect(artistScore([{ stars: 5 }, { stars: 5 }], 1)).toBeCloseTo(23);
  });

  it('combines per-track bonus and artist multiplier', () => {
    // 5★ + top-10 bonus = 20, then * 1.10 (top-5 artist) = 22
    expect(artistScore([{ stars: 5, trackRank: 1 }], 5)).toBeCloseTo(22);
  });

  it('negative star points can drive the total below zero', () => {
    expect(artistScore([{ stars: 0 }, { stars: 1 }], null)).toBe(-3);
  });
});
