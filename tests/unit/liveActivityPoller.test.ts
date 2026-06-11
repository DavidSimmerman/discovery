import { describe, it, expect, vi } from 'vitest';
import {
  computeContentState,
  hashContentState,
  decidePollAction,
  tickOnce,
  STOPPED_END_MS,
  type ActivityContentState,
  type PollerDeps,
} from '$lib/server/liveActivityPoller';

const PLAYING = {
  uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
  name: 'Song',
  artists: ['Artist A', 'Artist B'],
  albumArtUrl: 'https://img/abc.jpg',
  isPlaying: true,
};

function state(overrides: Partial<ActivityContentState> = {}): ActivityContentState {
  return {
    trackUri: PLAYING.uri,
    title: 'Song',
    artists: 'Artist A, Artist B',
    artworkUrl: 'https://img/abc.jpg',
    rating: 4,
    isPlaying: true,
    ...overrides,
  };
}

const NOW = new Date('2026-06-10T12:00:00Z');
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'la-1',
  userId: 'user-1',
  apnsPushToken: 'ptok',
  contentStateHash: null as string | null,
  lastTrackUri: null as string | null,
  stoppedSince: null as Date | null,
  ...overrides,
});

describe('computeContentState', () => {
  it('builds a flat content state with joined artists', () => {
    expect(computeContentState(PLAYING, 4)).toEqual(state());
  });

  it('returns null when nothing is playing', () => {
    expect(computeContentState(null, null)).toBeNull();
  });
});

describe('hashContentState', () => {
  it('is stable for equal states and differs when rating changes', () => {
    expect(hashContentState(state())).toBe(hashContentState(state()));
    expect(hashContentState(state())).not.toBe(hashContentState(state({ rating: 5 })));
  });
});

describe('decidePollAction', () => {
  it('pushes when the state hash changes (new track)', () => {
    const d = decidePollAction(row(), state(), NOW);
    expect(d.push?.state).toEqual(state());
    expect(d.end).toBe(false);
    expect(d.stoppedSince).toBeNull();
  });

  it('does not push when nothing changed', () => {
    const d = decidePollAction(row({ contentStateHash: hashContentState(state()) }), state(), NOW);
    expect(d.push).toBeNull();
    expect(d.end).toBe(false);
  });

  it('pushes on rating change for the same track', () => {
    const d = decidePollAction(
      row({ contentStateHash: hashContentState(state({ rating: 3 })) }),
      state({ rating: 5 }),
      NOW,
    );
    expect(d.push?.state.rating).toBe(5);
  });

  it('marks stoppedSince on first empty poll, no push', () => {
    const d = decidePollAction(row(), null, NOW);
    expect(d.stoppedSince).toEqual(NOW);
    expect(d.push).toBeNull();
    expect(d.end).toBe(false);
  });

  it('keeps the original stoppedSince while still stopped', () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    const d = decidePollAction(row({ stoppedSince: earlier }), null, NOW);
    expect(d.stoppedSince).toEqual(earlier);
    expect(d.end).toBe(false);
  });

  it('ends after the stop window elapses', () => {
    const old = new Date(NOW.getTime() - STOPPED_END_MS - 1);
    const d = decidePollAction(row({ stoppedSince: old }), null, NOW);
    expect(d.end).toBe(true);
  });

  it('clears stoppedSince when playback resumes', () => {
    const d = decidePollAction(row({ stoppedSince: NOW }), state(), NOW);
    expect(d.stoppedSince).toBeNull();
  });

  it('paused playback starts the stop clock but still pushes the paused state', () => {
    const paused = state({ isPlaying: false });
    const d = decidePollAction(row(), paused, NOW);
    expect(d.stoppedSince).toEqual(NOW);
    expect(d.push?.state.isPlaying).toBe(false);
  });
});

describe('tickOnce', () => {
  function makeDeps(overrides: Partial<PollerDeps> = {}): PollerDeps & {
    pushes: unknown[][];
    updates: Record<string, unknown>[];
  } {
    const pushes: unknown[][] = [];
    const updates: Record<string, unknown>[] = [];
    const deps: PollerDeps = {
      listActiveActivities: async () => [row()],
      getAccessToken: async () => 'access',
      fetchPlaying: async () => ({ playing: PLAYING, rating: 4 }),
      push: async (...args: unknown[]) => {
        pushes.push(args);
        return { ok: true as const, status: 200 };
      },
      updateRow: async (id: string, fields: Record<string, unknown>) => {
        updates.push({ id, ...fields });
      },
      now: () => NOW,
      ...overrides,
    };
    return Object.assign(deps, { pushes, updates });
  }

  it('pushes an update and records the new hash', async () => {
    const deps = makeDeps();
    await tickOnce(deps);
    expect(deps.pushes).toHaveLength(1);
    const [, contentState, opts] = deps.pushes[0] as [string, ActivityContentState, { event: string }];
    expect(contentState).toEqual(state());
    expect(opts.event).toBe('update');
    expect(deps.updates[0]).toMatchObject({
      id: 'la-1',
      contentStateHash: hashContentState(state()),
      lastTrackUri: PLAYING.uri,
    });
  });

  it('sends an end push and marks the row ended after the stop window', async () => {
    const old = new Date(NOW.getTime() - STOPPED_END_MS - 1);
    const deps = makeDeps({
      listActiveActivities: async () => [row({ stoppedSince: old })],
      fetchPlaying: async () => ({ playing: null, rating: null }),
    });
    await tickOnce(deps);
    const [, , opts] = deps.pushes[0] as [string, unknown, { event: string }];
    expect(opts.event).toBe('end');
    expect(deps.updates[0]).toMatchObject({ id: 'la-1', endedAt: NOW });
  });

  it('keeps the row active when the end push fails transiently (retries next tick)', async () => {
    const old = new Date(NOW.getTime() - STOPPED_END_MS - 1);
    const deps = makeDeps({
      listActiveActivities: async () => [row({ stoppedSince: old })],
      fetchPlaying: async () => ({ playing: null, rating: null }),
      push: async () => ({ ok: false as const, status: 503, reason: 'ServiceUnavailable' }),
    });
    await tickOnce(deps);
    expect(deps.updates).toHaveLength(0); // no endedAt — row retried on next tick
  });

  it('closes the row on end when APNs is not configured (nothing to retry)', async () => {
    const old = new Date(NOW.getTime() - STOPPED_END_MS - 1);
    const deps = makeDeps({
      listActiveActivities: async () => [row({ stoppedSince: old })],
      fetchPlaying: async () => ({ playing: null, rating: null }),
      push: async () => ({ ok: false as const, reason: 'apns-not-configured' }),
    });
    await tickOnce(deps);
    expect(deps.updates[0]).toMatchObject({ id: 'la-1', endedAt: NOW });
  });

  it('marks the row ended when APNs reports the push token gone', async () => {
    const deps = makeDeps({
      push: async () => ({ ok: false as const, status: 410, reason: 'Unregistered' }),
    });
    await tickOnce(deps);
    expect(deps.updates[0]).toMatchObject({ id: 'la-1', endedAt: NOW });
  });

  it('one user failing does not stop the others', async () => {
    const deps = makeDeps({
      listActiveActivities: async () => [
        row({ id: 'la-bad', userId: 'user-bad' }),
        row({ id: 'la-good', userId: 'user-good' }),
      ],
      getAccessToken: async (userId: string) => {
        if (userId === 'user-bad') throw new Error('needs reauth');
        return 'access';
      },
    });
    await expect(tickOnce(deps)).resolves.not.toThrow();
    expect(deps.pushes).toHaveLength(1);
    expect(deps.updates.some((u) => u.id === 'la-good')).toBe(true);
  });

  it('does nothing when no activities are registered', async () => {
    const fetchPlaying = vi.fn();
    const deps = makeDeps({ listActiveActivities: async () => [], fetchPlaying });
    await tickOnce(deps);
    expect(fetchPlaying).not.toHaveBeenCalled();
    expect(deps.pushes).toHaveLength(0);
  });
});
