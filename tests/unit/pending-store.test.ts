import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { createPlaybackStore } from '$lib/playback/player.svelte';

const A = 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa';
const B = 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb';
const C = 'spotify:track:cccccccccccccccccccccc';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
  return map;
}

// Route-by-route programmable fetch stub.
type Routes = {
  play?: () => Response;
  pendingPost?: () => Response;
  pendingGet?: () => Response;
  pendingDelete?: () => Response;
  timeline?: () => Response;
  timelinePost?: (body: unknown) => Response;
};
const calls: { url: string; method: string; body?: unknown }[] = [];

function stubFetch(routes: Routes) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = opts?.method ?? 'GET';
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url: u, method, body });
      if (u.includes('/api/spotify/currently-playing')) return jsonRes({ playing: null });
      if (u.includes('/api/spotify/player/play')) {
        return routes.play?.() ?? jsonRes({ error: 'no_active_device' }, 409);
      }
      if (u.includes('/api/spotify/player/pending')) {
        if (method === 'POST') return routes.pendingPost?.() ?? jsonRes({ status: 'pending' }, 202);
        if (method === 'DELETE') return routes.pendingDelete?.() ?? new Response(null, { status: 204 });
        return routes.pendingGet?.() ?? jsonRes({ status: 'pending' });
      }
      if (u.includes('/api/shuffle/timeline')) {
        if (method === 'POST') return routes.timelinePost?.(body) ?? jsonRes({ timeline: null });
        return routes.timeline?.() ?? jsonRes({ timeline: null });
      }
      if (u.includes('/api/spotify/queue')) return jsonRes({ queue: [] });
      return jsonRes({});
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  stubLocalStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cold-start pending play', () => {
  it('arms a pending play when playTrack hits no_device', async () => {
    stubFetch({});
    const store = createPlaybackStore();
    await store.playTrack(A, [A, B]);

    const post = calls.find((c) => c.url.includes('/pending') && c.method === 'POST');
    expect(post).toBeTruthy();
    expect((post!.body as { uris: string[] }).uris[0]).toBe(A);
    expect(store.pendingPlay).not.toBeNull();
    expect(store.pendingPlay!.forSampler).toBe(false);
    expect(store.error).toBeNull(); // pending UI replaces the error
  });

  it('clears pending state once the server reports started', async () => {
    let status = 'pending';
    stubFetch({ pendingGet: () => jsonRes({ status }) });
    const store = createPlaybackStore();
    await store.playTrack(A, [A]);
    expect(store.pendingPlay).not.toBeNull();

    status = 'started';
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.pendingPlay).toBeNull();
  });

  it('cancelPendingPlay clears state and DELETEs the job', async () => {
    stubFetch({});
    const store = createPlaybackStore();
    await store.playTrack(A, [A]);
    await store.cancelPendingPlay();

    expect(store.pendingPlay).toBeNull();
    expect(calls.some((c) => c.url.includes('/pending') && c.method === 'DELETE')).toBe(true);
    // No further status polls after cancel.
    const pollsBefore = calls.filter((c) => c.url.includes('/pending') && c.method === 'GET').length;
    await vi.advanceTimersByTimeAsync(10_000);
    const pollsAfter = calls.filter((c) => c.url.includes('/pending') && c.method === 'GET').length;
    expect(pollsAfter).toBe(pollsBefore);
  });

  it('sampler start with no device arms pending and adopts the session on started', async () => {
    const timeline = { history: [], current: A, upcoming: [B, C] };
    let status = 'pending';
    stubFetch({
      timeline: () => jsonRes({ timeline }),
      timelinePost: () => jsonRes({ timeline }),
      pendingGet: () => jsonRes({ status }),
    });
    const store = createPlaybackStore();
    await store.startSampler({ reset: true });

    // Push failed (409) → pending armed with [current, ...upcoming], not sampling yet.
    expect(store.isSampling).toBe(false);
    expect(store.pendingPlay).toMatchObject({ forSampler: true, uris: [A, B, C] });
    expect(store.timeline?.current).toBe(A); // timeline kept for adoption

    status = 'started';
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.pendingPlay).toBeNull();
    expect(store.isSampling).toBe(true); // session adopted
  });

  it('expired pending just clears — timeline left for the resume affordance', async () => {
    const timeline = { history: [], current: A, upcoming: [B] };
    let status = 'pending';
    stubFetch({
      timeline: () => jsonRes({ timeline }),
      timelinePost: () => jsonRes({ timeline }),
      pendingGet: () => jsonRes({ status }),
    });
    const store = createPlaybackStore();
    await store.startSampler({ reset: true });
    expect(store.pendingPlay).not.toBeNull();

    status = 'expired';
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.pendingPlay).toBeNull();
    expect(store.isSampling).toBe(false);
  });
});

describe('getResumeInfo', () => {
  it('offers the server timeline when not sampling', async () => {
    stubFetch({ timeline: () => jsonRes({ timeline: { history: [A], current: B, upcoming: [C] } }) });
    const store = createPlaybackStore();
    const info = await store.getResumeInfo();
    expect(info).toEqual({ currentUri: B, remaining: 2 });
  });

  it('returns null when the timeline is empty or drained', async () => {
    stubFetch({ timeline: () => jsonRes({ timeline: { history: [A], current: B, upcoming: [] } }) });
    const store = createPlaybackStore();
    expect(await store.getResumeInfo()).toBeNull();
  });
});
