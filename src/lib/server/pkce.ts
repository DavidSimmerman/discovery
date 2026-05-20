import { randomBytes, createHash } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  // 32 bytes → 43 base64url chars (within the 43–128 spec range)
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computeChallenge(verifier);
  return { verifier, challenge };
}

export function computeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
