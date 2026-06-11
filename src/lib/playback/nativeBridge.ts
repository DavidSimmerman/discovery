// Web → native bridge for the iOS wrapper. The native shell registers a
// WKScriptMessageHandler named `discovery`; in normal browsers none of this
// exists and every function here is a silent no-op.
//
// Outbound messages (web → native):
//   { type: 'trackChanged', track, rating, isPlaying }  — start/update the Live Activity
//   { type: 'playbackStopped' }                          — confirmed nothing playing
//   { type: 'ratingChanged', uri, rating }               — instant star update
//   { type: 'deviceToken', token, userId }               — minted API token for the Keychain
//   { type: 'deviceTokenError', status }                 — mint failed (e.g. not logged in)
//   { type: 'sessionUser', userId|null }                 — who the cookie session belongs to
//
// Inbound (native → web): native evaluates
//   window.__discoveryNative.reportSession()             — on every page load
//   window.__discoveryNative.requestDeviceToken(label?)  — when it needs a (new) token
// The session report lets native detect logout/account switches and discard a
// Keychain token bound to a different user before it writes to the wrong account.

export interface NativeTrack {
  uri: string;
  name: string;
  /** Display string, already joined ("Artist A, Artist B"). */
  artists: string;
  albumArtUrl: string | null;
}

type WebkitWindow = Window & {
  webkit?: { messageHandlers?: { discovery?: { postMessage: (msg: unknown) => void } } };
  __discoveryNative?: {
    requestDeviceToken: (label?: string) => Promise<void>;
    reportSession: () => Promise<void>;
  };
};

function handler() {
  if (typeof window === 'undefined') return undefined;
  return (window as WebkitWindow).webkit?.messageHandlers?.discovery;
}

export function isNativeWrapper(): boolean {
  return handler() !== undefined;
}

function post(msg: Record<string, unknown>): void {
  try {
    handler()?.postMessage(msg);
  } catch {
    // A bridge failure must never break web playback.
  }
}

// Dedupe so the 2.5s poll doesn't spam native with identical snapshots.
let lastPlaybackKey: string | null = null;
let stoppedNotified = false;

export function __resetNativeBridge(): void {
  lastPlaybackKey = null;
  stoppedNotified = false;
}

export function notifyPlayback(track: NativeTrack, rating: number | null, isPlaying: boolean): void {
  if (!isNativeWrapper()) return;
  stoppedNotified = false;
  const key = `${track.uri}|${rating ?? ''}|${isPlaying}`;
  if (key === lastPlaybackKey) return;
  lastPlaybackKey = key;
  post({ type: 'trackChanged', track, rating, isPlaying });
}

export function notifyStopped(): void {
  if (!isNativeWrapper() || stoppedNotified) return;
  stoppedNotified = true;
  lastPlaybackKey = null;
  post({ type: 'playbackStopped' });
}

export function notifyRatingChanged(uri: string, rating: number | null): void {
  if (!isNativeWrapper()) return;
  post({ type: 'ratingChanged', uri, rating });
}

/** Expose the native→web entry points. Call once at app init; wrapper-only. */
export function installNativeHandlers(): void {
  if (!isNativeWrapper()) return;
  (window as WebkitWindow).__discoveryNative = {
    async requestDeviceToken(label?: string) {
      try {
        const res = await fetch('/api/ios/device-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: label ?? 'iOS wrapper' }),
        });
        if (!res.ok) {
          post({ type: 'deviceTokenError', status: res.status });
          return;
        }
        const { token, userId } = await res.json();
        post({ type: 'deviceToken', token, userId });
      } catch {
        post({ type: 'deviceTokenError', status: 0 });
      }
    },

    async reportSession() {
      try {
        const res = await fetch('/api/me');
        const userId = res.ok ? ((await res.json()).userId ?? null) : null;
        post({ type: 'sessionUser', userId });
      } catch {
        post({ type: 'sessionUser', userId: null });
      }
    },
  };
}
