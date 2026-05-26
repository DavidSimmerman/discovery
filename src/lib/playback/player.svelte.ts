// Client-only Svelte 5 rune-based singleton owning the Spotify Web Playback SDK
// player instance. Components consume via getPlaybackStore() (set in root
// layout). Mutations happen only inside methods on the store; reactivity is via
// $state proxies on `state`, `mode`, `error`, `isReady`, `deviceId`.

import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import { loadSpotifySdk } from './sdk-loader';
import { setMediaActionHandlers, setMediaMetadata, type TrackForMeta } from './media-session';
import { buildQueueFromClick, shuffleFisherYates } from './queue';
import type {} from './spotify-sdk';

const KEY = Symbol('playback');

export type PlaybackError =
  | null
  | 'unsupported'
  | 'auth'
  | 'premium'
  | 'transient'
  | 'disconnected';

export type PlaybackMode = 'idle' | 'shuffle' | 'takeover';

export interface PlaybackState {
  paused: boolean;
  position_ms: number;
  duration_ms: number;
  track: TrackForMeta | null;
  context_uri: string | null;
}

const EMPTY_STATE: PlaybackState = {
  paused: true,
  position_ms: 0,
  duration_ms: 0,
  track: null,
  context_uri: null,
};

export interface PlaybackStore {
  // Reactive (read-only externally)
  readonly state: PlaybackState;
  readonly mode: PlaybackMode;
  readonly error: PlaybackError;
  readonly isReady: boolean;
  readonly deviceId: string | null;
  readonly isActive: boolean;

  // Lifecycle
  init(): Promise<void>;
  destroy(): void;

  // Playback control
  playTrack(uri: string, allUris: readonly string[]): Promise<void>;
  shuffle(uris: readonly string[]): Promise<void>;
  takeover(contextUri: string, trackUri: string, positionMs: number): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;

  // Volume 0..1; persisted to localStorage so it survives reloads. Set even
  // before init so the value passed to `new Player({ volume })` reflects it.
  readonly volume: number;

  // Rating bridge (set by the page that knows the current rating)
  setCurrentRating(uri: string, ratingHalfSteps: number | null): void;

  // Current track's rating (reactive via ratingTrigger)
  readonly currentRating: number | null;
}

export function createPlaybackStore(): PlaybackStore {
  let state = $state<PlaybackState>({ ...EMPTY_STATE });
  let mode = $state<PlaybackMode>('idle');
  let err = $state<PlaybackError>(null);
  let isReady = $state(false);
  let deviceId = $state<string | null>(null);

  // Volume 0..1. Read once from localStorage on creation; clamped on every set.
  const VOLUME_KEY = 'disccovery:volume';
  function readStoredVolume(): number {
    if (!browser) return 1;
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw === null) return 1;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    } catch {
      return 1;
    }
  }
  let volume = $state(readStoredVolume());

  // Player handle, set on init.
  let player: Spotify.Player | null = null;
  let initPromise: Promise<void> | null = null;

  // In-memory access-token cache for the SDK callback.
  let cachedToken: { value: string; expires_at: number } | null = null;
  let tokenInflight: Promise<string> | null = null;

  // Last-known per-URI rating, used to render the lock-screen title.
  // ratingTrigger increments on every write so components that read currentRating re-run.
  const ratingByUri = new Map<string, number | null>();
  let ratingTrigger = $state(0);

  // Queue maintenance state.
  let lastShuffleFilterUris: string[] | null = null;
  let played: Set<string> = new Set();

  // Last play payload for no_active_device retry.
  let lastPlayPayload: Record<string, unknown> | null = null;

  async function fetchAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expires_at - now > 30_000) return cachedToken.value;
    if (tokenInflight) return tokenInflight;
    tokenInflight = (async () => {
      const res = await fetch('/api/spotify/access-token');
      if (!res.ok) throw new Error(`access-token ${res.status}`);
      const j = (await res.json()) as { access_token: string; expires_at: number };
      cachedToken = { value: j.access_token, expires_at: j.expires_at };
      return j.access_token;
    })().finally(() => { tokenInflight = null; });
    return tokenInflight;
  }

  async function callTransfer(): Promise<void> {
    if (!deviceId) return;
    await fetch('/api/spotify/player/transfer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, play: false }),
    });
  }

  async function callPlay(payload: Record<string, unknown>): Promise<Response> {
    lastPlayPayload = payload;
    return fetch('/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, device_id: deviceId }),
    });
  }

  function handleStateChanged(s: Spotify.PlaybackState | null): void {
    if (!s) return;
    const t = s.track_window.current_track;
    state = {
      paused: s.paused,
      position_ms: s.position,
      duration_ms: s.duration,
      track: t
        ? {
            uri: t.uri,
            name: t.name,
            artists: t.artists,
            album: { name: t.album.name, images: t.album.images },
          }
        : null,
      context_uri: s.context?.uri ?? null,
    };
    if (t) {
      played.add(t.uri);
      setMediaMetadata(state.track!, ratingByUri.get(t.uri) ?? null);
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const Sdk = await loadSpotifySdk();
        player = new Sdk.Player({
          name: 'disccovery',
          getOAuthToken: (cb) => {
            fetchAccessToken().then(cb).catch(() => {
              err = 'auth';
              cb('');
            });
          },
          volume,
        });

        player.addListener('initialization_error', () => { err = 'unsupported'; });
        player.addListener('authentication_error', () => { err = 'auth'; });
        player.addListener('account_error', () => { err = 'premium'; });
        player.addListener('playback_error', () => {
          err = 'transient';
          if (mode === 'shuffle') {
            void player?.nextTrack().catch(() => {});
          }
        });
        player.addListener('ready', ({ device_id }) => {
          deviceId = device_id;
          isReady = true;
          void callTransfer();
        });
        player.addListener('not_ready', () => { isReady = false; });
        player.addListener('player_state_changed', handleStateChanged);

        // iOS Safari autoplay gate must be inside the user gesture that called init().
        try { await player.activateElement(); } catch { /* not iOS, no-op */ }

        const ok = await player.connect();
        if (!ok) err = 'unsupported';

        setMediaActionHandlers({
          togglePlay: () => void player?.togglePlay(),
          next: () => void player?.nextTrack(),
          prev: () => void player?.previousTrack(),
          seek: (ms) => void player?.seek(ms),
        });
      } catch {
        err = err ?? 'unsupported';
        initPromise = null;
      }
    })();
    return initPromise;
  }

  function destroy(): void {
    player?.disconnect();
    player = null;
    initPromise = null;
    isReady = false;
    deviceId = null;
  }

  async function playTrack(uri: string, allUris: readonly string[]): Promise<void> {
    await init();
    if (!deviceId) return;
    const queue = buildQueueFromClick(uri, allUris);
    lastShuffleFilterUris = [...allUris];
    played = new Set();
    mode = 'shuffle';
    const res = await callPlay({ uris: queue.slice(0, 100) });
    handlePlayErrorMaybe(res);
  }

  async function shuffle(uris: readonly string[]): Promise<void> {
    await init();
    if (!deviceId) return;
    const ordered = shuffleFisherYates(uris);
    lastShuffleFilterUris = [...uris];
    played = new Set();
    mode = 'shuffle';
    const res = await callPlay({ uris: ordered.slice(0, 100) });
    handlePlayErrorMaybe(res);
  }

  async function takeover(contextUri: string, trackUri: string, positionMs: number): Promise<void> {
    await init();
    if (!deviceId) return;
    mode = 'takeover';
    lastShuffleFilterUris = null;
    const res = await callPlay({
      context_uri: contextUri,
      offset: { uri: trackUri },
      position_ms: positionMs,
    });
    handlePlayErrorMaybe(res);
  }

  async function handlePlayErrorMaybe(res: Response, retried = false): Promise<void> {
    if (res.ok) { err = null; return; }
    try {
      const body = await res.json();
      if (body?.error === 'premium_required') err = 'premium';
      else if (body?.error === 'no_active_device') {
        if (!retried && lastPlayPayload) {
          // Retry once after transferring playback to this device (§4.3).
          await callTransfer();
          const retry = await callPlay(lastPlayPayload);
          await handlePlayErrorMaybe(retry, true);
        } else {
          err = 'transient';
        }
      } else if (body?.error === 'rate_limited') err = 'transient';
      else err = 'transient';
    } catch {
      err = 'transient';
    }
  }

  async function togglePlay(): Promise<void> { await player?.togglePlay(); }
  async function next(): Promise<void> { await player?.nextTrack(); }
  async function prev(): Promise<void> { await player?.previousTrack(); }
  async function seek(positionMs: number): Promise<void> { await player?.seek(positionMs); }
  async function setVolume(next: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, next));
    volume = clamped;
    if (browser) {
      try { localStorage.setItem(VOLUME_KEY, String(clamped)); } catch { /* quota / private mode */ }
    }
    // The SDK may not be initialised yet (user adjusts before pressing play).
    // The stored value will be picked up by `new Player({ volume })` on init.
    await player?.setVolume(clamped).catch(() => {});
  }

  function setCurrentRating(uri: string, ratingHalfSteps: number | null): void {
    ratingByUri.set(uri, ratingHalfSteps);
    ratingTrigger++;
    if (state.track?.uri === uri) setMediaMetadata(state.track, ratingHalfSteps);
  }

  return {
    get state() { return state; },
    get mode() { return mode; },
    get error() { return err; },
    get isReady() { return isReady; },
    get deviceId() { return deviceId; },
    get isActive() { return isReady && state.track != null; },
    get currentRating() {
      // Reading ratingTrigger subscribes to it so Svelte re-evaluates on rating changes.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      ratingTrigger;
      return state.track ? (ratingByUri.get(state.track.uri) ?? null) : null;
    },
    init, destroy,
    playTrack, shuffle, takeover,
    togglePlay, next, prev, seek,
    setVolume,
    get volume() { return volume; },
    setCurrentRating,
  };
}

export function setPlaybackStore(store: PlaybackStore): void {
  setContext(KEY, store);
}
export function getPlaybackStore(): PlaybackStore {
  const s = getContext<PlaybackStore | undefined>(KEY);
  if (!s) throw new Error('PlaybackStore not provided; mount setPlaybackStore() in the root layout');
  return s;
}
