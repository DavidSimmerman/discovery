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

// Pre-queue lead: when a track's remaining time falls below this, the next item
// in our virtual timeline gets pushed into Spotify's queue so the transition is
// gapless. Kept short so the queue UI (slice 3) can remove/reorder upcoming[0]
// for most of the song before it "locks". 5s is well above the 2.5s active-tab
// poll cadence (we won't miss the window) and short enough that interaction
// feels live.
const PRE_QUEUE_LEAD_MS = 5000;

// Decision predicates for sampler advance, extracted so the rune machinery
// doesn't have to be mocked to verify them.
export function shouldObserveAdvance(
  samplerQueuedUri: string | null,
  currentUri: string | null,
): boolean {
  // Spotify has transitioned into the track we pre-queued. Time to sync the
  // server-side cursor and (later) pre-queue the next one.
  return samplerQueuedUri != null && currentUri === samplerQueuedUri;
}

export function shouldPreQueueNext(
  expectedCurrent: string | null,
  currentUri: string | null,
  samplerQueuedUri: string | null,
  remainingMs: number,
): boolean {
  // Only pre-queue when (a) the currently-playing URI matches what our
  // timeline thinks is current — otherwise the user is on something we don't
  // own, (b) we haven't already pre-queued, and (c) the remaining time has
  // dropped into the pre-queue lead window.
  return (
    expectedCurrent != null &&
    currentUri === expectedCurrent &&
    samplerQueuedUri == null &&
    remainingMs > 0 &&
    remainingMs <= PRE_QUEUE_LEAD_MS
  );
}

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

  // Start sampler-driven shuffle: hydrate the virtual timeline from
  // /api/shuffle/timeline, play timeline.current, and keep Spotify's queue
  // topped up one ahead via the pre-queue lead window. Stays active until the
  // user starts something else (playTrack/shuffle) or the timeline exhausts.
  startSampler(): Promise<void>;
  readonly isSampling: boolean;
  // Client mirror of the server-side timeline. Null when not sampling. The
  // queue view (slice 3) reads from this; back/forward updates it via the
  // timeline endpoint.
  readonly timeline: Timeline | null;
  // The URI we've already pushed into Spotify's queue ahead of the current
  // track. The Queue tab uses this to lock the matching upcoming row — once
  // pushed, removing/reordering it client-side would desync the cursor when
  // Spotify naturally advances into it. Null when nothing is pre-queued.
  readonly samplerQueuedUri: string | null;

  // Queue mutators — used by the queue tab in the now-playing tabbed panel.
  // Both update the local timeline mirror from the server response so the UI
  // doesn't have to wait for the next poll.
  removeFromQueue(uri: string, index: number): Promise<void>;
  reorderQueue(fromIndex: number, toIndex: number): Promise<void>;

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

  // Sampler / virtual-timeline state.
  //
  // timeline mirrors the server-side cursor (history/current/upcoming). It's
  // re-read after every action so the queue UI sees authoritative state and
  // we never diverge from what the next /forward will produce.
  //
  // samplerQueuedUri is the URI we've pushed into Spotify's queue ahead of the
  // current track. Tracking it lets us (a) recognize the natural transition
  // (Spotify's current URI changes to match this one) and (b) skip re-queueing
  // until the next pre-queue window.
  let isSampling = $state(false);
  let timeline = $state<Timeline | null>(null);
  // Reactive so the queue UI can lock the matching upcoming row — see
  // `samplerQueuedUri` getter on PlaybackStore. A row whose URI matches this
  // value is already in Spotify's queue and removing/reordering it would
  // desync the cursor when Spotify naturally advances into it.
  let samplerQueuedUri = $state<string | null>(null);
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

  // ── Sampler / virtual-timeline driver ────────────────────────────────

  async function callQueue(uri: string): Promise<boolean> {
    const res = await fetch('/api/spotify/player/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'queue', uri }),
    });
    return handleControlResponse(res);
  }

  type TimelineActionBody =
    | { action: 'advance' | 'forward' | 'back' }
    | { action: 'add'; uri: string; position?: number }
    | { action: 'remove'; uri: string; index?: number }
    | { action: 'reorder'; fromIndex: number; toIndex: number };

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
      if (!res.ok) return null;
      const j = (await res.json()) as { timeline: Timeline };
      return j.timeline ?? null;
    } catch { return null; }
  }

  // Bumped every time sampling starts/stops or the user performs an explicit
  // skip (next/prev). Async advance/pre-queue/reseed tasks capture this when
  // they begin and bail if it changes mid-flight — so a pick fetched for an
  // old session can't enqueue into a queue the user has since replaced.
  let samplerGeneration = 0;

  // Push the head of upcoming into Spotify's queue. Called from the pre-queue
  // window (last N seconds of the current track) so the transition is gapless.
  // Re-checks generation before AND after the network call so a concurrent
  // skip can't leave us with samplerQueuedUri pointing at a now-stale URI.
  async function preQueueUpcoming(gen: number): Promise<void> {
    const next = timeline?.upcoming[0] ?? null;
    if (!next) return;
    if (gen !== samplerGeneration) return;
    const ok = await callQueue(next);
    if (gen !== samplerGeneration || !ok) return;
    samplerQueuedUri = next;
  }

  // Spotify transitioned into the pre-queued URI. Sync the server-side cursor
  // (current → history, upcoming[0] → current, refill if low) and reset
  // samplerQueuedUri so the next pre-queue window can fire.
  async function onObservedAdvance(gen: number): Promise<void> {
    const tl = await postTimelineAction({ action: 'forward' });
    if (gen !== samplerGeneration) return;
    if (!tl || !tl.current) { stopSampling(); return; }
    timeline = tl;
    samplerQueuedUri = null;
  }

  async function startSampler(): Promise<void> {
    // Take the busy lock so a concurrent poll can't kick off a pre-queue under
    // a stale `timeline` while startSampler is still hydrating it. The poll's
    // own check (`samplerBusy`) is what enforces this — we just have to set it.
    if (samplerBusy) return;
    samplerBusy = true;
    try {
      const gen = ++samplerGeneration;
      samplerQueuedUri = null;
      // Resume an existing timeline if one is persisted; otherwise advance
      // from empty to materialize the first track (timeline endpoint refills
      // before advancing when upcoming is empty).
      let tl = await fetchTimeline();
      if (gen !== samplerGeneration) return;
      if (!tl || !tl.current) {
        tl = await postTimelineAction({ action: 'forward' });
        if (gen !== samplerGeneration) return;
      }
      if (!tl || !tl.current) { isSampling = false; timeline = null; return; }
      timeline = tl;
      // Only consider ourselves sampling once playback actually started.
      const ok = await callPlay({ uris: [tl.current] });
      if (gen !== samplerGeneration) return;
      if (!ok) { isSampling = false; timeline = null; return; }
      isSampling = true;
    } finally {
      samplerBusy = false;
    }
  }

  // Re-seed when sampling is active but Spotify drained to nothing (fast
  // double-skips, or a hidden tab polling slowly enough that a queued track
  // started and finished between polls). Re-uses startSampler's resume logic.
  async function reseedSampler(gen: number): Promise<void> {
    let tl = await fetchTimeline();
    if (gen !== samplerGeneration) return;
    if (!tl || !tl.current) {
      tl = await postTimelineAction({ action: 'forward' });
      if (gen !== samplerGeneration) return;
    }
    if (!tl || !tl.current) { stopSampling(); return; }
    timeline = tl;
    const ok = await callPlay({ uris: [tl.current] });
    if (gen !== samplerGeneration) return;
    if (!ok) { stopSampling(); return; }
    samplerQueuedUri = null;
  }

  // Run after every poll. Four cases:
  //  1. The pre-queued URI became current → POST forward to sync cursor.
  //  2. We're inside the pre-queue lead window → push upcoming[0] to Spotify.
  //  3. Playback drained (currentUri null but it was playing) → re-seed.
  //  4. Nothing to do.
  //
  // We only update lastCurrentUri when we actually evaluated the predicates.
  // If samplerBusy is true (a prior in-flight task), we leave lastCurrentUri
  // alone so a poll that observed `null` while we were busy still triggers
  // drain recovery on the next poll once the task settles. Otherwise drains
  // could be silently swallowed when they coincide with an in-flight action.
  function maybeAdvanceSampler(
    currentUri: string | null,
    positionMs: number,
    durationMs: number,
  ): void {
    if (!isSampling) { lastCurrentUri = currentUri; return; }
    if (samplerBusy) return;

    if (shouldObserveAdvance(samplerQueuedUri, currentUri)) {
      samplerBusy = true;
      const gen = samplerGeneration;
      void onObservedAdvance(gen).finally(() => { samplerBusy = false; });
      lastCurrentUri = currentUri;
      return;
    }

    const remaining = durationMs - positionMs;
    if (
      shouldPreQueueNext(timeline?.current ?? null, currentUri, samplerQueuedUri, remaining)
    ) {
      samplerBusy = true;
      const gen = samplerGeneration;
      void preQueueUpcoming(gen).finally(() => { samplerBusy = false; });
      lastCurrentUri = currentUri;
      return;
    }

    if (currentUri == null && lastCurrentUri != null) {
      samplerBusy = true;
      const gen = samplerGeneration;
      void reseedSampler(gen).finally(() => { samplerBusy = false; });
      // Don't update lastCurrentUri yet — let the next poll see whether the
      // reseed succeeded. If it did, currentUri will be non-null. If not,
      // drain recovery should fire again.
      return;
    }

    lastCurrentUri = currentUri;
  }

  function stopSampling(): void {
    samplerGeneration++;
    isSampling = false;
    timeline = null;
    samplerQueuedUri = null;
  }

  // Auto-resume sampler mode after a page reload. The store is reconstructed
  // empty on every navigation, so without this, Spotify continues playing the
  // sampler-driven track but back/forward fall through to Spotify's native
  // prev/next — which errors because we started with a single-URI playback
  // context. Replaced by a real setting in slice 6; for now we gate on the
  // localStorage flag the user already had to set to enable sampler mode.
  //
  // Idempotent. Safe to call from init() and from prev()/next() as a lazy
  // fallback for the brief window before init's resume finishes.
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
          // Resume only if Spotify is on a track our timeline owns. Match
          // against current (the normal case) or upcoming[0] (we'd pre-queued
          // and Spotify already advanced, but we hadn't observed it). Anything
          // else means the user is playing something we don't own and we
          // should stay out of the way.
          const currentUri = state.track?.uri ?? null;
          if (currentUri == null) return;
          const matchesCurrent = currentUri === tl.current;
          const matchesPreQueued = currentUri === (tl.upcoming[0] ?? null);
          if (!matchesCurrent && !matchesPreQueued) return;

          timeline = tl;
          isSampling = true;
          // If Spotify is on upcoming[0], we missed the observed advance —
          // sync the cursor now so the next pre-queue is correct.
          if (matchesPreQueued) {
            const gen = samplerGeneration;
            const advanced = await postTimelineAction({ action: 'forward' });
            if (gen === samplerGeneration && advanced) timeline = advanced;
          }
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

  // In sampler mode, prev/next move the virtual cursor and explicitly play the
  // new current — we don't rely on Spotify's native prev/next because (a) prev
  // would re-play the just-finished track from Spotify's history, not our
  // timeline's history, and (b) next would skip into whatever we pre-queued,
  // which is correct *only* by accident. Outside sampler mode, Spotify's
  // native prev/next still applies.
  async function moveCursor(direction: 'back' | 'forward'): Promise<void> {
    // Hold the busy lock for the whole skip so a concurrent poll can't fire a
    // pre-queue against the now-stale `timeline` (which would then look like
    // an observed-advance once playTrack lands on the same URI — a double-skip).
    if (samplerBusy) return;
    samplerBusy = true;
    try {
      // Stash pre-queue state so a boundary no-op (back at history start /
      // forward past an exhausted sampler) can restore it. Without this, a
      // user pressing back at the start of history would forget the URI we'd
      // already pushed to Spotify, and the later natural transition wouldn't
      // sync the cursor.
      const previousQueuedUri = samplerQueuedUri;
      const previousCurrent = timeline?.current ?? null;
      const gen = ++samplerGeneration; // invalidate any in-flight task
      samplerQueuedUri = null;
      const tl = await postTimelineAction({ action: direction });
      if (gen !== samplerGeneration) return;
      if (!tl) {
        // POST failed; we didn't actually move, so restore the pre-queue.
        samplerQueuedUri = previousQueuedUri;
        return;
      }
      // back() / advance() return the SAME timeline when they can't move
      // (back at start of history, forward at exhausted sampler — refill also
      // couldn't add anything). Don't replay the current track, and restore
      // the pre-queue so the natural transition still syncs.
      //
      // Note: when duplicate URIs land in adjacent timeline slots (only
      // possible once slice 5 lets the user add the same track twice), this
      // also no-ops on a real cursor move. The audio is identical either way
      // so it's not a functional bug — slice 5 can refine if needed.
      if (!tl.current || tl.current === previousCurrent) {
        timeline = tl;
        samplerQueuedUri = previousQueuedUri;
        return;
      }
      timeline = tl;
      await callPlay({ uris: [tl.current] });
    } finally {
      samplerBusy = false;
    }
  }

  async function next(): Promise<void> {
    // Lazy resume in case init's auto-resume hasn't landed yet (user can hit a
    // transport button within ms of page load). Idempotent — early-returns if
    // we're already sampling or the flag isn't set.
    if (!isSampling) await tryResumeSampler();
    if (isSampling) { await moveCursor('forward'); return; }
    await callControl('next');
  }
  async function prev(): Promise<void> {
    if (!isSampling) await tryResumeSampler();
    if (isSampling) { await moveCursor('back'); return; }
    await callControl('previous');
  }

  async function seek(positionMs: number): Promise<void> {
    state = { ...state, position_ms: positionMs };
    await callControl('seek', positionMs);
  }

  // Queue mutators share the same busy lock as moveCursor / pre-queue / advance:
  // without it, a pre-queue running concurrently with a remove can leave us with
  // samplerQueuedUri pointing at a URI that's no longer in upcoming. With the
  // lock, edits are serialized against advance/pre-queue and only the latest-
  // returned timeline wins (gen check prevents an older response overwriting a
  // newer one).
  async function mutateTimeline(
    body: { action: 'remove'; uri: string; index?: number } | { action: 'reorder'; fromIndex: number; toIndex: number },
  ): Promise<void> {
    if (!isSampling) return;
    if (samplerBusy) return;
    samplerBusy = true;
    const gen = samplerGeneration;
    try {
      const tl = await postTimelineAction(body);
      if (gen !== samplerGeneration) return;
      if (tl) timeline = tl;
    } finally {
      samplerBusy = false;
    }
  }

  async function removeFromQueue(uri: string, index: number): Promise<void> {
    await mutateTimeline({ action: 'remove', uri, index });
  }

  async function reorderQueue(fromIndex: number, toIndex: number): Promise<void> {
    if (fromIndex === toIndex) return;
    await mutateTimeline({ action: 'reorder', fromIndex, toIndex });
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
    get samplerQueuedUri() { return samplerQueuedUri; },
    togglePlay, next, prev, seek,
    removeFromQueue, reorderQueue,
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
