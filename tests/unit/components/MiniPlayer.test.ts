import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import MiniPlayer from '$lib/components/MiniPlayer.svelte';

function makeStore(active: boolean) {
  return {
    state: {
      paused: false,
      position_ms: 0,
      duration_ms: 0,
      track: active
        ? { uri: 'spotify:track:1', name: 'T', artists: [{ name: 'A' }], album: { name: '', images: [] } }
        : null,
      context_uri: null,
      isrc: null,
    },
    error: null,
    isReady: true,
    isActive: active,
    init: vi.fn(),
    destroy: vi.fn(),
    playTrack: vi.fn(),
    shuffle: vi.fn(),
    startSampler: vi.fn(),
    isSampling: false,
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
    refresh: vi.fn(),
    setCurrentRating: vi.fn(),
    currentRating: null,
  };
}

describe('<MiniPlayer />', () => {
  it('renders nothing when not active', () => {
    const { container } = render(MiniPlayer, {
      props: { store: makeStore(false), currentRoute: '/library' },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders nothing on /now-playing even when active', () => {
    const { container } = render(MiniPlayer, {
      props: { store: makeStore(true), currentRoute: '/now-playing' },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders track name when active on other routes', () => {
    const { getByText } = render(MiniPlayer, {
      props: { store: makeStore(true), currentRoute: '/library' },
    });
    expect(getByText('T')).toBeTruthy();
  });
});
