import { describe, it, expect, beforeEach, vi } from 'vitest';

const inserted = vi.hoisted(() => vi.fn());
const conflictTargets = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({
  db: {
    insert: () => ({
      values: (vals: unknown) => {
        inserted(vals);
        return {
          onConflictDoNothing: (opts: unknown) => {
            conflictTargets(opts);
            return Promise.resolve();
          },
        };
      },
    }),
  },
}));
vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  ingestSpotifyPlays,
  maybeIngestRecentPlays,
  _resetPlaysIngestCooldownForTests,
} from '../../src/lib/server/plays';
import type { RecentlyPlayedItem } from '../../src/lib/server/spotify';

function item(uri: string, playedAt: string): RecentlyPlayedItem {
  return { track: { uri } as RecentlyPlayedItem['track'], played_at: playedAt };
}

beforeEach(() => {
  inserted.mockReset();
  conflictTargets.mockReset();
  fetchMock.mockReset();
  _resetPlaysIngestCooldownForTests();
});

describe('ingestSpotifyPlays', () => {
  it('maps items to plays rows with source spotify and conflict-ignores dupes', async () => {
    await ingestSpotifyPlays('u1', [
      item('spotify:track:a', '2026-06-10T12:00:00Z'),
      item('spotify:track:b', '2026-06-10T12:03:30Z'),
    ]);
    const rows = inserted.mock.calls[0][0] as {
      userId: string;
      spotifyTrackUri: string;
      playedAt: Date;
      source: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: 'u1', spotifyTrackUri: 'spotify:track:a', source: 'spotify' });
    expect(rows[0].playedAt.toISOString()).toBe('2026-06-10T12:00:00.000Z');
    expect(conflictTargets).toHaveBeenCalled(); // structural dedupe, not blind insert
  });

  it('skips invalid timestamps and no-ops on empty input', async () => {
    await ingestSpotifyPlays('u1', [item('spotify:track:a', 'not-a-date')]);
    await ingestSpotifyPlays('u1', []);
    expect(inserted).not.toHaveBeenCalled();
  });
});

describe('maybeIngestRecentPlays', () => {
  it('fetches recently-played and respects the cooldown', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [item('spotify:track:a', '2026-06-10T12:00:00Z')] }), {
        status: 200,
      }),
    );
    await maybeIngestRecentPlays('u1');
    await maybeIngestRecentPlays('u1'); // within cooldown → no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch failures without throwing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }));
    await expect(maybeIngestRecentPlays('u1')).resolves.toBeUndefined();
    expect(inserted).not.toHaveBeenCalled();
  });
});
