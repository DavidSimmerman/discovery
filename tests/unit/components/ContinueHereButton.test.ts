import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ContinueHereButton from '$lib/components/ContinueHereButton.svelte';
import type { PlaybackStore } from '$lib/playback/player.svelte';

function makeStore(active: boolean, takeover = vi.fn()) {
  return {
    isActive: active,
    takeover,
  } as unknown as PlaybackStore;
}

describe('<ContinueHereButton />', () => {
  it('renders nothing when no Spotify-elsewhere context', () => {
    const { container } = render(ContinueHereButton, {
      props: { store: makeStore(false), contextUri: null, trackUri: 'x', positionMs: 0 },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders nothing when disccovery is already the source', () => {
    const { container } = render(ContinueHereButton, {
      props: {
        store: makeStore(true),
        contextUri: 'spotify:playlist:p',
        trackUri: 'spotify:track:t',
        positionMs: 123,
      },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders + calls takeover with args when clicked', async () => {
    const takeover = vi.fn();
    const { getByRole } = render(ContinueHereButton, {
      props: {
        store: makeStore(false, takeover),
        contextUri: 'spotify:playlist:p',
        trackUri: 'spotify:track:t',
        positionMs: 123,
      },
    });
    await fireEvent.click(getByRole('button'));
    expect(takeover).toHaveBeenCalledWith('spotify:playlist:p', 'spotify:track:t', 123);
  });
});
