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
import type { Timeline } from '$lib/server/shuffle/timeline';

const KEY = Symbol('playback');

// ── Debug instrumentation ──────────────────────────────────────────────
// Native NEXT/PREV bugs live at the boundary between our virtual timeline and
// Spotify's opaque user-queue. This ring buffer + console logger makes every
// poll decision and every Spotify call visible so the behavior can be diagnosed
// from real evidence instead of guesswork.
//
// Read it three ways in the browser console while sampling:
//   • live: filter the console for "[shuffle]"
//   • window.__shuffleLog            → raw entry array
//   • dumpShuffleLog()               → copy-pasteable text dump
//
// Decision logging is always on while sampling (it's local, free). The heavier
// Spotify-queue diagnostic fetch (logs Spotify's REAL queue next to ours) is
// gated behind localStorage 'discovery.shuffleDebug' = '1' to protect the API
// rate budget — flip it on when actively diagnosing.
type DbgEntry = { t: string; tag: string; data?: Record<string, unknown> };
const DBG_RING_CAP = 400;
const dbgRing: DbgEntry[] = [];

// Shorten a Spotify URI to its last 6 id chars for legible logs.
function shortUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const id = uri.split(':').pop() ?? uri;
  return id.slice(-6);
}

function dbg(tag: string, data?: Record<string, unknown>): void {
  if (!browser) return;
  const d = new Date();
  const t =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  dbgRing.push({ t, tag, data });
  if (dbgRing.length > DBG_RING_CAP) dbgRing.shift();
  // eslint-disable-next-line no-console
  console.log(`[shuffle ${t}] ${tag}`, data ?? '');
}

function shuffleDebugEnabled(): boolean {
  if (!browser) return false;
  try {
    return localStorage.getItem('discovery.shuffleDebug') === '1';
  } catch {
    return false;
  }
}

if (browser) {
  const w = window as unknown as Record<string, unknown>;
  w.__shuffleLog = dbgRing;
  w.dumpShuffleLog = () =>
    dbgRing
      .map((e) => `[${e.t}] ${e.tag}${e.data ? ' ' + JSON.stringify(e.data) : ''}`)
      .join('\n');
}

// Car mode: disccovery hands Spotify a real multi-track context (PUT play with
// [current, ...upcoming]) and lets Spotify's native NEXT/PREV walk it. We re-push
// when Spotify nears the end of the list we handed it. No POST-queue poking, no
// position-drop heuristics — Spotify owns transport, we observe and follow.

// Re-push when Spotify is within this many tracks of the end of the pushed
// context, so it never autoplays past our list. 8 tracks at the 2.5s poll
// cadence is plenty of buffer.
const REPUSH_LOW_WATER = 8;

// Spotify caps a play `uris` array at 100.
const MAX_CONTEXT = 100;

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

  // Start car-mode shuffle: hydrate the virtual timeline from
  // /api/shuffle/timeline and push [current, ...upcoming] as a real Spotify
  // context so native NEXT/PREV walk our shuffle. Stays active until the user
  // starts something else (playTrack/shuffle). opts.reset wipes the timeline
  // first — the Shuffle button passes this so a press is always a clean slate.
  startSampler(opts?: { reset?: boolean }): Promise<void>;
  readonly isSampling: boolean;
  // Client mirror of the server-side timeline. Null when not sampling.
  readonly timeline: Timeline | null;

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

  // Car-mode state. `timeline` mirrors the server-side cursor
  // (history/current/upcoming); it's re-read after each action so the now-
  // playing UI reflects authoritative order. `lastPushedUris` tracks exactly
  // what we last handed Spotify (see top-of-file note) so we can tell a native
  // advance within our list from a user playing something else, and know when
  // to re-push.
  let isSampling = $state(false);
  let timeline = $state<Timeline | null>(null);
  let lastPushedUris: string[] = [];
  let samplerBusy = false; // guards against overlapping follow/re-push across polls
  let lastCurrentUri: string | null = null; // current track URI at the previous poll
  // After a context push, Spotify takes a poll or two to transition into our
  // `current`. During this window we tolerate a "divergence" (Spotify still on
  // the pre-push track) and a transient `null` instead of stopping/reseeding.
  let contextSettleUntil = 0; // unix ms

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
        // Pass zeroes for position/duration — predicates short-circuit on the
        // null currentUri before the time math matters.
        maybeAdvanceSampler(null, 0, 0);
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
      maybeAdvanceSampler(p.uri, p.progressMs ?? 0, p.durationMs);
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
    // Refresh first so tryResumeSampler can compare Spotify's current URI to
    // the timeline. Fire-and-forget so init stays sync.
    void refresh().then(() => tryResumeSampler());
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
    const uris = Array.isArray(payload.uris) ? (payload.uris as string[]) : null;
    dbg('callPlay', { uris: uris ? uris.map(shortUri) : payload, pos: payload.position_ms ?? 0 });
    const res = await fetch('/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ok = handleControlResponse(res);
    dbg('callPlay:done', { ok });
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

  // ── Car-mode driver ──────────────────────────────────────────────────

  type TimelineActionBody =
    | { action: 'advance' | 'forward' | 'back' | 'reset' }
    | { action: 'sync'; uri: string };

  async function fetchTimeline(): Promise<Timeline | null> {
    try {
      const res = await fetch('/api/shuffle/timeline');
      if (!res.ok) return null;
      const j = (await res.json()) as { timeline: Timeline };
      return j.timeline ?? null;
    } catch { return null; }
  }

  async function postTimelineAction(body: TimelineActionBody): Promise<Timeline | null> {
    try {
      const res = await fetch('/api/shuffle/timeline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { dbg('tl-action:fail', { action: body.action, status: res.status }); return null; }
      const j = (await res.json()) as { timeline: Timeline };
      const tl = j.timeline ?? null;
      dbg('tl-action', {
        action: body.action,
        cur: shortUri(tl?.current),
        up: tl?.upcoming.map(shortUri),
        histLen: tl?.history.length,
      });
      return tl;
    } catch { dbg('tl-action:throw', { action: body.action }); return null; }
  }

  // Diagnostic: fetch Spotify's REAL queue and log it next to our virtual
  // timeline. Gated behind the shuffleDebug flag because it costs an API call.
  // This is the single most useful signal for native-NEXT bugs — it shows when
  // Spotify's user-queue has accumulated stale/out-of-order tracks we can't see.
  async function logSpotifyQueue(): Promise<void> {
    if (!shuffleDebugEnabled()) return;
    try {
      const res = await fetch('/api/spotify/queue');
      if (!res.ok) return;
      const j = (await res.json()) as {
        currently_playing: { uri: string | null } | null;
        queue: { uri: string | null }[];
      };
      dbg('spotify-queue', {
        playing: shortUri(j.currently_playing?.uri),
        queue: (j.queue ?? []).slice(0, 12).map((t) => shortUri(t.uri)),
        ourUpcoming: timeline?.upcoming.slice(0, 12).map(shortUri),
        lastPushed: lastPushedUris.slice(0, 12).map(shortUri),
      });
    } catch { /* diagnostic only */ }
  }

  // Bumped on every start/stop/re-push so an in-flight async follow/re-push
  // bails if the session changed under it.
  let samplerGeneration = 0;

  // Push [current, ...upcoming] as a real Spotify context so native NEXT/PREV
  // walk our shuffle. `positionMs`, when given, continues the current track at
  // that offset (used on re-push so the song doesn't restart). Returns whether
  // the push landed; records the exact list we sent in lastPushedUris.
  async function pushContext(gen: number, positionMs?: number): Promise<boolean> {
    const tl = timeline;
    if (!tl?.current) return false;
    const uris = [tl.current, ...tl.upcoming].slice(0, MAX_CONTEXT);
    const payload: Record<string, unknown> = { uris };
    if (positionMs != null) payload.position_ms = Math.max(0, Math.floor(positionMs));
    dbg('pushContext', { n: uris.length, cur: shortUri(tl.current), pos: positionMs ?? 0 });
    const ok = await callPlay(payload);
    if (gen !== samplerGeneration || !ok) return false;
    lastPushedUris = uris;
    // Give Spotify a few polls to actually land on `current` before we treat an
    // off-list URI as divergence or a null as a drain.
    contextSettleUntil = Date.now() + 5000;
    return true;
  }

  async function startSampler(opts?: { reset?: boolean }): Promise<void> {
    if (samplerBusy) return;
    samplerBusy = true;
    dbg('startSampler', { reset: opts?.reset === true });
    try {
      const gen = ++samplerGeneration;
      // reset → clean slate (Shuffle button); otherwise resume a persisted timeline.
      let tl = opts?.reset
        ? await postTimelineAction({ action: 'reset' })
        : await fetchTimeline();
      if (gen !== samplerGeneration) return;
      if (!tl || !tl.current) {
        tl = await postTimelineAction({ action: 'forward' }); // materialize first pick
        if (gen !== samplerGeneration) return;
      }
      if (!tl || !tl.current) { isSampling = false; timeline = null; return; }
      timeline = tl;
      const ok = await pushContext(gen);
      if (gen !== samplerGeneration) return;
      if (!ok) { isSampling = false; timeline = null; return; }
      isSampling = true;
    } finally {
      samplerBusy = false;
    }
  }

  // Follow a native advance/rewind: sync the server cursor to the URI Spotify
  // landed on, then re-push if Spotify is running low on context runway so it
  // never autoplays past the end of our shuffle.
  async function followToUri(gen: number, uri: string, positionMs: number): Promise<void> {
    const tl = await postTimelineAction({ action: 'sync', uri });
    if (gen !== samplerGeneration) return;
    if (tl) timeline = tl;
    // lastIndexOf (not indexOf): on a duplicate URI this errs toward a SMALLER
    // remaining estimate, so we re-push slightly early rather than risk Spotify
    // autoplaying past the end of the context.
    const idx = lastPushedUris.lastIndexOf(uri);
    const remaining = idx === -1 ? 0 : lastPushedUris.length - 1 - idx;
    if (remaining <= REPUSH_LOW_WATER) {
      // Guard against yanking playback backward: if a fast second native skip
      // moved Spotify off `uri` while we were syncing, skip the re-push and let
      // the next poll handle the new position.
      if (state.track?.uri !== uri) { dbg('decision', { branch: 're-push:skip-stale' }); return; }
      dbg('decision', { branch: 're-push', remaining });
      await pushContext(gen, positionMs);
    }
  }

  // Re-establish our context from scratch — used on drain (Spotify ran off the
  // end / stopped) and on reload resume. Pulls a fresh timeline if needed.
  async function reseedSampler(gen: number, positionMs?: number): Promise<void> {
    let tl = await fetchTimeline();
    if (gen !== samplerGeneration) return;
    if (!tl || !tl.current) {
      tl = await postTimelineAction({ action: 'forward' });
      if (gen !== samplerGeneration) return;
    }
    if (!tl || !tl.current) { stopSampling(); return; }
    timeline = tl;
    const ok = await pushContext(gen, positionMs);
    if (gen !== samplerGeneration) return;
    if (!ok) { stopSampling(); return; }
  }

  // Run after every poll. Car mode: Spotify drives playback through the pushed
  // context; we observe which URI it's on and follow.
  //  1. In sync (Spotify on our current) → nothing to do.
  //  2. Advanced/rewound within the pushed context → follow + re-push if low.
  //  3. Drained (Spotify stopped, ran off the end) → re-seed.
  //  4. Diverged (Spotify on a URI not in our context — user played/edited in
  //     Spotify) → get out of the way; a later return to our list re-syncs.
  function maybeAdvanceSampler(
    currentUri: string | null,
    positionMs: number,
    durationMs: number,
  ): void {
    if (!isSampling) { lastCurrentUri = currentUri; return; }

    dbg('poll', {
      cur: shortUri(currentUri),
      pos: positionMs,
      dur: durationMs,
      vcur: shortUri(timeline?.current),
      pushed: lastPushedUris.length,
      busy: samplerBusy,
    });
    void logSpotifyQueue();

    if (samplerBusy) return;

    // 1. In sync.
    if (currentUri != null && currentUri === timeline?.current) {
      lastCurrentUri = currentUri;
      return;
    }

    // 2. Native advance/rewind within the context we pushed → follow it.
    if (currentUri != null && lastPushedUris.includes(currentUri)) {
      dbg('decision', { branch: 'follow', cur: shortUri(currentUri) });
      samplerBusy = true;
      const gen = samplerGeneration;
      void followToUri(gen, currentUri, positionMs).finally(() => { samplerBusy = false; });
      lastCurrentUri = currentUri;
      return;
    }

    // Settle window: right after a push, Spotify may still report the pre-push
    // track (or a transient null) for a poll or two. Don't stop or reseed yet.
    if (Date.now() < contextSettleUntil) {
      dbg('decision', { branch: 'settling', cur: shortUri(currentUri) });
      lastCurrentUri = currentUri;
      return;
    }

    // 3. Drained — Spotify stopped (null). Only reseed if the track that just
    // ended was actually OURS. If we drained off a diverged (user-played) track
    // — e.g. they diverged during the settle window, then it ended — stop
    // instead of reseeding over their Spotify session.
    if (currentUri == null && lastCurrentUri != null) {
      const wasOurs =
        lastCurrentUri === timeline?.current || lastPushedUris.includes(lastCurrentUri);
      if (!wasOurs) {
        dbg('decision', { branch: 'diverged-drain-stop', last: shortUri(lastCurrentUri) });
        stopSampling();
        lastCurrentUri = currentUri;
        return;
      }
      dbg('decision', { branch: 'reseed-drain' });
      samplerBusy = true;
      const gen = samplerGeneration;
      void reseedSampler(gen).finally(() => { samplerBusy = false; });
      // Leave lastCurrentUri so a still-null next poll retries the reseed.
      return;
    }

    // 4. Divergence — Spotify is on a URI that isn't ours and isn't in the
    // pushed context. The user played something else or edited the queue in
    // Spotify with a track outside our list. We've lost the thread — stop
    // sampling cleanly (sticky, so a later drain won't reseed over the user's
    // own Spotify session). They can re-shuffle to take back over.
    if (currentUri != null) {
      dbg('decision', { branch: 'diverged-stop', cur: shortUri(currentUri) });
      stopSampling();
      lastCurrentUri = currentUri;
      return;
    }

    lastCurrentUri = currentUri;
  }

  function stopSampling(): void {
    samplerGeneration++;
    isSampling = false;
    timeline = null;
    lastPushedUris = [];
  }

  // Auto-resume car mode after a page reload. The store is reconstructed empty
  // on every navigation; if Spotify is still on a track our timeline owns, take
  // the session back over and RE-PUSH a fresh context (we can't know what
  // Spotify still has queued from before the reload, so re-establish it — one
  // re-seek on reload is acceptable). Gated on the localStorage sampler flag.
  let resumeAttemptInflight: Promise<void> | null = null;
  async function tryResumeSampler(): Promise<void> {
    if (isSampling) return;
    if (resumeAttemptInflight) { await resumeAttemptInflight; return; }
    let flagSet = false;
    try {
      if (browser) flagSet = localStorage.getItem('discovery.sampler') === '1';
    } catch { return; }
    if (!flagSet) return;

    resumeAttemptInflight = (async () => {
      try {
        if (samplerBusy) return;
        samplerBusy = true;
        try {
          const tl = await fetchTimeline();
          if (!tl || !tl.current) return;
          const currentUri = state.track?.uri ?? null;
          if (currentUri == null) return;
          // Own it only if Spotify's current is somewhere in our timeline.
          const owned =
            currentUri === tl.current ||
            tl.upcoming.includes(currentUri) ||
            tl.history.includes(currentUri);
          if (!owned) return;
          const gen = samplerGeneration;
          const synced = await postTimelineAction({ action: 'sync', uri: currentUri });
          if (gen !== samplerGeneration) return;
          timeline = synced ?? tl;
          isSampling = true;
          await pushContext(gen, state.position_ms);
        } finally {
          samplerBusy = false;
        }
      } finally {
        resumeAttemptInflight = null;
      }
    })();
    await resumeAttemptInflight;
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

  // Car mode: in-app prev/next are thin passthroughs to Spotify's native
  // controls. Because Spotify's context IS our shuffle, native next/previous
  // walk our list (including Spotify's own "prev restarts after a few seconds"
  // rule). The next poll syncs our cursor to follow. No virtual-cursor math.
  async function next(): Promise<void> {
    if (!isSampling) await tryResumeSampler();
    await callControl('next');
  }
  async function prev(): Promise<void> {
    if (!isSampling) await tryResumeSampler();
    await callControl('previous');
  }

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
    get timeline() { return timeline; },
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
