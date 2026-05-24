import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Transport from '$lib/components/Transport.svelte';

function makeStore() {
  return {
    state: { paused: true, position_ms: 0, duration_ms: 100_000, track: null, context_uri: null },
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
  };
}

describe('<Transport />', () => {
  it('renders Play icon when paused, calls togglePlay on click', async () => {
    const store = makeStore();
    const { getByLabelText } = render(Transport, { props: { store: store as unknown as import('$lib/playback/player.svelte').PlaybackStore } });
    const btn = getByLabelText(/play/i);
    await fireEvent.click(btn);
    expect(store.togglePlay).toHaveBeenCalled();
  });
  it('next/prev buttons call store methods', async () => {
    const store = makeStore();
    const { getByLabelText } = render(Transport, { props: { store: store as unknown as import('$lib/playback/player.svelte').PlaybackStore } });
    await fireEvent.click(getByLabelText(/next/i));
    await fireEvent.click(getByLabelText(/previous/i));
    expect(store.next).toHaveBeenCalled();
    expect(store.prev).toHaveBeenCalled();
  });
});
