import { describe, it, expect } from 'vitest';
import { mapSpotifyPlayError } from '$lib/playback/errors';

describe('mapSpotifyPlayError', () => {
  it('404 NO_ACTIVE_DEVICE → no_active_device', () => {
    expect(
      mapSpotifyPlayError(404, { error: { reason: 'NO_ACTIVE_DEVICE' } }),
    ).toEqual({ error: 'no_active_device' });
  });
  it('403 PREMIUM_REQUIRED → premium_required', () => {
    expect(
      mapSpotifyPlayError(403, { error: { reason: 'PREMIUM_REQUIRED' } }),
    ).toEqual({ error: 'premium_required' });
  });
  it('429 → rate_limited with retry_after seconds', () => {
    expect(mapSpotifyPlayError(429, {}, '7')).toEqual({
      error: 'rate_limited',
      retry_after: 7,
    });
  });
  it('429 with missing header → rate_limited, retry_after undefined', () => {
    expect(mapSpotifyPlayError(429, {})).toEqual({ error: 'rate_limited' });
  });
  it('5xx → transient', () => {
    expect(mapSpotifyPlayError(502, {})).toEqual({ error: 'transient' });
    expect(mapSpotifyPlayError(503, {})).toEqual({ error: 'transient' });
  });
  it('unknown 4xx → transient', () => {
    expect(mapSpotifyPlayError(418, {})).toEqual({ error: 'transient' });
  });
});
