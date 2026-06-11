import { createHash } from 'node:crypto';
import { db } from '$lib/server/db';
import { liveActivities } from '$lib/server/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { fetchCurrentlyPlaying } from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';
import { largestAlbumArtUrl } from '$lib/server/tracks';
import { findRatingByUriOrIsrc } from '$lib/server/ratings';
import { pushActivityUpdate, type ApnsPushResult, type LiveActivityPushOptions } from '$lib/server/apns';

// Server-side driver for iOS Live Activities. While a user has an active
// activity registered (live_activities.ended_at is null), poll their Spotify
// currently-playing state and push APNs content-state updates on change. After
// playback has been stopped/paused for STOPPED_END_MS, end the activity.

const POLL_INTERVAL_MS = 5_000;
export const STOPPED_END_MS = 10 * 60_000;

// Mirrors NowPlayingAttributes.ContentState in the iOS widget — keys must
// match exactly (ActivityKit decodes the push's content-state with Codable).
export interface ActivityContentState extends Record<string, unknown> {
  trackUri: string | null;
  title: string;
  artists: string;
  artworkUrl: string | null;
  rating: number | null;
  isPlaying: boolean;
}

export interface PlayingSnapshot {
  uri: string;
  name: string;
  artists: string[];
  albumArtUrl: string | null;
  isPlaying: boolean;
}

export function computeContentState(
  playing: PlayingSnapshot | null,
  rating: number | null,
): ActivityContentState | null {
  if (!playing) return null;
  return {
    trackUri: playing.uri,
    title: playing.name,
    artists: playing.artists.join(', '),
    artworkUrl: playing.albumArtUrl,
    rating,
    isPlaying: playing.isPlaying,
  };
}

export function hashContentState(state: ActivityContentState): string {
  // Key order is fixed by computeContentState, so plain JSON is stable.
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export interface ActivityRow {
  id: string;
  userId: string;
  apnsPushToken: string;
  contentStateHash: string | null;
  lastTrackUri: string | null;
  stoppedSince: Date | null;
}

export interface PollDecision {
  push: { state: ActivityContentState; hash: string } | null;
  /** New value for the row's stopped_since column. */
  stoppedSince: Date | null;
  end: boolean;
}

export function decidePollAction(
  row: ActivityRow,
  current: ActivityContentState | null,
  now: Date,
): PollDecision {
  const stopWindowElapsed =
    row.stoppedSince !== null && now.getTime() - row.stoppedSince.getTime() > STOPPED_END_MS;

  if (!current) {
    return { push: null, stoppedSince: row.stoppedSince ?? now, end: stopWindowElapsed };
  }

  const hash = hashContentState(current);
  const push = hash !== row.contentStateHash ? { state: current, hash } : null;

  if (current.isPlaying) {
    return { push, stoppedSince: null, end: false };
  }
  // Paused: surface the paused state, but let the stop clock run so an
  // abandoned paused session still ends the activity.
  return { push, stoppedSince: row.stoppedSince ?? now, end: stopWindowElapsed };
}

export interface PollerDeps {
  listActiveActivities(): Promise<ActivityRow[]>;
  getAccessToken(userId: string): Promise<string>;
  fetchPlaying(
    userId: string,
    accessToken: string,
  ): Promise<{ playing: PlayingSnapshot | null; rating: number | null }>;
  push(
    pushToken: string,
    contentState: ActivityContentState | null,
    opts: LiveActivityPushOptions,
  ): Promise<ApnsPushResult>;
  updateRow(id: string, fields: Record<string, unknown>): Promise<void>;
  now(): Date;
}

const DEAD_TOKEN_REASONS = /^(BadDeviceToken|Unregistered|ExpiredToken|ExpiredPushToken)$/;

function isDeadToken(res: ApnsPushResult): boolean {
  return !res.ok && (res.status === 410 || DEAD_TOKEN_REASONS.test(res.reason));
}

async function processRow(row: ActivityRow, deps: PollerDeps): Promise<void> {
  const accessToken = await deps.getAccessToken(row.userId);
  const { playing, rating } = await deps.fetchPlaying(row.userId, accessToken);
  const current = computeContentState(playing, rating);
  const decision = decidePollAction(row, current, deps.now());

  if (decision.end) {
    const res = await deps.push(row.apnsPushToken, current, { event: 'end' });
    // Close the row when the end was delivered, the token is dead anyway, or
    // APNs isn't configured (nothing will ever deliver). A transient failure
    // (5xx, network) leaves the row active so the next tick retries the end.
    const unrecoverable = !res.ok && res.reason === 'apns-not-configured';
    if (res.ok || isDeadToken(res) || unrecoverable) {
      await deps.updateRow(row.id, { endedAt: deps.now() });
    }
    return;
  }

  if (decision.push) {
    const res = await deps.push(row.apnsPushToken, decision.push.state, { event: 'update' });
    if (isDeadToken(res)) {
      await deps.updateRow(row.id, { endedAt: deps.now() });
      return;
    }
    if (res.ok) {
      await deps.updateRow(row.id, {
        contentStateHash: decision.push.hash,
        lastTrackUri: decision.push.state.trackUri,
        stoppedSince: decision.stoppedSince,
      });
    }
    return;
  }

  // Nothing pushed — persist stop-clock transitions only.
  const prev = row.stoppedSince?.getTime() ?? null;
  const next = decision.stoppedSince?.getTime() ?? null;
  if (prev !== next) {
    await deps.updateRow(row.id, { stoppedSince: decision.stoppedSince });
  }
}

export async function tickOnce(deps: PollerDeps): Promise<void> {
  const rows = await deps.listActiveActivities();
  for (const row of rows) {
    try {
      await processRow(row, deps);
    } catch (err) {
      // One user's failure (expired refresh token, Spotify 5xx) must not
      // stall everyone else's lock screen.
      console.error(`[live-activity] poll failed for user ${row.userId}`, err);
    }
  }
}

/**
 * Re-evaluate one user's activity right now — called after a rating write so
 * the lock screen updates without waiting for the next poll tick.
 */
export async function nudgeUserActivities(
  userId: string,
  deps: PollerDeps = realDeps,
): Promise<void> {
  const rows = (await deps.listActiveActivities()).filter((r) => r.userId === userId);
  for (const row of rows) {
    try {
      await processRow(row, deps);
    } catch (err) {
      console.error(`[live-activity] nudge failed for user ${userId}`, err);
    }
  }
}

export const realDeps: PollerDeps = {
  async listActiveActivities() {
    return db.select().from(liveActivities).where(isNull(liveActivities.endedAt));
  },
  async getAccessToken(userId) {
    const { access_token } = await getValidAccessToken(userId);
    return access_token;
  },
  async fetchPlaying(userId, accessToken) {
    const result = await fetchCurrentlyPlaying(accessToken);
    if (!result?.item) return { playing: null, rating: null };
    const rating = await findRatingByUriOrIsrc(userId, result.item.uri);
    return {
      playing: {
        uri: result.item.uri,
        name: result.item.name,
        artists: result.item.artists.map((a) => a.name),
        albumArtUrl: largestAlbumArtUrl(result.item),
        isPlaying: result.is_playing,
      },
      rating: rating?.ratingStars ?? null,
    };
  },
  push(pushToken, contentState, opts) {
    return pushActivityUpdate(pushToken, contentState, opts);
  },
  async updateRow(id, fields) {
    await db.update(liveActivities).set(fields).where(eq(liveActivities.id, id));
  },
  now: () => new Date(),
};

let started = false;
let ticking = false;

/** Idempotent; called once from hooks.server.ts init. */
export function startLiveActivityPoller(): void {
  if (started) return;
  started = true;
  setInterval(async () => {
    if (ticking) return; // skip overlapping ticks on slow Spotify days
    ticking = true;
    try {
      await tickOnce(realDeps);
    } catch (err) {
      console.error('[live-activity] tick failed', err);
    } finally {
      ticking = false;
    }
  }, POLL_INTERVAL_MS).unref?.();
}
