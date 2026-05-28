// MusicBrainz lookup for cover/cross-artist versions.
//
// Flow:
//   1. ISRC → recordings (`/ws/2/isrc/{isrc}`)
//   2. Recording → works (`/ws/2/recording/{mbid}?inc=work-rels`)
//   3. Work → other recordings (`/ws/2/work/{mbid}?inc=recording-rels`)
//   4. Caller maps recordings back to Spotify via search.
//
// Anonymous quota is ~1 request per second; we serialize via a tiny in-process
// queue. A 1-hour in-memory LRU caches lookups so repeat clicks are instant.
// MusicBrainz requires a contact-bearing User-Agent — sending the repo URL.

const UA = 'Discovery/0.1 ( https://github.com/DavidSimmerman/discovery )';
const BASE = 'https://musicbrainz.org/ws/2';

// Serialize requests at ~1 rps. Sequential `await next` runs the queue tail-first.
let mbChain: Promise<unknown> = Promise.resolve();
const MIN_INTERVAL_MS = 1100;
let lastFiredAt = 0;

async function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastFiredAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFiredAt = Date.now();
    return fn();
  };
  const next = mbChain.then(run, run);
  mbChain = next.catch(() => undefined);
  return next;
}

async function mbFetch<T>(path: string): Promise<T | null> {
  return rateLimited(async () => {
    const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as T;
  });
}

type CachedLookup = { at: number; works: MBWork[] };
type MBRecording = {
  id: string;
  title: string;
  'artist-credit'?: { name: string }[];
  length?: number | null;
};
type MBWork = {
  id: string;
  title: string;
};
type MBWorkWithRecordings = MBWork & {
  relations?: Array<{
    'target-type'?: string;
    recording?: MBRecording;
    direction?: string;
  }>;
};
type MBIsrcResponse = {
  recordings?: Array<{
    id: string;
    relations?: Array<{ 'target-type'?: string; work?: MBWork }>;
  }>;
};
type MBRecordingResponse = {
  relations?: Array<{ 'target-type'?: string; work?: MBWork }>;
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const isrcCache = new Map<string, CachedLookup>();

function cacheGet(isrc: string): MBWork[] | null {
  const hit = isrcCache.get(isrc);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    isrcCache.delete(isrc);
    return null;
  }
  // Re-insert to refresh LRU position.
  isrcCache.delete(isrc);
  isrcCache.set(isrc, hit);
  return hit.works;
}

function cacheSet(isrc: string, works: MBWork[]): void {
  isrcCache.set(isrc, { at: Date.now(), works });
  if (isrcCache.size > CACHE_MAX) {
    const oldest = isrcCache.keys().next().value;
    if (oldest !== undefined) isrcCache.delete(oldest);
  }
}

export type CoverRecording = {
  mbid: string;
  title: string;
  artistName: string;
};

/**
 * Given an ISRC, return all "other" recordings of the same work(s) — i.e.
 * the candidate set of covers and cross-artist versions. Returns an empty
 * array if MusicBrainz has no match for this recording.
 */
export async function findCoverRecordings(isrc: string): Promise<CoverRecording[]> {
  let works = cacheGet(isrc);
  if (!works) {
    const isrcRes = await mbFetch<MBIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}?inc=work-rels`);
    const recordings = isrcRes?.recordings ?? [];
    const workIds = new Set<string>();
    for (const r of recordings) {
      for (const rel of r.relations ?? []) {
        if (rel['target-type'] === 'work' && rel.work?.id) workIds.add(rel.work.id);
      }
    }
    // Some ISRCs come back without inline work-rels; fall back to a per-recording fetch.
    if (workIds.size === 0 && recordings.length > 0) {
      for (const r of recordings.slice(0, 3)) {
        const rec = await mbFetch<MBRecordingResponse>(`/recording/${r.id}?inc=work-rels`);
        for (const rel of rec?.relations ?? []) {
          if (rel['target-type'] === 'work' && rel.work?.id) workIds.add(rel.work.id);
        }
      }
    }
    works = Array.from(workIds).map((id) => ({ id, title: '' }));
    cacheSet(isrc, works);
  }

  if (works.length === 0) return [];

  // Fan in recordings for each work. Cap at 2 works to bound latency — most
  // songs have exactly one work, and a few have multiple registrations of the
  // same composition that point to the same recordings.
  const out: CoverRecording[] = [];
  const seen = new Set<string>();
  for (const work of works.slice(0, 2)) {
    const w = await mbFetch<MBWorkWithRecordings>(`/work/${work.id}?inc=recording-rels+artist-credits`);
    for (const rel of w?.relations ?? []) {
      if (rel['target-type'] !== 'recording' || !rel.recording) continue;
      const rec = rel.recording;
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      const artistName = (rec['artist-credit'] ?? []).map((a) => a.name).join(', ').trim();
      if (!artistName || !rec.title) continue;
      out.push({ mbid: rec.id, title: rec.title, artistName });
    }
  }
  return out;
}
