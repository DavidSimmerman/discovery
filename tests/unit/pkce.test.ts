import { describe, it, expect } from 'vitest';
import { generatePkce, computeChallenge } from '../../src/lib/server/pkce';
import { createHash } from 'node:crypto';

describe('pkce', () => {
  it('generates a 43-128 char verifier (base64url alphabet)', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('two calls produce different verifiers', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('computeChallenge agrees with generatePkce', () => {
    const { verifier, challenge } = generatePkce();
    expect(computeChallenge(verifier)).toBe(challenge);
  });
});
