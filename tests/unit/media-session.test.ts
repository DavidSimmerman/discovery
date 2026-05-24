import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setMediaMetadata, setMediaActionHandlers } from '$lib/playback/media-session';

type MM = {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string }[];
};

class FakeMediaMetadata implements MM {
  title = '';
  artist = '';
  album = '';
  artwork: { src: string; sizes: string }[] = [];
  constructor(init: Partial<MM>) { Object.assign(this, init); }
}

beforeEach(() => {
  // Reset navigator.mediaSession to a fresh fake each test.
  // Use Object.defineProperty since navigator is read-only in Node environment.
  const handlers = new Map<string, ((d: unknown) => void) | null>();
  const fakeMediaSession = {
    metadata: null,
    setActionHandler: (action: string, h: ((d: unknown) => void) | null) => handlers.set(action, h),
    __handlers: handlers,
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaSession: fakeMediaSession },
    configurable: true,
  });
  (globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = FakeMediaMetadata;
});

describe('setMediaMetadata', () => {
  it('formats title as "★★★★ Track" when rated', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: 'XL', images: [] } },
      8,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.title).toBe('★★★★ Hello');
    expect(m.artist).toBe('Adele');
    expect(m.album).toBe('XL');
  });
  it('omits star prefix when rating is null/0', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: 'XL', images: [] } },
      null,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.title).toBe('Hello');
  });
  it('joins multiple artists with ", "', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'A' }, { name: 'B' }], album: { name: '', images: [] } },
      null,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.artist).toBe('A, B');
  });
  it('is a no-op when mediaSession is absent', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    expect(() =>
      setMediaMetadata(
        { uri: 'x', name: 'n', artists: [], album: { name: '', images: [] } },
        null,
      ),
    ).not.toThrow();
  });
});

describe('setMediaActionHandlers', () => {
  it('registers play, pause, previoustrack, nexttrack, seekto', () => {
    const store = { togglePlay: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
    setMediaActionHandlers(store);
    const h = (navigator.mediaSession as unknown as { __handlers: Map<string, unknown> }).__handlers;
    expect(h.has('play')).toBe(true);
    expect(h.has('pause')).toBe(true);
    expect(h.has('previoustrack')).toBe(true);
    expect(h.has('nexttrack')).toBe(true);
    expect(h.has('seekto')).toBe(true);
  });
  it('seekto handler forwards seekTime', () => {
    const store = { togglePlay: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
    setMediaActionHandlers(store);
    const h = (navigator.mediaSession as unknown as { __handlers: Map<string, (d: unknown) => void> }).__handlers;
    h.get('seekto')!({ seekTime: 42.5 });
    expect(store.seek).toHaveBeenCalledWith(42500); // ms
  });
});
