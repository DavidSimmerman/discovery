import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isNativeWrapper,
  notifyPlayback,
  notifyStopped,
  notifyRatingChanged,
  installNativeHandlers,
  __resetNativeBridge,
} from '$lib/playback/nativeBridge';

const TRACK = {
  uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
  name: 'Song',
  artists: 'Artist A, Artist B',
  albumArtUrl: 'https://img/abc.jpg',
};

declare global {
  interface Window {
    webkit?: { messageHandlers?: { discovery?: { postMessage: (msg: unknown) => void } } };
    __discoveryNative?: {
      requestDeviceToken: (label?: string) => Promise<void>;
      reportSession: () => Promise<void>;
    };
  }
}

let postMessage: ReturnType<typeof vi.fn<(msg: unknown) => void>>;

beforeEach(() => {
  __resetNativeBridge();
  postMessage = vi.fn();
  window.webkit = { messageHandlers: { discovery: { postMessage } } };
});

afterEach(() => {
  delete window.webkit;
  delete window.__discoveryNative;
  vi.restoreAllMocks();
});

describe('isNativeWrapper', () => {
  it('true only when the discovery message handler exists', () => {
    expect(isNativeWrapper()).toBe(true);
    delete window.webkit;
    expect(isNativeWrapper()).toBe(false);
  });
});

describe('notifyPlayback', () => {
  it('posts trackChanged with the playback snapshot', () => {
    notifyPlayback(TRACK, 4, true);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'trackChanged',
      track: TRACK,
      rating: 4,
      isPlaying: true,
    });
  });

  it('dedupes identical consecutive snapshots', () => {
    notifyPlayback(TRACK, 4, true);
    notifyPlayback(TRACK, 4, true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('posts again when rating or play state changes', () => {
    notifyPlayback(TRACK, 4, true);
    notifyPlayback(TRACK, 5, true);
    notifyPlayback(TRACK, 5, false);
    expect(postMessage).toHaveBeenCalledTimes(3);
  });

  it('no-ops outside the wrapper', () => {
    delete window.webkit;
    expect(() => notifyPlayback(TRACK, null, true)).not.toThrow();
  });
});

describe('notifyStopped', () => {
  it('posts playbackStopped once until playback resumes', () => {
    notifyPlayback(TRACK, null, true);
    notifyStopped();
    notifyStopped();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'playbackStopped' });
  });
});

describe('notifyRatingChanged', () => {
  it('posts ratingChanged', () => {
    notifyRatingChanged(TRACK.uri, 5);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'ratingChanged',
      uri: TRACK.uri,
      rating: 5,
    });
  });
});

describe('installNativeHandlers → requestDeviceToken', () => {
  it('mints a token over the cookie session and hands it to native with its owner', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'minted-tok', userId: 'user-1' }), { status: 200 }),
    );
    installNativeHandlers();
    await window.__discoveryNative!.requestDeviceToken('iPhone');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ios/device-token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'deviceToken',
      token: 'minted-tok',
      userId: 'user-1',
    });
  });

  it('reports failure to native instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    installNativeHandlers();
    await window.__discoveryNative!.requestDeviceToken();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'deviceTokenError',
      status: 401,
    });
  });

  it('does not install outside the wrapper', () => {
    delete window.webkit;
    installNativeHandlers();
    expect(window.__discoveryNative).toBeUndefined();
  });
});

describe('installNativeHandlers → reportSession', () => {
  it('posts the current session user so native can detect account switches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ userId: 'user-1' }), { status: 200 }),
    );
    installNativeHandlers();
    await window.__discoveryNative!.reportSession();
    expect(postMessage).toHaveBeenCalledWith({ type: 'sessionUser', userId: 'user-1' });
  });

  it('posts null when logged out or the check fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    installNativeHandlers();
    await window.__discoveryNative!.reportSession();
    expect(postMessage).toHaveBeenCalledWith({ type: 'sessionUser', userId: null });
  });
});
