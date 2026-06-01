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

// Pure transition test for sampler auto-advance, extracted so it can be unit
// tested without the rune machinery. We top up the queue exactly when the track
// we previously queued has become the current track — i.e. Spotify advanced
// into our pick. Pulled out here to keep the intent obvious and verified.
export function shouldQueueNextPick(
  isSampling: boolean,
  queuedUri: string | null,
  currentUri: string | null,
): boolean {
  return isSampling && queuedUri != null && currentUri === queuedUri;
}

// Poll cadences — visible tab gets 2.5s for snappy state, hidden tab drops
// to 15s to save battery and rate-limit budget. Local tick fills the gap.
const POLL_ACTIVE_MS = 2500;
const POLL_HIDDEN_MS = 15_000;
const LOCAL_TICK_MS = 1000;

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

  // Start sampler-driven shuffle: play one /api/shuffle/next pick, then keep the
  // Spotify queue topped up so playback advances automatically (gapless). Stays
  // active until the user starts something else (playTrack/shuffle) or it can't
  // find a pick.
  startSampler(): Promise<void>;
  readonly isSampling: boolean;

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
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  // Sampler auto-advance state. samplerQueuedUri is the pick we've handed to
  // Spotify's queue and are waiting to see become the current track; when the
  // poll observes that transition we top the queue back up with the next pick.
  let isSampling = $state(false);
  let samplerQueuedUri: string | null = null;
  let samplerBusy = false; // guards against overlapping advances across polls
  let lastCurrentUri: string | null = null; // current track URI at the previous poll

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
        maybeAdvanceSampler(null);
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
      maybeAdvanceSampler(p.uri);
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

  function startLocalTick(): void {
    if (tickHandle != null) return;
    tickHandle = setInterval(() => {
      if (!state.paused && state.track && state.duration_ms > 0) {
        const next = Math.min(state.position_ms + LOCAL_TICK_MS, state.duration_ms);
        if (next !== state.position_ms) {
          state = { ...state, position_ms: next };
        }
      }
    }, LOCAL_TICK_MS);
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
    startLocalTick();
    if (browser) document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function destroy(): void {
    if (pollHandle != null) clearTimeout(pollHandle);
    if (tickHandle != null) clearInterval(tickHandle);
    pollHandle = null;
    tickHandle = null;
    isReady = false;
    if (browser) document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Control ──────────────────────────────────────────────────────────

  // Returns whether the action succeeded, so callers (e.g. the sampler) can gate
  // follow-up work on it rather than charging ahead after a no-device/auth error.
  function handleControlResponse(res: Response): boolean {
    if (res.ok) { err = null; return true; }
    if (res.status === 409) err = 'no_device';
    else if (res.status === 402) err = 'premium';
    else if (res.status === 401) err = 'auth';
    else err = 'transient';
    return false;
  }

  async function callPlay(payload: Record<string, unknown>): Promise<boolean> {
    const res = await fetch('/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ok = handleControlResponse(res);
    // Spotify needs ~200ms to reflect the change; chase it.
    setTimeout(() => void refresh(), 300);
    return ok;
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
    handleControlResponse(res);
    setTimeout(() => void refresh(), 300);
  }

  // ── Sampler auto-advance ─────────────────────────────────────────────

  async function fetchSamplerPick(): Promise<string | null> {
    try {
      const res = await fetch('/api/shuffle/next', { method: 'POST' });
      if (!res.ok) return null;
      const j = (await res.json()) as { uri: string | null };
      return j.uri ?? null;
    } catch {
      return null;
    }
  }

  async function callQueue(uri: string): Promise<boolean> {
    const res = await fetch('/api/spotify/player/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'queue', uri }),
    });
    return handleControlResponse(res);
  }

  // Bumped every time sampling starts or stops. Async advance/seed tasks capture
  // the generation when they begin and bail if it changes mid-flight — so a pick
  // fetched for an old session can't enqueue into a queue the user has since
  // replaced (e.g. by starting a normal shuffle while a fetch was in flight).
  let samplerGeneration = 0;

  // Pull the next pick and append it to Spotify's queue. Stops sampling if the
  // sampler is exhausted (no playable pick). Bails without side effects if the
  // session was superseded while the pick was being fetched.
  async function queueNextSamplerPick(gen: number): Promise<void> {
    const next = await fetchSamplerPick();
    if (gen !== samplerGeneration) return;
    if (!next) { stopSampling(); return; }
    const ok = await callQueue(next);
    // Only record it as the awaited URI once it's actually in the queue; if the
    // enqueue failed, leave samplerQueuedUri untouched so drain-recovery can step
    // in when the current track finishes rather than waiting on a phantom pick.
    if (gen !== samplerGeneration || !ok) return;
    samplerQueuedUri = next;
  }

  async function startSampler(): Promise<void> {
    const gen = ++samplerGeneration; // invalidate any in-flight advance/seed
    samplerQueuedUri = null;
    const first = await fetchSamplerPick();
    if (gen !== samplerGeneration) return;
    if (!first) { isSampling = false; return; }
    // Only consider ourselves sampling once playback actually started; a
    // no-device / premium / auth failure should not leave a stuck active state.
    const ok = await callPlay({ uris: [first] });
    if (gen !== samplerGeneration) return;
    if (!ok) { isSampling = false; return; }
    isSampling = true;
    await queueNextSamplerPick(gen);
  }

  // Re-seed playback when the sampler is active but the queue has drained to
  // nothing (fast double-skips, or a hidden tab polling slowly enough that a
  // queued track started and finished between polls). Plays a fresh pick.
  async function reseedSampler(gen: number): Promise<void> {
    const pick = await fetchSamplerPick();
    if (gen !== samplerGeneration) return;
    if (!pick) { stopSampling(); return; }
    const ok = await callPlay({ uris: [pick] });
    if (gen !== samplerGeneration) return;
    // A failed re-seed (no device / auth / transient) can't keep music going;
    // stop sampling so we don't sit active-but-inert. User re-clicks to resume.
    if (!ok) { stopSampling(); return; }
    await queueNextSamplerPick(gen);
  }

  // Called after every poll. Two jobs while sampling:
  //  1. When the track we queued has become current, Spotify advanced into our
  //     pick — top the queue back up. Updating samplerQueuedUri to the new pick
  //     means this won't re-fire until the *next* transition.
  //  2. If playback has drained to nothing, re-seed so music keeps going.
  function maybeAdvanceSampler(currentUri: string | null): void {
    // Always record what this poll saw, even when not sampling or busy — a stale
    // lastCurrentUri is what would let a queue-drain slip past drain-recovery.
    try {
      if (!isSampling || samplerBusy) return;
      if (shouldQueueNextPick(isSampling, samplerQueuedUri, currentUri)) {
        samplerBusy = true;
        const gen = samplerGeneration;
        void queueNextSamplerPick(gen).finally(() => { samplerBusy = false; });
      } else if (currentUri == null && lastCurrentUri != null) {
        // Was playing, now nothing — the queue ran dry. Re-seed.
        samplerBusy = true;
        const gen = samplerGeneration;
        void reseedSampler(gen).finally(() => { samplerBusy = false; });
      }
    } finally {
      lastCurrentUri = currentUri;
    }
  }

  function stopSampling(): void {
    samplerGeneration++; // invalidate in-flight advance/seed tasks
    isSampling = false;
    samplerQueuedUri = null;
  }

  async function playTrack(uri: string, allUris: readonly string[]): Promise<void> {
    stopSampling();
    const queue = buildQueueFromClick(uri, allUris);
    await callPlay({ uris: queue.slice(0, 100) });
  }

  async function shuffle(uris: readonly string[]): Promise<void> {
    stopSampling();
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
    startSampler,
    get isSampling() { return isSampling; },
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
