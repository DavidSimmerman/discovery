import { describe, it, expect } from 'vitest';
import { shuffleFisherYates, buildQueueFromClick } from '$lib/playback/queue';

function seededRng(seed: number): () => number {
  // Mulberry32 — deterministic for tests.
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('shuffleFisherYates', () => {
  it('returns a permutation', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffleFisherYates(input, seededRng(1));
    expect(out).toHaveLength(5);
    expect([...out].sort()).toEqual([...input].sort());
  });
  it('does not mutate input', () => {
    const input = ['a', 'b', 'c'];
    shuffleFisherYates(input, seededRng(1));
    expect(input).toEqual(['a', 'b', 'c']);
  });
  it('handles empty / single element', () => {
    expect(shuffleFisherYates([], seededRng(1))).toEqual([]);
    expect(shuffleFisherYates(['x'], seededRng(1))).toEqual(['x']);
  });
  it('is deterministic for a seeded RNG', () => {
    const a = shuffleFisherYates(['1','2','3','4','5'], seededRng(42));
    const b = shuffleFisherYates(['1','2','3','4','5'], seededRng(42));
    expect(a).toEqual(b);
  });
});

describe('buildQueueFromClick', () => {
  it('puts clicked URI first', () => {
    const out = buildQueueFromClick('c', ['a','b','c','d','e'], seededRng(1));
    expect(out[0]).toBe('c');
  });
  it('rest is a permutation of the others', () => {
    const out = buildQueueFromClick('c', ['a','b','c','d','e'], seededRng(1));
    expect(out.slice(1).sort()).toEqual(['a','b','d','e']);
  });
  it('handles clicked URI not in list (still ends up first)', () => {
    const out = buildQueueFromClick('z', ['a','b','c'], seededRng(1));
    expect(out[0]).toBe('z');
    expect(out.slice(1).sort()).toEqual(['a','b','c']);
  });
  it('handles single-element list', () => {
    expect(buildQueueFromClick('a', ['a'], seededRng(1))).toEqual(['a']);
  });
});
