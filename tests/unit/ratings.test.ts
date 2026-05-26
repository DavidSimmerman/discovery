import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal chainable builder so `db.insert(x).values(y)` etc. resolve to a recorded call.
const h = vi.hoisted(() => {
  const calls = {
    insertValues: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    deleteWhere: vi.fn(),
  };
  const db = {
    insert: () => ({
      values: (vals: unknown) => {
        calls.insertValues(vals);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (vals: unknown) => {
        calls.updateSet(vals);
        return {
          where: (cond: unknown) => {
            calls.updateWhere(cond);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({
      where: (cond: unknown) => {
        calls.deleteWhere(cond);
        return Promise.resolve();
      },
    }),
  };
  const findRatingByUriOrIsrc = vi.fn();
  const isrcForUri = vi.fn();
  return { calls, db, findRatingByUriOrIsrc, isrcForUri };
});

vi.mock('$lib/server/db', () => ({ db: h.db }));
vi.mock('$lib/server/db/schema', () => ({
  ratings: { userId: 'user_id', spotifyTrackUri: 'spotify_track_uri' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));
vi.mock('$lib/server/ratings', () => ({
  findRatingByUriOrIsrc: h.findRatingByUriOrIsrc,
  isrcForUri: h.isrcForUri,
}));

import { PUT, DELETE } from '../../src/routes/api/ratings/+server';

const URI = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh';
const URI_DUP = 'spotify:track:1234567890abcdefghijkl';
const USER = { id: 'user-1' };

function event(opts: { user?: { id: string }; body?: unknown }) {
  return {
    locals: { user: opts.user },
    request: { json: async () => opts.body },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findRatingByUriOrIsrc.mockResolvedValue(null);
  h.isrcForUri.mockResolvedValue(null);
});

describe('PUT /api/ratings', () => {
  it('inserts a new row when no existing rating shares URI or ISRC', async () => {
    h.findRatingByUriOrIsrc.mockResolvedValue(null);
    const res = await PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 7, isrc: 'USABC1234567' } }));
    expect(res.status).toBe(200);
    expect(h.calls.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', spotifyTrackUri: URI, ratingHalfSteps: 7, isrc: 'USABC1234567' }),
    );
    expect(h.calls.updateSet).not.toHaveBeenCalled();
  });

  it('updates the canonical row in place when ISRC matches a different URI', async () => {
    // Duplicate-ISRC case: a row already exists for the same recording under URI_DUP.
    h.findRatingByUriOrIsrc.mockResolvedValue({ spotifyTrackUri: URI_DUP, ratingHalfSteps: 3 });
    const res = await PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 8, isrc: 'USABC1234567' } }));
    expect(res.status).toBe(200);
    expect(h.calls.insertValues).not.toHaveBeenCalled();
    expect(h.calls.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ ratingHalfSteps: 8, isrc: 'USABC1234567' }),
    );
    expect(h.calls.updateWhere).toHaveBeenCalledTimes(1);
  });

  it('falls back to tracks-table ISRC when body omits it', async () => {
    h.findRatingByUriOrIsrc.mockResolvedValue(null);
    h.isrcForUri.mockResolvedValue('USXYZ9999999');
    await PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 5 } }));
    expect(h.calls.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ isrc: 'USXYZ9999999' }),
    );
  });

  it('ratingHalfSteps = 0 → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 0 } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.calls.insertValues).not.toHaveBeenCalled();
  });

  it('ratingHalfSteps = 11 → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 11 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('non-integer ratingHalfSteps (3.5) → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 3.5 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('malformed spotifyTrackUri → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: 'spotify:track:tooshort', ratingHalfSteps: 5 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('without locals.user → 401', async () => {
    await expect(
      PUT(event({ body: { spotifyTrackUri: URI, ratingHalfSteps: 5 } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.calls.insertValues).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/ratings', () => {
  it('happy path → ok:true and deletes the row', async () => {
    const res = await DELETE(event({ user: USER, body: { spotifyTrackUri: URI } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.calls.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('targets the canonical (ISRC-matched) URI when the supplied URI is a duplicate', async () => {
    h.findRatingByUriOrIsrc.mockResolvedValue({ spotifyTrackUri: URI_DUP, ratingHalfSteps: 6 });
    await DELETE(event({ user: USER, body: { spotifyTrackUri: URI } }));
    expect(h.calls.deleteWhere).toHaveBeenCalledTimes(1);
    // The where condition is opaque under mocked drizzle, but we can at least
    // confirm we routed through findRatingByUriOrIsrc to get the canonical URI.
    expect(h.findRatingByUriOrIsrc).toHaveBeenCalledWith('user-1', URI);
  });

  it('malformed spotifyTrackUri → 400', async () => {
    await expect(
      DELETE(event({ user: USER, body: { spotifyTrackUri: 'not-a-uri' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.calls.deleteWhere).not.toHaveBeenCalled();
  });

  it('without locals.user → 401', async () => {
    await expect(
      DELETE(event({ body: { spotifyTrackUri: URI } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.calls.deleteWhere).not.toHaveBeenCalled();
  });
});
