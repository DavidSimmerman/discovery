// Feb-2026 Spotify API: `product` was removed from GET /me. An absent field
// must not downgrade the user to 'open' (which gates playback behind
// PremiumGate) — dev-mode apps require a Premium owner, so absent → 'premium'.

import { describe, it, expect, vi } from 'vitest';

vi.mock('$env/static/private', () => ({
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
}));
vi.mock('$env/static/public', () => ({ PUBLIC_BASE_URL: 'http://localhost' }));

import { normalizeProduct } from '$lib/server/spotify';

describe('normalizeProduct', () => {
  it('passes through known values', () => {
    expect(normalizeProduct('premium')).toBe('premium');
    expect(normalizeProduct('free')).toBe('free');
  });

  it('absent field (removed Feb 2026) → premium, not a downgrade', () => {
    expect(normalizeProduct(undefined)).toBe('premium');
    expect(normalizeProduct(null)).toBe('premium');
  });

  it('unknown strings → open (legacy behavior)', () => {
    expect(normalizeProduct('open')).toBe('open');
    expect(normalizeProduct('weird-future-tier')).toBe('open');
  });
});
