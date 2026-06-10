import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GET } from '../../src/routes/api/spotify/queue/+server';

function makeEvent(user: { id: string } | null = { id: 'u1' }) {
  return { locals: { user } } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('GET /api/spotify/queue', () => {
  it('rejects when not logged in', async () => {
    await expect(GET(makeEvent(null))).rejects.toMatchObject({ status: 401 });
  });

  it('passes album art through the slimmed queue payload', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          currently_playing: {
            uri: 'spotify:track:cur',
            name: 'Current',
            artists: [{ name: 'A' }],
            album: { images: [{ url: 'https://i.scdn.co/image/cur-640' }, { url: 'https://i.scdn.co/image/cur-300' }] },
          },
          queue: [
            {
              uri: 'spotify:track:q1',
              name: 'Queued',
              artists: [{ name: 'B' }, { name: 'C' }],
              album: { images: [{ url: 'https://i.scdn.co/image/q1-640' }] },
            },
            // Slim/edge object without album — must not blow up.
            { uri: 'spotify:track:q2', name: 'NoArt', artists: [] },
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await GET(makeEvent());
    const body = (await res.json()) as {
      currently_playing: { albumArtUrl: string | null };
      queue: { uri: string; albumArtUrl: string | null }[];
    };

    expect(body.currently_playing.albumArtUrl).toBe('https://i.scdn.co/image/cur-640');
    expect(body.queue[0]).toMatchObject({
      uri: 'spotify:track:q1',
      name: 'Queued',
      artists: ['B', 'C'],
      albumArtUrl: 'https://i.scdn.co/image/q1-640',
    });
    expect(body.queue[1].albumArtUrl).toBeNull();
  });

  it('returns an empty shape on non-OK upstream', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await GET(makeEvent());
    expect(await res.json()).toEqual({ currently_playing: null, queue: [] });
  });
});
