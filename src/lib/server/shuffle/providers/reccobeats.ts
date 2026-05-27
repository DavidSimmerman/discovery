// ReccoBeats client — third-party Spotify audio-features replacement.
// Free, no auth required. Accepts Spotify IDs natively.
//
// FIRST-RUN VERIFICATION NEEDED: the docs at reccobeats.com are thin on response
// shapes. Endpoint and field names below match the v1 spec at time of writing
// (Nov 2025), but the live response should be inspected on first call and the
// parser adjusted if anything differs. The DB cache shape (`track_features`)
// is the contract; how we get there can flex.

import { db } from '$lib/server/db';
import { trackFeatures } from '$lib/server/db/schema';
import { inArray } from 'drizzle-orm';

const BASE = 'https://api.reccobeats.com';

export interface AudioFeatures {
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  speechiness: number | null;
  tempo: number | null;        // BPM
  loudness: number | null;     // dB
}

// Convert a "spotify:track:abc" URI to the bare base-62 ID ReccoBeats wants.
function spotifyIdFromUri(uri: string): string {
  const m = uri.match(/^spotify:track:(.+)$/);
  return m ? m[1] : uri;
}

/**
 * Fetch audio features for one or many Spotify IDs. Returns a map of
 * spotify_track_uri → AudioFeatures. Missing tracks omitted from the map.
 *
 * Batches via the documented `?ids=` query param. ReccoBeats doesn't publish a
 * batch ceiling; chunk to 40 IDs per request to stay polite.
 */
export async function fetchAudioFeatures(
  uris: string[],
): Promise<Map<string, AudioFeatures>> {
  const result = new Map<string, AudioFeatures>();
  if (uris.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < uris.length; i += 40) chunks.push(uris.slice(i, i + 40));

  for (const chunk of chunks) {
    const ids = chunk.map(spotifyIdFromUri).join(',');
    const url = `${BASE}/v1/audio-features?ids=${encodeURIComponent(ids)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      // ReccoBeats is unauthenticated and best-effort; never throw, just skip.
      console.warn(`[reccobeats] ${res.status} for chunk of ${chunk.length}`);
      continue;
    }
    const json = await res.json();
    // Response shape (best understanding): { content: [{ id, energy, valence, ... }] }
    // — verify on first run and adjust this extraction if needed.
    const rows: any[] = json.content ?? json.audioFeatures ?? json.tracks ?? [];
    for (const row of rows) {
      const spotifyId = row.spotifyId ?? row.id;
      if (!spotifyId) continue;
      const uri = chunk.find((u) => spotifyIdFromUri(u) === spotifyId);
      if (!uri) continue;
      result.set(uri, {
        energy: numOrNull(row.energy),
        valence: numOrNull(row.valence),
        danceability: numOrNull(row.danceability),
        acousticness: numOrNull(row.acousticness),
        instrumentalness: numOrNull(row.instrumentalness),
        liveness: numOrNull(row.liveness),
        speechiness: numOrNull(row.speechiness),
        tempo: numOrNull(row.tempo),
        loudness: numOrNull(row.loudness),
      });
    }
  }
  return result;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Cache-first read. Misses are fetched and persisted. Audio features are
 * effectively immutable per track, so cache never expires.
 */
export async function getCachedAudioFeatures(
  uris: string[],
): Promise<Map<string, AudioFeatures>> {
  if (uris.length === 0) return new Map();

  const rows = await db
    .select()
    .from(trackFeatures)
    .where(inArray(trackFeatures.spotifyTrackUri, uris));

  const cached = new Map<string, AudioFeatures>();
  for (const r of rows) {
    cached.set(r.spotifyTrackUri, {
      energy: r.energy,
      valence: r.valence,
      danceability: r.danceability,
      acousticness: r.acousticness,
      instrumentalness: r.instrumentalness,
      liveness: r.liveness,
      speechiness: r.speechiness,
      tempo: r.tempo,
      loudness: r.loudness,
    });
  }

  const missing = uris.filter((u) => !cached.has(u));
  if (missing.length === 0) return cached;

  const fresh = await fetchAudioFeatures(missing);
  if (fresh.size > 0) {
    await db
      .insert(trackFeatures)
      .values(
        [...fresh.entries()].map(([uri, f]) => ({
          spotifyTrackUri: uri,
          ...f,
          provider: 'reccobeats',
        })),
      )
      .onConflictDoNothing();
  }

  for (const [uri, f] of fresh) cached.set(uri, f);
  return cached;
}
