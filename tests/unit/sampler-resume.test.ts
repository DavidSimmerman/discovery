import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The store reads `browser` to decide whether to read the resume marker /
// localStorage; force it on so the resume path runs under jsdom.
vi.mock('$app/environment', () => ({ browser: true }));

import { createPlaybackStore } from '$lib/playback/player.svelte';

const CUR = 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa';
const U1 = 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb';
const U2 = 'spotify:track:cccccccccccccccccccccc';

// Spotify is mid-context (on an upcoming track from before the close), so the
// timeline owns it. Reopen should re-attach, not rebuild the queue.
const timeline = { current: U1, upcoming: [U2], history: [CUR] };

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

let playCalls = 0;
let syncCalls = 0;

function stubLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
}

beforeEach(() => {
  playCalls = 0;
  syncCalls = 0;
  stubLocalStorage({ 'discovery.sampler': '1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts?: { method?: string }) => {
      const u = String(url);
      const method = opts?.method ?? 'GET';
      if (u.includes('/api/spotify/currently-playing')) {
        return jsonRes({
          playing: {
            uri: U1,
            name: 'Track',
            artists: ['Artist'],
            album: 'Album',
            albumArtUrl: null,
            durationMs: 200_000,
            progressMs: 42_000,
            isPlaying: true,
            isrc: null,
            contextUri: null,
          },
          rating: null,
        });
      }
      if (u.includes('/api/shuffle/timeline')) {
        if (method === 'POST') syncCalls++;
        return jsonRes({ timeline });
      }
      if (u.includes('/api/spotify/queue')) {
        // Spotify's real remaining queue (used to seed the resume runway).
        return jsonRes({ currently_playing: { uri: U1 }, queue: [{ uri: U2 }] });
      }
      if (u.includes('/api/spotify/player/play')) {
        playCalls++;
        return jsonRes({});
      }
      if (u.includes('/api/spotify/player/control')) return jsonRes({});
      return jsonRes({}, false, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('car-mode resume on PWA reopen', () => {
  it('re-attaches without re-pushing the Spotify queue', async () => {
    const store = createPlaybackStore();
    store.init();

    await vi.waitFor(() => expect(store.isSampling).toBe(true));

    // The whole point: reopening must NOT rebuild/replace the live queue.
    expect(playCalls).toBe(0);
    // It should still sync the server cursor to whatever Spotify is on.
    expect(syncCalls).toBeGreaterThan(0);

    store.destroy();
  });
});
