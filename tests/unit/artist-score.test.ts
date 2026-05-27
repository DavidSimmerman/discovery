import { describe, it, expect } from 'vitest';
import { bayesianScore } from '../../src/lib/server/artist-score';

describe('bayesianScore', () => {
  it('with n=0 → returns the global average', () => {
    expect(bayesianScore(0, 0, 3.0, 5)).toBeCloseTo(3.0);
  });

  it('with infinite m would equal globalAvg; with m=0 equals artistAvg', () => {
    expect(bayesianScore(5.0, 10, 3.0, 0)).toBeCloseTo(5.0);
  });

  it('single 5★ rating ranks BELOW a prolific 3.5★ artist (the user\'s example)', () => {
    const single = bayesianScore(5.0, 1, 3.0, 5);
    const prolific = bayesianScore(3.5, 30, 3.0, 5);
    expect(prolific).toBeGreaterThan(single);
  });

  it('artist with sustained high ratings beats both', () => {
    const single = bayesianScore(5.0, 1, 3.0, 5);
    const prolific = bayesianScore(3.5, 30, 3.0, 5);
    const sustained = bayesianScore(5.0, 30, 3.0, 5);
    expect(sustained).toBeGreaterThan(prolific);
    expect(sustained).toBeGreaterThan(single);
  });

  it('larger m makes small samples shrink harder toward global mean', () => {
    const m5 = bayesianScore(5.0, 1, 3.0, 5);
    const m20 = bayesianScore(5.0, 1, 3.0, 20);
    expect(m20).toBeLessThan(m5);
    expect(m20).toBeGreaterThan(3.0); // still pulled up by the 5★
  });

  it('two artists with identical avg but different volumes — higher volume wins', () => {
    const a = bayesianScore(4.0, 3, 3.0, 5);
    const b = bayesianScore(4.0, 30, 3.0, 5);
    expect(b).toBeGreaterThan(a);
  });
});
