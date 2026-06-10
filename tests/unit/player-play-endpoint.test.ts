import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock token + fetch before importing the handler.
vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { PUT } from '../../src/routes/api/spotify/player/play/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('PUT /api/spotify/player/play', () => {
  it('rejects when not logged in', async () => {
    await expect(
      PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }, null)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects when body has neither uris nor context_uri', async () => {
    await expect(
      PUT(makeEvent({ device_id: 'd' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('forwards { uris } payload to Spotify with device_id query', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await PUT(
      makeEvent({ uris: ['spotify:track:1', 'spotify:track:2'], device_id: 'dev1' }),
    );
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      uris: ['spotify:track:1', 'spotify:track:2'],
    });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tkn');
  });

  it('forwards position_ms on a { uris } payload (sampler re-push must not restart the track)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await PUT(makeEvent({ uris: ['spotify:track:1', 'spotify:track:2'], position_ms: 83500 }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      uris: ['spotify:track:1', 'spotify:track:2'],
      position_ms: 83500,
    });
  });

  it('forwards { context_uri, offset, position_ms } payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await PUT(
      makeEvent({
        context_uri: 'spotify:playlist:abc',
        offset: { uri: 'spotify:track:1' },
        position_ms: 42000,
        device_id: 'dev1',
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      context_uri: 'spotify:playlist:abc',
      offset: { uri: 'spotify:track:1' },
      position_ms: 42000,
    });
  });

  it('maps 404 NO_ACTIVE_DEVICE', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { reason: 'NO_ACTIVE_DEVICE' } }), { status: 404 }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_active_device' });
  });

  it('maps 403 PREMIUM_REQUIRED', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { reason: 'PREMIUM_REQUIRED' } }), { status: 403 }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'premium_required' });
  });

  it('maps 429 with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '3' } }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited', retry_after: 3 });
  });
});
