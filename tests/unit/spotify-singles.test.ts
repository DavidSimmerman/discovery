// Feb-2026 Spotify API migration: the batch endpoints (GET /tracks?ids=,
// GET /artists?ids=) were removed. fetchTracks/fetchArtists now fan out
// single-resource GETs with bounded concurrency, honoring 429 Retry-After,
// and skipping 404s (parity with the old null-dropping behavior).

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$env/static/private', () => ({
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
}));
vi.mock('$env/static/public', () => ({ PUBLIC_BASE_URL: 'http://localhost' }));

import { fetchTracks, fetchArtists } from '$lib/server/spotify';

type Resp = { status: number; json?: unknown; retryAfter?: string };
const calls: string[] = [];

// Route fetches by URL; an array value yields each response once (for retry tests).
function mockFetch(routes: Record<string, Resp | Resp[]>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const path = new URL(url).pathname;
      let r = routes[path];
      if (Array.isArray(r)) r = r.length > 1 ? (routes[path] = r.slice(1), r[0]) : r[0];
      if (!r) throw new Error(`unrouted ${path}`);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null) },
        json: async () => r.json ?? {},
      } as unknown as Response;
    }),
  );
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const track = (id: string) => ({ uri: `spotify:track:${id}`, name: id });

describe('fetchTracks — single-resource fan-out', () => {
  it('fetches each id via /v1/tracks/{id} and preserves input order', async () => {
    mockFetch({
      '/v1/tracks/a': { status: 200, json: track('a') },
      '/v1/tracks/b': { status: 200, json: track('b') },
      '/v1/tracks/c': { status: 200, json: track('c') },
    });
    const out = await fetchTracks('tok', ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
    expect(out.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(calls.filter((u) => u.includes('/v1/tracks/'))).toHaveLength(3);
  });

  it('skips 404s instead of failing the whole batch', async () => {
    mockFetch({
      '/v1/tracks/a': { status: 200, json: track('a') },
      '/v1/tracks/gone': { status: 404 },
    });
    const out = await fetchTracks('tok', ['spotify:track:a', 'spotify:track:gone']);
    expect(out.map((t) => t.name)).toEqual(['a']);
  });

  it('retries a 429 after Retry-After', async () => {
    vi.useFakeTimers();
    mockFetch({
      '/v1/tracks/a': [
        { status: 429, retryAfter: '1' },
        { status: 200, json: track('a') },
      ],
    });
    const p = fetchTracks('tok', ['spotify:track:a']);
    await vi.advanceTimersByTimeAsync(1100);
    const out = await p;
    expect(out.map((t) => t.name)).toEqual(['a']);
  });

  it('throws on a non-404 hard error', async () => {
    mockFetch({ '/v1/tracks/a': { status: 500 } });
    await expect(fetchTracks('tok', ['spotify:track:a'])).rejects.toThrow(/500/);
  });
});

describe('fetchArtists — single-resource fan-out', () => {
  it('fetches each artist via /v1/artists/{id}', async () => {
    mockFetch({
      '/v1/artists/x': { status: 200, json: { id: 'x', name: 'X', genres: ['rap'] } },
      '/v1/artists/y': { status: 200, json: { id: 'y', name: 'Y' } },
    });
    const out = await fetchArtists('tok', ['x', 'y']);
    expect(out).toEqual([
      { id: 'x', name: 'X', genres: ['rap'] },
      { id: 'y', name: 'Y', genres: [] },
    ]);
  });

  it('skips 404s', async () => {
    mockFetch({
      '/v1/artists/x': { status: 200, json: { id: 'x', name: 'X', genres: [] } },
      '/v1/artists/gone': { status: 404 },
    });
    const out = await fetchArtists('tok', ['x', 'gone']);
    expect(out.map((a) => a.id)).toEqual(['x']);
  });
});
