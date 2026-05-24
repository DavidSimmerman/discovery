import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { PUT } from '../../src/routes/api/spotify/player/transfer/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/transfer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => fetchMock.mockReset());

describe('PUT /api/spotify/player/transfer', () => {
  it('rejects when not logged in', async () => {
    await expect(
      PUT(makeEvent({ device_id: 'd' }, null)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires device_id', async () => {
    await expect(
      PUT(makeEvent({})),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('forwards device_ids + play to Spotify', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await PUT(makeEvent({ device_id: 'dev1', play: false }));
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player');
    expect(JSON.parse(init.body as string)).toEqual({ device_ids: ['dev1'], play: false });
  });

  it('defaults play to false when omitted', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await PUT(makeEvent({ device_id: 'dev1' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ device_ids: ['dev1'], play: false });
  });
});
