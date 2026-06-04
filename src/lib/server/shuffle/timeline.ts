// Virtual playback timeline: a single ordered list cursored by `current`.
//
// Why we own this instead of relying on Spotify's queue:
// the Spotify Web API exposes only POST /me/player/queue (add) and GET
// /me/player/queue (read) — no remove, no reorder. To support an interactive
// queue, a back/forward cursor (the A–K example), and a persistent history
// across reloads, disccovery keeps its own list and plays one item at a time.
//
// Layout (chronological order is history ++ [current] ++ upcoming):
//   history:  what already played, oldest at history[0], most recent last
//   current:  what is playing now (null until first advance)
//   upcoming: what is queued, upcoming[0] plays next
//
// All operations are pure: take a Timeline, return a new Timeline. No DB, no
// network, no hidden state. The HTTP layer loads/persists alongside the
// sampler state in shuffleSessions.state.

export type Timeline = {
  history: string[];
  current: string | null;
  upcoming: string[];
};

export function emptyTimeline(): Timeline {
  return { history: [], current: null, upcoming: [] };
}

// Move the cursor forward one step: current → history, upcoming[0] → current.
// Used for both natural track-end and the explicit Forward button — the
// semantics are identical (advance one slot through the ordered list).
export function advance(tl: Timeline): Timeline {
  if (tl.upcoming.length === 0) return tl;
  const [next, ...rest] = tl.upcoming;
  const history = tl.current == null ? tl.history : [...tl.history, tl.current];
  return { history, current: next, upcoming: rest };
}

export const forward = advance;

// Move the cursor back one step: current → upcoming[0], history.last → current.
// The previously-current track lands at the head of upcoming so a subsequent
// forward press returns to it (A→B→A round-trip).
export function back(tl: Timeline): Timeline {
  if (tl.history.length === 0) return tl;
  const history = tl.history.slice(0, -1);
  const prev = tl.history[tl.history.length - 1];
  const upcoming = tl.current == null ? tl.upcoming : [tl.current, ...tl.upcoming];
  return { history, current: prev, upcoming };
}

// Insert into upcoming. Position defaults to "append" (after the last item).
// Out-of-range positions clamp rather than throw — the UI can send any number
// and get sensible behavior.
export function addToUpcoming(tl: Timeline, uri: string, position?: number): Timeline {
  const pos = position == null
    ? tl.upcoming.length
    : Math.max(0, Math.min(tl.upcoming.length, position));
  const upcoming = [...tl.upcoming.slice(0, pos), uri, ...tl.upcoming.slice(pos)];
  return { ...tl, upcoming };
}

// Remove an item from upcoming. If `index` is provided, only that slot is
// removed (used when upcoming holds duplicates and the UI needs to delete a
// specific row). Otherwise, the first occurrence of `uri` is removed. The
// `current` track is intentionally NOT touched — that's what back/forward and
// playTrack are for.
export function removeFromUpcoming(tl: Timeline, uri: string, index?: number): Timeline {
  if (index != null) {
    if (index < 0 || index >= tl.upcoming.length) return tl;
    if (tl.upcoming[index] !== uri) return tl; // index/uri mismatch — refuse
    const upcoming = [...tl.upcoming.slice(0, index), ...tl.upcoming.slice(index + 1)];
    return { ...tl, upcoming };
  }
  const i = tl.upcoming.indexOf(uri);
  if (i === -1) return tl;
  const upcoming = [...tl.upcoming.slice(0, i), ...tl.upcoming.slice(i + 1)];
  return { ...tl, upcoming };
}

// Move an item within upcoming. fromIndex/toIndex are pre-move positions —
// the standard drag-and-drop convention.
export function reorderUpcoming(tl: Timeline, fromIndex: number, toIndex: number): Timeline {
  const len = tl.upcoming.length;
  if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) return tl;
  if (fromIndex === toIndex) return tl;
  const upcoming = [...tl.upcoming];
  const [moved] = upcoming.splice(fromIndex, 1);
  upcoming.splice(toIndex, 0, moved);
  return { ...tl, upcoming };
}

// Sync the cursor so `current` becomes `uri`. Used by car mode: Spotify drives
// playback through the pushed context and we follow by observing which URI it
// landed on. Three cases:
//   • uri is ahead in upcoming  → advance: skipped tracks fold into history
//   • uri is behind in history  → rewind:  current + skipped tracks fold into upcoming
//   • uri is nowhere            → return unchanged (caller treats as divergence)
// When `uri` appears on BOTH sides (a duplicate straddling the cursor), pick the
// occurrence NEAREST the cursor — a single-step native PREV lands on the last
// history item (distance 0) and must not be mistaken for a forward jump to a
// far-ahead duplicate. Ties favor forward (NEXT is the common case).
export function syncTo(tl: Timeline, uri: string): Timeline {
  if (tl.current === uri) return tl;

  const aheadIdx = tl.upcoming.indexOf(uri); // forward distance == aheadIdx
  const behindIdx = tl.history.lastIndexOf(uri);
  const behindDist = behindIdx === -1 ? -1 : tl.history.length - 1 - behindIdx;

  const hasAhead = aheadIdx !== -1;
  const hasBehind = behindIdx !== -1;
  if (!hasAhead && !hasBehind) return tl;

  const goForward = hasAhead && (!hasBehind || aheadIdx <= behindDist);
  if (goForward) {
    const moved = tl.upcoming.slice(0, aheadIdx);
    const history = [
      ...tl.history,
      ...(tl.current != null ? [tl.current] : []),
      ...moved,
    ];
    return { history, current: uri, upcoming: tl.upcoming.slice(aheadIdx + 1) };
  }

  const moved = tl.history.slice(behindIdx + 1);
  const upcoming = [
    ...moved,
    ...(tl.current != null ? [tl.current] : []),
    ...tl.upcoming,
  ];
  return { history: tl.history.slice(0, behindIdx), current: uri, upcoming };
}

// Append sampler picks to upcoming, skipping any that are already current or
// already in upcoming. History is NOT used to dedupe — replays are fine
// (cooldowns are enforced by the sampler, not here). This is the only entry
// point the sampler uses to extend the queue.
export function refillTail(tl: Timeline, picks: readonly string[]): Timeline {
  const seen = new Set<string>(tl.upcoming);
  if (tl.current != null) seen.add(tl.current);
  const additions = picks.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return { ...tl, upcoming: [...tl.upcoming, ...additions] };
}
