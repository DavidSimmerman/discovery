// "Shuffle them" for unrated Liked Songs: point the shuffle sources at the
// Liked Songs pseudo-playlist in unrated mode and start sampling. This goes
// through the normal settings PUT — the change is visible (and undoable) on
// /shuffle-settings, and applying a preset restores a saved setup.

import { LIKED_SONGS_ID, LIKED_SONGS_NAME } from '$lib/liked';

interface SamplerStarter {
  startSampler(opts?: { reset?: boolean }): Promise<void>;
}

export async function shuffleUnratedLiked(playback: SamplerStarter): Promise<boolean> {
  const res = await fetch('/api/shuffle/settings');
  if (!res.ok) return false;
  const { settings } = await res.json();

  settings.sources = {
    library: false,
    discovery: false,
    playlists: [{ id: LIKED_SONGS_ID, name: LIKED_SONGS_NAME, mode: 'unrated' }],
  };
  // A leftover global rating filter of 'rated' would empty an unrated-only
  // pool — make the filter agree with the source.
  settings.filters.rating = { ...settings.filters.rating, mode: 'unrated' };

  const put = await fetch('/api/shuffle/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!put.ok) return false;

  await playback.startSampler({ reset: true });
  return true;
}
