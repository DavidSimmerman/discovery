import { describe, it, expect } from 'vitest';
import { shouldObserveAdvance, shouldPreQueueNext, shouldDetectNativePrev } from '$lib/playback/player.svelte';

describe('shouldObserveAdvance', () => {
  it('fires when the pre-queued URI is now current (Spotify advanced)', () => {
    expect(shouldObserveAdvance('spotify:track:B', 'spotify:track:B')).toBe(true);
  });

  it('does not fire while the queued URI is still pending', () => {
    expect(shouldObserveAdvance('spotify:track:B', 'spotify:track:A')).toBe(false);
  });

  it('does not fire when nothing has been pre-queued', () => {
    expect(shouldObserveAdvance(null, 'spotify:track:B')).toBe(false);
  });

  it('does not fire when playback has stopped', () => {
    expect(shouldObserveAdvance('spotify:track:B', null)).toBe(false);
  });
});

describe('shouldPreQueueNext', () => {
  // Helper: 5s pre-queue lead by design.
  const justInside = 4_000;
  const wellOutside = 60_000;

  it('fires when remaining is inside the lead window and the player is on the expected track', () => {
    expect(
      shouldPreQueueNext('spotify:track:cur', 'spotify:track:cur', null, justInside),
    ).toBe(true);
  });

  it('does not fire when remaining is well outside the lead window', () => {
    expect(
      shouldPreQueueNext('spotify:track:cur', 'spotify:track:cur', null, wellOutside),
    ).toBe(false);
  });

  it('does not fire when current URI does not match the timeline (user is on something else)', () => {
    expect(
      shouldPreQueueNext('spotify:track:cur', 'spotify:track:other', null, justInside),
    ).toBe(false);
  });

  it('does not fire when we have already pre-queued something', () => {
    expect(
      shouldPreQueueNext('spotify:track:cur', 'spotify:track:cur', 'spotify:track:next', justInside),
    ).toBe(false);
  });

  it('does not fire with no timeline current', () => {
    expect(shouldPreQueueNext(null, 'spotify:track:cur', null, justInside)).toBe(false);
  });

  it('does not fire on remaining <= 0 (avoids firing after the track ended)', () => {
    expect(
      shouldPreQueueNext('spotify:track:cur', 'spotify:track:cur', null, 0),
    ).toBe(false);
  });
});

describe('shouldDetectNativePrev', () => {
  const URI = 'spotify:track:cur';
  const NOW = 1_000_000;
  const IGNORE_PAST = 0; // seek-ignore window has elapsed
  const IGNORE_FUTURE = NOW + 5_000; // seek-ignore still active

  it('fires when position drops from inside the 10s window to ~0 on the same URI', () => {
    expect(shouldDetectNativePrev(URI, URI, 0, 4_000, NOW, IGNORE_PAST)).toBe(true);
  });

  it('does not fire when the prior position was past the 10s threshold (scrub-to-start)', () => {
    expect(shouldDetectNativePrev(URI, URI, 0, 180_000, NOW, IGNORE_PAST)).toBe(false);
  });

  it('does not fire when the URI changed (natural advance or different track)', () => {
    expect(shouldDetectNativePrev('spotify:track:other', URI, 0, 4_000, NOW, IGNORE_PAST)).toBe(false);
  });

  it('does not fire when nothing is playing (currentUri null)', () => {
    expect(shouldDetectNativePrev(null, URI, 0, 4_000, NOW, IGNORE_PAST)).toBe(false);
  });

  it('does not fire when the seek-ignore window is still active', () => {
    expect(shouldDetectNativePrev(URI, URI, 0, 4_000, NOW, IGNORE_FUTURE)).toBe(false);
  });

  it('does not fire when prior position was already near zero (fresh track start)', () => {
    expect(shouldDetectNativePrev(URI, URI, 0, 100, NOW, IGNORE_PAST)).toBe(false);
  });

  it('does not fire when current position is still well past zero', () => {
    expect(shouldDetectNativePrev(URI, URI, 3_000, 4_000, NOW, IGNORE_PAST)).toBe(false);
  });
});
