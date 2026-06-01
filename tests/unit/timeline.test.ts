import { describe, it, expect } from 'vitest';
import {
  advance,
  back,
  forward,
  addToUpcoming,
  removeFromUpcoming,
  reorderUpcoming,
  refillTail,
  emptyTimeline,
  type Timeline,
} from '$lib/server/shuffle/timeline';

function t(history: string[], current: string | null, upcoming: string[]): Timeline {
  return { history, current, upcoming };
}

describe('emptyTimeline', () => {
  it('starts empty', () => {
    expect(emptyTimeline()).toEqual({ history: [], current: null, upcoming: [] });
  });
});

describe('advance (natural track end / forward)', () => {
  it('moves current to history and upcoming[0] to current', () => {
    const before = t(['A', 'B', 'C'], 'D', ['E', 'F']);
    expect(advance(before)).toEqual(t(['A', 'B', 'C', 'D'], 'E', ['F']));
  });

  it('returns the same timeline (no-op) when upcoming is empty', () => {
    const before = t(['A'], 'B', []);
    expect(advance(before)).toEqual(before);
  });

  it('handles starting state (no current) by promoting upcoming[0]', () => {
    const before = t([], null, ['A', 'B']);
    expect(advance(before)).toEqual(t([], 'A', ['B']));
  });

  it('forward() behaves identically to advance()', () => {
    const before = t(['A', 'B', 'C'], 'D', ['E', 'F']);
    expect(forward(before)).toEqual(advance(before));
  });
});

describe('back (cursor through history)', () => {
  it('moves current to front of upcoming and history.last to current', () => {
    const before = t(['A', 'B', 'C'], 'D', ['E', 'F']);
    expect(back(before)).toEqual(t(['A', 'B'], 'C', ['D', 'E', 'F']));
  });

  it('returns the same timeline (no-op) when history is empty', () => {
    const before = t([], 'A', ['B', 'C']);
    expect(back(before)).toEqual(before);
  });

  it('handles no current track (queued but not started)', () => {
    const before = t(['A', 'B'], null, ['C']);
    expect(back(before)).toEqual(t(['A'], 'B', ['C']));
  });
});

describe('A–K user scenario from the brief', () => {
  // Sequence is A B C D E F G H I J K; "you are on song F".
  const onF = (): Timeline => t(['A', 'B', 'C', 'D', 'E'], 'F', ['G', 'H', 'I', 'J', 'K']);

  it('back twice from F lands on D', () => {
    const onE = back(onF());
    expect(onE.current).toBe('E');
    const onD = back(onE);
    expect(onD).toEqual(t(['A', 'B', 'C'], 'D', ['E', 'F', 'G', 'H', 'I', 'J', 'K']));
  });

  it('after back×2, forward goes D→E→F→G in order', () => {
    let s = back(back(onF())); // on D
    s = forward(s); expect(s.current).toBe('E');
    s = forward(s); expect(s.current).toBe('F');
    s = forward(s); expect(s.current).toBe('G');
    // and history grew back to include the previously-current items
    expect(s.history).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(s.upcoming).toEqual(['H', 'I', 'J', 'K']);
  });

  it('round-tripping back/forward leaves the timeline identical', () => {
    const original = onF();
    expect(forward(back(original))).toEqual(original);
  });
});

describe('addToUpcoming', () => {
  it('appends to the end of upcoming by default', () => {
    const before = t([], 'A', ['B', 'C']);
    expect(addToUpcoming(before, 'D')).toEqual(t([], 'A', ['B', 'C', 'D']));
  });

  it('inserts at a specific position', () => {
    const before = t([], 'A', ['B', 'C', 'D']);
    expect(addToUpcoming(before, 'X', 1)).toEqual(t([], 'A', ['B', 'X', 'C', 'D']));
  });

  it('insert position past the end is clamped to the end', () => {
    const before = t([], 'A', ['B']);
    expect(addToUpcoming(before, 'X', 99)).toEqual(t([], 'A', ['B', 'X']));
  });

  it('negative position is clamped to 0', () => {
    const before = t([], 'A', ['B']);
    expect(addToUpcoming(before, 'X', -3)).toEqual(t([], 'A', ['X', 'B']));
  });
});

describe('removeFromUpcoming', () => {
  it('removes the first matching URI', () => {
    const before = t([], 'A', ['B', 'C', 'D']);
    expect(removeFromUpcoming(before, 'C')).toEqual(t([], 'A', ['B', 'D']));
  });

  it('is a no-op when the URI is not in upcoming', () => {
    const before = t([], 'A', ['B', 'C']);
    expect(removeFromUpcoming(before, 'Z')).toEqual(before);
  });

  it('does NOT remove the current track', () => {
    const before = t([], 'A', ['B']);
    // Trying to "remove" current should leave it alone — current isn't in upcoming.
    expect(removeFromUpcoming(before, 'A')).toEqual(before);
  });

  it('removeAt removes by index', () => {
    // index-based removal is needed for duplicate URIs in upcoming
    const before = t([], 'A', ['B', 'C', 'B']);
    expect(removeFromUpcoming(before, 'B', 2)).toEqual(t([], 'A', ['B', 'C']));
  });
});

describe('reorderUpcoming', () => {
  it('moves an item to a new index', () => {
    const before = t([], 'A', ['B', 'C', 'D', 'E']);
    expect(reorderUpcoming(before, 0, 2)).toEqual(t([], 'A', ['C', 'D', 'B', 'E']));
  });

  it('moves an item backward', () => {
    const before = t([], 'A', ['B', 'C', 'D', 'E']);
    expect(reorderUpcoming(before, 3, 1)).toEqual(t([], 'A', ['B', 'E', 'C', 'D']));
  });

  it('is a no-op when from == to', () => {
    const before = t([], 'A', ['B', 'C', 'D']);
    expect(reorderUpcoming(before, 1, 1)).toEqual(before);
  });

  it('returns the same timeline for out-of-range indices', () => {
    const before = t([], 'A', ['B', 'C']);
    expect(reorderUpcoming(before, 5, 0)).toEqual(before);
    expect(reorderUpcoming(before, 0, 5)).toEqual(before);
    expect(reorderUpcoming(before, -1, 0)).toEqual(before);
  });
});

describe('refillTail', () => {
  it('appends picks to upcoming', () => {
    const before = t([], 'A', ['B']);
    expect(refillTail(before, ['C', 'D'])).toEqual(t([], 'A', ['B', 'C', 'D']));
  });

  it('skips picks already in upcoming or current to avoid duplicates near the head', () => {
    const before = t([], 'A', ['B', 'C']);
    // 'A' is current, 'B' is queued — the sampler shouldn't double-queue them.
    expect(refillTail(before, ['A', 'B', 'D'])).toEqual(t([], 'A', ['B', 'C', 'D']));
  });

  it('does not dedupe against history (replays are fine after a cooldown)', () => {
    const before = t(['A', 'B'], 'C', []);
    expect(refillTail(before, ['A'])).toEqual(t(['A', 'B'], 'C', ['A']));
  });
});
