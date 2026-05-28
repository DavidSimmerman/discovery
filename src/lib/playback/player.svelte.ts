// Svelte 5 rune-based singleton that acts as a thin remote control for the
// user's active Spotify Connect device (phone, desktop app, browser tab).
// disccovery never plays audio itself — there's no Web Playback SDK. State
// comes from polling /api/spotify/currently-playing; control routes through
// /api/spotify/player/*.
//
// Position advancement between polls is faked locally on a 1s tick that snaps
// back to authoritative on the next poll. This keeps the scrubber smooth
// without burning poll budget.

import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import { buildQueueFromClick, shuffleFisherYates } from './queue';

const KEY = Symbol('playback');

// Poll cadences — visible tab gets 2.5s for snappy state, hidden tab drops
// to 15s to save battery and rate-limit budget. The Scrubber interpolates
// position smoothly between polls (RAF), so the store does NOT tick position
// itself — doing so churned `state` every second and fought the Scrubber's
// own interpolation, causing the bar to jump backward on each poll.
const POLL_ACTIVE_MS = 2500;
const POLL_HIDDEN_MS = 15_000;

export type PlaybackError =
  | null
  | 'no_device'    // 409 — no active Spotify device, user needs to open one
  | 'premium'      // 402 — Spotify Connect control requires Premium
  | 'auth'         // 401 — session expired
  | 'transient';   // 5xx / network / 429

export interface PlaybackTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
}

export interface PlaybackState {
  paused: boolean;
  position_ms: number;
  duration_ms: number;
  track: PlaybackTrack | null;
  context_uri: string | null;
  isrc: string | null;
}

const EMPTY_STATE: PlaybackState = {
  paused: true,
  position_ms: 0,
  duration_ms: 0,
  track: null,
  context_uri: null,
  isrc: null,
};

export interface PlaybackStore {
  readonly state: PlaybackState;
  readonly error: PlaybackError;
  readonly isReady: boolean;   // polling is running
  readonly isActive: boolean;  // a track is loaded on a device

  init(): void;
  destroy(): void;

  // Playback control. All route to /api/spotify/player/* and target whichever
  // device Spotify considers active (no device_id sent = Spotify routes itself).
  playTrack(uri: string, allUris: readonly string[]): Promise<void>;
  shuffle(uris: readonly string[]): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  // Force a state refresh — call after a remote action to catch up before
  // the next scheduled poll.
  refresh(): Promise<void>;

  // Rating bridge: the page that knows the current rating pushes it here so
  // currentRating can be read reactively elsewhere (e.g. the mini player).
  setCurrentRating(uri: string, ratingStars: number | null): void;
  readonly currentRating: number | null;
}

interface CurrentlyPlayingResponse {
  playing: null | {
    uri: string;
    name: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    durationMs: number;
    progressMs: number | null;
    isPlaying: boolean;
    isrc: string | null;
    contextUri: string | null;
  };
  rating?: number | null;
}

export function createPlaybackStore(): PlaybackStore {
  let state = $state<PlaybackState>({ ...EMPTY_STATE });
  let err = $state<PlaybackError>(null);
  let isReady = $state(false);

  const ratingByUri = new Map<string, number | null>();
  let ratingTrigger = $state(0);

  let pollHandle: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await fetch('/api/spotify/currently-playing');
      if (!res.ok) {
        if (res.status === 401) err = 'auth';
        return;
      }
      const data = (await res.json()) as CurrentlyPlayingResponse;
      if (data.playing == null) {
        state = { ...EMPTY_STATE };
        return;
      }
      const p = data.playing;
      state = {
        paused: !p.isPlaying,
        position_ms: p.progressMs ?? 0,
        duration_ms: p.durationMs,
        track: {
          uri: p.uri,
          name: p.name,
          artists: p.artists.map((name) => ({ name })),
          album: {
            name: p.album ?? '',
            images: p.albumArtUrl ? [{ url: p.albumArtUrl }] : [],
          },
        },
        context_uri: p.contextUri,
        isrc: p.isrc,
      };
      // Keep the rating bridge populated so currentRating reflects truth.
      if (typeof data.rating !== 'undefined') {
        ratingByUri.set(p.uri, data.rating);
        ratingTrigger++;
      }
      err = null;
    } catch {
      /* network blip — keep last known state */
    }
  }

  function schedulePoll(): void {
    if (pollHandle != null) clearTimeout(pollHandle);
    const hidden = browser && document.visibilityState === 'hidden';
    pollHandle = setTimeout(async () => {
      await refresh();
      schedulePoll();
    }, hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
    schedulePoll();
  }

  function init(): void {
    if (isReady) return;
    isReady = true;
    void refresh();
    schedulePoll();
    if (browser) document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function destroy(): void {
    if (pollHandle != null) clearTimeout(pollHandle);
    pollHandle = null;
    isReady = false;
    if (browser) document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Control ──────────────────────────────────────────────────────────

  async function handleControlResponse(res: Response): Promise<void> {
    if (res.ok) { err = null; return; }
    if (res.status === 409) err = 'no_device';
    else if (res.status === 402) err = 'premium';
    else if (res.status === 401) err = 'auth';
    else err = 'transient';
  }

  async function callPlay(payload: Record<string, unknown>): Promise<void> {
    const res = await fetch('/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await handleControlResponse(res);
    // Spotify needs ~200ms to reflect the change; chase it.
    setTimeout(() => void refresh(), 300);
  }

  async function callControl(
    action: 'pause' | 'resume' | 'next' | 'previous' | 'seek',
    position_ms?: number,
  ): Promise<void> {
    const res = await fetch('/api/spotify/player/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, position_ms }),
    });
    await handleControlResponse(res);
    setTimeout(() => void refresh(), 300);
  }

  async function playTrack(uri: string, allUris: readonly string[]): Promise<void> {
    const queue = buildQueueFromClick(uri, allUris);
    await callPlay({ uris: queue.slice(0, 100) });
  }

  async function shuffle(uris: readonly string[]): Promise<void> {
    const ordered = shuffleFisherYates(uris);
    await callPlay({ uris: ordered.slice(0, 100) });
  }

  async function togglePlay(): Promise<void> {
    if (!state.track) return;
    const willPause = !state.paused;
    state = { ...state, paused: willPause };
    await callControl(willPause ? 'pause' : 'resume');
  }

  async function next(): Promise<void> { await callControl('next'); }
  async function prev(): Promise<void> { await callControl('previous'); }

  async function seek(positionMs: number): Promise<void> {
    state = { ...state, position_ms: positionMs };
    await callControl('seek', positionMs);
  }

  function setCurrentRating(uri: string, ratingStars: number | null): void {
    ratingByUri.set(uri, ratingStars);
    ratingTrigger++;
  }

  return {
    get state() { return state; },
    get error() { return err; },
    get isReady() { return isReady; },
    get isActive() { return state.track != null; },
    init, destroy,
    playTrack, shuffle,
    togglePlay, next, prev, seek,
    refresh,
    setCurrentRating,
    get currentRating() {
      // Subscribe to ratingTrigger so consumers re-evaluate on rating writes.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      ratingTrigger;
      return state.track ? (ratingByUri.get(state.track.uri) ?? null) : null;
    },
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
