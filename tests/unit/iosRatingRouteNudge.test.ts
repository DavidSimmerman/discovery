import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const db = {
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  };
  return {
    db,
    findRatingByUriOrIsrc: vi.fn(),
    isrcForUri: vi.fn(),
    autoEnrichIfBehind: vi.fn(),
    ensureSavedTrack: vi.fn(),
    nudgeUserActivities: vi.fn(),
  };
});

vi.mock('$lib/server/db', () => ({ db: h.db }));
vi.mock('$lib/server/db/schema', () => ({
  ratings: { userId: 'user_id', spotifyTrackUri: 'spotify_track_uri' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
}));
vi.mock('$lib/server/ratings', () => ({
  findRatingByUriOrIsrc: h.findRatingByUriOrIsrc,
  isrcForUri: h.isrcForUri,
}));
vi.mock('$lib/server/shuffle/enrichment', () => ({ autoEnrichIfBehind: h.autoEnrichIfBehind }));
vi.mock('$lib/server/spotify-library', () => ({ ensureSavedTrack: h.ensureSavedTrack }));
vi.mock('$lib/server/liveActivityPoller', () => ({
  nudgeUserActivities: h.nudgeUserActivities,
}));

import { PUT, DELETE } from '../../src/routes/api/ratings/+server';

const URI = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh';

function event(body: unknown) {
  return {
    locals: { user: { id: 'user-1' } },
    request: { json: async () => body },
  } as never;
}

// The nudge fires through a fire-and-forget dynamic import; flush microtasks.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.findRatingByUriOrIsrc.mockResolvedValue(null);
  h.isrcForUri.mockResolvedValue(null);
  h.nudgeUserActivities.mockResolvedValue(undefined);
});

describe('ratings route → live-activity nudge', () => {
  it('PUT nudges the rater’s live activity', async () => {
    const res = await PUT(event({ spotifyTrackUri: URI, ratingStars: 4 }));
    expect(res.status).toBe(200);
    await flush();
    expect(h.nudgeUserActivities).toHaveBeenCalledWith('user-1');
  });

  it('DELETE nudges too', async () => {
    const res = await DELETE(event({ spotifyTrackUri: URI }));
    expect(res.status).toBe(200);
    await flush();
    expect(h.nudgeUserActivities).toHaveBeenCalledWith('user-1');
  });

  it('a failing nudge never breaks the response', async () => {
    h.nudgeUserActivities.mockRejectedValue(new Error('apns down'));
    const res = await PUT(event({ spotifyTrackUri: URI, ratingStars: 2 }));
    expect(res.status).toBe(200);
    await flush();
  });
});
