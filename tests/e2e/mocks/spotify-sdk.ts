import type { Page } from '@playwright/test';

// Injects a fake window.Spotify before any page script runs. Captures the
// listeners the PlaybackStore attaches, lets the test fire synthetic events via
// page.evaluate(window.__mockSpotify.emit, ...).

export async function mockSpotifySdk(page: Page, opts?: { deviceId?: string }): Promise<void> {
  const deviceId = opts?.deviceId ?? 'mock-device-1';
  await page.addInitScript(({ deviceId }) => {
    type Listener = (d: unknown) => void;
    const listeners = new Map<string, Listener[]>();
    function add(ev: string, cb: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(cb);
      return true;
    }
    function emit(ev: string, payload: unknown) {
      (listeners.get(ev) ?? []).forEach((cb) => cb(payload));
    }
    class FakePlayer {
      constructor(_init: { name: string; getOAuthToken: (cb: (t: string) => void) => void }) {
        // Drain the OAuth callback once so getOAuthToken errors surface in tests.
        try { _init.getOAuthToken(() => {}); } catch { /* ignore */ }
      }
      addListener(ev: string, cb: Listener) { return add(ev, cb); }
      async connect() {
        // Synthesize a `ready` event on the next microtask so init() observes it.
        queueMicrotask(() => emit('ready', { device_id: deviceId }));
        return true;
      }
      disconnect() {}
      async getCurrentState() { return null; }
      async togglePlay() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('togglePlay'); }
      async previousTrack() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('previousTrack'); }
      async nextTrack() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('nextTrack'); }
      async seek(_ms: number) { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push(`seek:${_ms}`); }
      async activateElement() {}
    }
    (window as unknown as { Spotify: unknown }).Spotify = { Player: FakePlayer };
    (window as unknown as {
      __mockSpotify: { emit: typeof emit; calls: string[] };
    }).__mockSpotify = { emit, calls: [] };
  }, { deviceId });
}

export async function emitSdkState(
  page: Page,
  partial: {
    paused?: boolean;
    position?: number;
    duration?: number;
    track: { uri: string; name: string; artists: { name: string }[]; album: { name: string; images: unknown[] } };
    contextUri?: string | null;
  },
): Promise<void> {
  await page.evaluate((p) => {
    const ms = (window as unknown as {
      __mockSpotify: { emit: (e: string, d: unknown) => void };
    }).__mockSpotify;
    ms.emit('player_state_changed', {
      paused: p.paused ?? false,
      position: p.position ?? 0,
      duration: p.duration ?? p.track.album ? 200_000 : 0,
      context: { uri: p.contextUri ?? null },
      track_window: { current_track: p.track, previous_tracks: [], next_tracks: [] },
    });
  }, partial);
}
