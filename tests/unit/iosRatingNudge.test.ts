import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- nudgeUserActivities unit tests (poller side) ---------------------------

import {
  nudgeUserActivities,
  hashContentState,
  type PollerDeps,
  type ActivityContentState,
} from '$lib/server/liveActivityPoller';

const NOW = new Date('2026-06-10T12:00:00Z');
const PLAYING = {
  uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
  name: 'Song',
  artists: ['Artist A'],
  albumArtUrl: null,
  isPlaying: true,
};

function makeDeps(rows: unknown[]): PollerDeps & { pushes: unknown[][] } {
  const pushes: unknown[][] = [];
  const deps: PollerDeps = {
    listActiveActivities: async () => rows as never,
    getAccessToken: async () => 'access',
    fetchPlaying: async () => ({ playing: PLAYING, rating: 5 }),
    push: async (...args: unknown[]) => {
      pushes.push(args);
      return { ok: true as const, status: 200 };
    },
    updateRow: async () => {},
    now: () => NOW,
  };
  return Object.assign(deps, { pushes });
}

describe('nudgeUserActivities', () => {
  it('pushes the fresh state for the given user only', async () => {
    const deps = makeDeps([
      { id: 'la-1', userId: 'user-1', apnsPushToken: 'p1', contentStateHash: 'stale', lastTrackUri: null, stoppedSince: null },
      { id: 'la-2', userId: 'user-2', apnsPushToken: 'p2', contentStateHash: 'stale', lastTrackUri: null, stoppedSince: null },
    ]);
    await nudgeUserActivities('user-1', deps);
    expect(deps.pushes).toHaveLength(1);
    const [token, state] = deps.pushes[0] as [string, ActivityContentState];
    expect(token).toBe('p1');
    expect(state.rating).toBe(5);
  });

  it('does not push when the state is already current', async () => {
    const current: ActivityContentState = {
      trackUri: PLAYING.uri,
      title: 'Song',
      artists: 'Artist A',
      artworkUrl: null,
      rating: 5,
      isPlaying: true,
    };
    const deps = makeDeps([
      {
        id: 'la-1',
        userId: 'user-1',
        apnsPushToken: 'p1',
        contentStateHash: hashContentState(current),
        lastTrackUri: PLAYING.uri,
        stoppedSince: null,
      },
    ]);
    await nudgeUserActivities('user-1', deps);
    expect(deps.pushes).toHaveLength(0);
  });

  it('is a no-op for users with no active activity', async () => {
    const deps = makeDeps([]);
    await expect(nudgeUserActivities('user-1', deps)).resolves.not.toThrow();
    expect(deps.pushes).toHaveLength(0);
  });
});
