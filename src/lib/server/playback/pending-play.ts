// Server-side "pending play": when the user starts playback but Spotify has no
// available device at all (app fully killed), the client arms a job here and
// deep-links the user into Spotify. We poll the device list and fire the play
// the moment Spotify shows up — while the user is still looking at the Spotify
// app, since the suspended PWA can't do it from the background. iOS freezes a
// backgrounded PWA's JS entirely, so client-side retry alone would only start
// the music after the user flips BACK to discovery; this makes it start the
// instant Spotify opens.
//
// In-memory by design: discovery is a single-instance, ≤5-user app (Spotify
// dev-mode cap). A lost job on server restart costs one extra tap, nothing else.

import { getValidAccessToken } from '$lib/server/tokens';
import { listDevices, pickBestDevice } from './devices';
import { spotifyPlay } from './spotify-play';

const POLL_MS = 2000;
const TTL_MS = 60_000;

export type PendingPlayStatus =
  | 'pending'     // armed, polling for a device
  | 'started'     // play fired successfully
  | 'superseded'  // a device appeared already playing — user beat us, backed off
  | 'expired'     // no device within the TTL
  | 'cancelled';  // explicitly cancelled by the client

export interface PendingPlayPayload {
  uris: string[];
  position_ms?: number;
}

interface Job {
  payload: PendingPlayPayload;
  deadline: number;
  status: PendingPlayStatus;
  timer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, Job>();

export function armPendingPlay(userId: string, payload: PendingPlayPayload): void {
  cancelPendingPlay(userId);
  const job: Job = {
    payload,
    deadline: Date.now() + TTL_MS,
    status: 'pending',
    timer: null,
  };
  jobs.set(userId, job);
  schedule(userId, job);
}

export function getPendingPlay(
  userId: string,
): { status: PendingPlayStatus; payload: PendingPlayPayload } | null {
  const job = jobs.get(userId);
  return job ? { status: job.status, payload: job.payload } : null;
}

export function cancelPendingPlay(userId: string): void {
  const job = jobs.get(userId);
  if (!job) return;
  if (job.timer != null) clearTimeout(job.timer);
  job.timer = null;
  if (job.status === 'pending') job.status = 'cancelled';
}

export function _resetPendingPlayForTests(): void {
  for (const job of jobs.values()) {
    if (job.timer != null) clearTimeout(job.timer);
  }
  jobs.clear();
}

function schedule(userId: string, job: Job): void {
  job.timer = setTimeout(() => void tick(userId, job), POLL_MS);
  // Don't hold the process open for a poll loop (no-op in browsers/tests).
  (job.timer as { unref?: () => void }).unref?.();
}

async function tick(userId: string, job: Job): Promise<void> {
  // The job object is captured at arm time; if re-armed/cancelled since, this
  // instance is stale — its status will have been flipped or replaced in the
  // map, so just bail.
  if (job.status !== 'pending') return;
  if (Date.now() >= job.deadline) {
    job.status = 'expired';
    return;
  }

  try {
    const { access_token } = await getValidAccessToken(userId);
    const device = pickBestDevice(await listDevices(access_token));
    if (device?.id != null) {
      // A device showed up — but if the user already pressed play themselves
      // (in Spotify, before our poll noticed), starting OUR queue would yank
      // their music away. Back off instead.
      if (await isAlreadyPlaying(access_token)) {
        job.status = 'superseded';
        return;
      }
      const payload: Record<string, unknown> = { uris: job.payload.uris };
      if (typeof job.payload.position_ms === 'number') {
        payload.position_ms = job.payload.position_ms;
      }
      const res = await spotifyPlay(access_token, payload, device.id);
      if (res.ok) {
        job.status = 'started';
        return;
      }
      // Device flapped away or transient error — keep polling until deadline.
    }
  } catch {
    /* token/network hiccup — keep polling until deadline */
  }
  if (job.status === 'pending') schedule(userId, job);
}

async function isAlreadyPlaying(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 204 || !res.ok) return false; // no session at all
    const j = (await res.json()) as { is_playing?: boolean };
    return j?.is_playing === true;
  } catch {
    return false;
  }
}
