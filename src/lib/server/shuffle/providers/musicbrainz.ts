// MusicBrainz client — drives version/cover detection (work-rels) and credits
// graph (artist-rels: composer, lyricist, producer, engineer, etc.).
//
// MB caps everyone at 1 request/second, hard. We serialize through a shared
// limiter. Cache aggressively — recording/work data is immutable.

import { env } from '$env/dynamic/private';
const MUSICBRAINZ_USER_AGENT = env.MUSICBRAINZ_USER_AGENT ?? 'disccovery/0.1';

const BASE = 'https://musicbrainz.org/ws/2';

// MB recording-artist relationship targets we care about, mapped to our roles.
const ARTIST_REL_MAP: Record<string, string> = {
  producer: 'producer',
  engineer: 'engineer',
  mix: 'mixer',
  'mix-DJ': 'mixer',
  'mastering engineer': 'engineer',
  'recording engineer': 'engineer',
  performer: 'instrument',     // catch-all instrumentalist
  vocal: 'featured',
  arranger: 'arranger',
  remixer: 'producer',
  programming: 'producer',
};

// Work-artist relationship targets (composer/lyricist live on the work, not the recording).
const WORK_ARTIST_REL_MAP: Record<string, string> = {
  composer: 'composer',
  lyricist: 'lyricist',
  writer: 'composer',
  'instrument arranger': 'arranger',
};

export interface MbRecording {
  recordingMbid: string;
  workMbid: string | null;
  // Recording-level attribute flags from MB ("live", "cover", "acoustic", etc.).
  workAttributes: string[];
  // Credits derived from MB relationships, ready for our track_credits rows.
  credits: Array<{ personMbid: string; personName: string; role: string }>;
}

// ── rate limiter ──────────────────────────────────────────────────────────
let mbQueueTail: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = mbQueueTail.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 1100)); // 1 req/s with headroom
    return out;
  });
  // Swallow upstream rejections so a failed request doesn't poison the queue.
  mbQueueTail = next.catch(() => undefined);
  return next as Promise<T>;
}

async function mbFetch(path: string): Promise<any> {
  return throttled(async () => {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        'User-Agent': MUSICBRAINZ_USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[musicbrainz] ${path} ${res.status}`);
      return null;
    }
    return res.json();
  });
}

/**
 * Resolve a Spotify ISRC to MusicBrainz recording metadata: work MBID,
 * attribute flags, and the credits list (composer/lyricist/producer/etc.).
 *
 * If MB has no recording for this ISRC, returns null. This is common for
 * very new releases (MB lags by weeks/months) and most indie catalog.
 */
export async function fetchRecordingByIsrc(isrc: string): Promise<MbRecording | null> {
  const json = await mbFetch(
    `/isrc/${encodeURIComponent(isrc)}?inc=artist-rels+work-rels&fmt=json`,
  );
  if (!json?.recordings?.length) return null;

  // ISRCs can map to multiple recordings (re-issues etc.); take the first.
  // The enrichment worker can re-call with the work to pull more if needed.
  const rec = json.recordings[0];

  const recordingMbid: string = rec.id;
  const workRels = (rec.relations ?? []).filter((r: any) => r['target-type'] === 'work');
  const workMbid: string | null = workRels[0]?.work?.id ?? null;
  const workAttributes: string[] = Array.from(
    new Set(workRels.flatMap((r: any) => r.attributes ?? [])),
  );

  const credits: MbRecording['credits'] = [];
  // Recording-level artist credits (producer/engineer/etc.).
  for (const r of rec.relations ?? []) {
    if (r['target-type'] !== 'artist' || !r.artist) continue;
    const role = ARTIST_REL_MAP[r.type] ?? 'other';
    credits.push({ personMbid: r.artist.id, personName: r.artist.name, role });
  }

  // Work-level credits (composer/lyricist) — need a second call per work.
  // Deferred: caller decides whether to enrich. We hand back the workMbid so
  // the enrichment worker can call fetchWorkCredits.
  return { recordingMbid, workMbid, workAttributes, credits };
}

/**
 * Pull composer/lyricist credits for a work. Called separately because each
 * MB request burns a second of our rate budget — only fetch when needed.
 */
export async function fetchWorkCredits(
  workMbid: string,
): Promise<Array<{ personMbid: string; personName: string; role: string }>> {
  const json = await mbFetch(`/work/${encodeURIComponent(workMbid)}?inc=artist-rels&fmt=json`);
  if (!json?.relations) return [];
  const credits: Array<{ personMbid: string; personName: string; role: string }> = [];
  for (const r of json.relations) {
    if (r['target-type'] !== 'artist' || !r.artist) continue;
    const role = WORK_ARTIST_REL_MAP[r.type];
    if (!role) continue;       // skip relationship types we don't care about
    credits.push({ personMbid: r.artist.id, personName: r.artist.name, role });
  }
  return credits;
}
