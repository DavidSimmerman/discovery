import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const updateSet = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({
  db: {
    update: () => ({
      set: (vals: unknown) => {
        updateSet(vals);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock('$lib/server/db/schema', () => ({ users: { id: 'users.id' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { ensureSavedTrack } from '../../src/lib/server/spotify-library';

const URI = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh';
const ID = '4iV5W9uYEdYUVa79Axb7Rh';

beforeEach(() => {
  fetchMock.mockReset();
  updateSet.mockReset();
});

describe('ensureSavedTrack', () => {
  it('saves the track when not already in Liked Songs', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([false]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await ensureSavedTrack('u1', URI);

    const [containsUrl] = fetchMock.mock.calls[0] as [string];
    expect(containsUrl).toBe(`https://api.spotify.com/v1/me/tracks/contains?ids=${ID}`);

    const [saveUrl, saveInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(saveUrl).toBe('https://api.spotify.com/v1/me/tracks');
    expect(saveInit.method).toBe('PUT');
    expect(JSON.parse(saveInit.body as string)).toEqual({ ids: [ID] });
  });

  it('does NOT re-save when already liked (re-adding bumps added_at and reorders Liked Songs)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([true]), { status: 200 }));
    await ensureSavedTrack('u1', URI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the save when the contains check fails (no blind writes)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await ensureSavedTrack('u1', URI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flags the user for re-auth when the save 403s (token predates user-library-modify)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([false]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(ensureSavedTrack('u1', URI)).resolves.toBeUndefined();
    expect(updateSet).toHaveBeenCalledWith({ needsReauth: true });
  });

  it('does not flag re-auth on success or transient failure', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([false]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await ensureSavedTrack('u1', URI);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([false]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 502 }));
    await ensureSavedTrack('u1', URI);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('ignores non-track URIs', async () => {
    await ensureSavedTrack('u1', 'spotify:episode:xyz');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
