import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted so the vi.mock factories can reference them) ------------
// db.insert().values().onConflictDoUpdate() resolves.
// db.delete().where() resolves.
const h = vi.hoisted(() => {
  const insertSpy = vi.fn();
  const valuesSpy = vi.fn();
  const onConflictSpy = vi.fn();
  const deleteSpy = vi.fn();
  const whereSpy = vi.fn();
  const db = {
    insert: vi.fn((table: unknown) => {
      insertSpy(table);
      return {
        values: vi.fn((vals: unknown) => {
          valuesSpy(vals);
          return {
            onConflictDoUpdate: vi.fn((cfg: unknown) => {
              onConflictSpy(cfg);
              return Promise.resolve();
            }),
          };
        }),
      };
    }),
    delete: vi.fn((table: unknown) => {
      deleteSpy(table);
      return {
        where: vi.fn((cond: unknown) => {
          whereSpy(cond);
          return Promise.resolve();
        }),
      };
    }),
  };
  return { insertSpy, valuesSpy, onConflictSpy, deleteSpy, whereSpy, db };
});

vi.mock('$lib/server/db', () => ({ db: h.db }));
vi.mock('$lib/server/db/schema', () => ({
  ratings: { userId: 'user_id', spotifyTrackUri: 'spotify_track_uri' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

import { PUT, DELETE } from '../../src/routes/api/ratings/+server';

const URI = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh';
const USER = { id: 'user-1' };

// Minimal RequestEvent-like shape: handlers only touch locals.user and request.json().
function event(opts: { user?: { id: string }; body?: unknown }) {
  return {
    locals: { user: opts.user },
    request: { json: async () => opts.body },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/ratings', () => {
  it('(a) valid body succeeds and calls db.insert', async () => {
    const res = await PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 7 } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ratingHalfSteps: 7 });
    expect(h.insertSpy).toHaveBeenCalledTimes(1);
    expect(h.valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', spotifyTrackUri: URI, ratingHalfSteps: 7 }),
    );
    expect(h.onConflictSpy).toHaveBeenCalledTimes(1);
  });

  it('passes isrc through when provided', async () => {
    await PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 5, isrc: 'USABC1234567' } }));
    expect(h.valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ isrc: 'USABC1234567' }));
  });

  it('(b) ratingHalfSteps = 0 → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 0 } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.insertSpy).not.toHaveBeenCalled();
  });

  it('(c) ratingHalfSteps = 11 → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 11 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('(d) non-integer ratingHalfSteps (3.5) → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: URI, ratingHalfSteps: 3.5 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('(e) malformed spotifyTrackUri → 400', async () => {
    await expect(
      PUT(event({ user: USER, body: { spotifyTrackUri: 'spotify:track:tooshort', ratingHalfSteps: 5 } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('(f) without locals.user → 401', async () => {
    await expect(
      PUT(event({ body: { spotifyTrackUri: URI, ratingHalfSteps: 5 } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.insertSpy).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/ratings', () => {
  it('(g) happy path → ok:true and calls db.delete', async () => {
    const res = await DELETE(event({ user: USER, body: { spotifyTrackUri: URI } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.deleteSpy).toHaveBeenCalledTimes(1);
    expect(h.whereSpy).toHaveBeenCalledTimes(1);
  });

  it('malformed spotifyTrackUri → 400', async () => {
    await expect(
      DELETE(event({ user: USER, body: { spotifyTrackUri: 'not-a-uri' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.deleteSpy).not.toHaveBeenCalled();
  });

  it('(h) without locals.user → 401', async () => {
    await expect(
      DELETE(event({ body: { spotifyTrackUri: URI } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.deleteSpy).not.toHaveBeenCalled();
  });
});
