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

import { POST } from '../../src/routes/api/spotify/player/control/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('POST /api/spotify/player/control', () => {
  it('rejects when not logged in', async () => {
    await expect(POST(makeEvent({ action: 'next' }, null))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unknown action', async () => {
    await expect(POST(makeEvent({ action: 'frobnicate' }))).rejects.toMatchObject({ status: 400 });
  });

  it('forwards next as POST to the next endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await POST(makeEvent({ action: 'next' }));
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player/next');
    expect(init.method).toBe('POST');
  });

  describe('queue action', () => {
    it('requires a uri', async () => {
      await expect(POST(makeEvent({ action: 'queue' }))).rejects.toMatchObject({ status: 400 });
    });

    it('forwards the uri to Spotify, URL-encoded', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const res = await POST(makeEvent({ action: 'queue', uri: 'spotify:track:abc123' }));
      expect(res.status).toBe(204);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.spotify.com/v1/me/player/queue?uri=spotify%3Atrack%3Aabc123',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tkn');
    });

    it('maps no-active-device to 409', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { reason: 'NO_ACTIVE_DEVICE' } }), { status: 404 }),
      );
      const res = await POST(makeEvent({ action: 'queue', uri: 'spotify:track:x' }));
      expect(res.status).toBe(409);
    });
  });
});
