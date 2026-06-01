import { describe, it, expect } from 'vitest';
import { shouldQueueNextPick } from '$lib/playback/player.svelte';

describe('shouldQueueNextPick', () => {
  it('queues the next pick when the queued track became current', () => {
    expect(shouldQueueNextPick(true, 'spotify:track:b', 'spotify:track:b')).toBe(true);
  });

  it('does not queue while the queued track is still pending', () => {
    // Still playing track A; B is queued but not yet current.
    expect(shouldQueueNextPick(true, 'spotify:track:b', 'spotify:track:a')).toBe(false);
  });

  it('does not queue when not sampling', () => {
    expect(shouldQueueNextPick(false, 'spotify:track:b', 'spotify:track:b')).toBe(false);
  });

  it('does not queue when nothing is queued', () => {
    expect(shouldQueueNextPick(true, null, 'spotify:track:b')).toBe(false);
  });

  it('does not queue when playback has stopped (no current track)', () => {
    expect(shouldQueueNextPick(true, 'spotify:track:b', null)).toBe(false);
  });
});
