<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import NowPlaying from '$lib/components/NowPlaying.svelte';
  import LabelChips from '$lib/components/LabelChips.svelte';
  import Transport from '$lib/components/Transport.svelte';
  import ContinueHereButton from '$lib/components/ContinueHereButton.svelte';
  import ShuffleButton from '$lib/components/ShuffleButton.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';

  type Playing = {
    uri: string;
    name: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    durationMs: number;
    progressMs: number | null;
    isPlaying: boolean;
    isrc: string | null;
    contextUri?: string | null;
  };

  const POLL_MS = 5000;
  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  let loading = $state(true);
  let playing = $state<Playing | null>(null);
  let rating = $state<number | null>(null);
  let error = $state<string | null>(null);

  let interval: ReturnType<typeof setInterval> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  async function poll() {
    if (playback.isActive) return; // SDK is the source of truth
    try {
      const res = await fetch('/api/spotify/currently-playing');
      if (!res.ok) { loading = false; return; }
      const data = await res.json();
      if (data.playing == null) {
        playing = null;
        rating = null;
      } else {
        playing = data.playing;
        rating = data.rating ?? null;
      }
    } catch { /* keep last good */ }
    finally { loading = false; }
  }

  function startPolling() {
    if (interval !== null) return;
    interval = setInterval(poll, POLL_MS);
  }
  function stopPolling() {
    if (interval !== null) { clearInterval(interval); interval = null; }
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') stopPolling();
    else { poll(); startPolling(); }
  }

  function setError(msg: string) {
    error = msg;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { error = null; errorTimer = null; }, 4000);
  }
  function clearError() {
    error = null;
    if (errorTimer !== null) { clearTimeout(errorTimer); errorTimer = null; }
  }

  async function handleRate(next: number) {
    // Resolve the URI from whichever source is authoritative.
    const uri = playback.isActive ? playback.state.track?.uri : playing?.uri;
    const isrc = playing?.isrc ?? undefined;
    if (!uri) return;
    const prev = rating;
    rating = next;
    try {
      const res =
        next === 0
          ? await fetch('/api/ratings', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ spotifyTrackUri: uri }),
            })
          : await fetch('/api/ratings', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ spotifyTrackUri: uri, ratingHalfSteps: next, isrc }),
            });
      if (!res.ok) {
        rating = prev;
        setError("Couldn't save your rating. Try again.");
        return;
      }
      clearError();
      playback.setCurrentRating(uri, next === 0 ? null : next);
    } catch {
      rating = prev;
      setError("Couldn't save your rating. Check your connection.");
    }
  }

  async function shuffleEverything(): Promise<readonly string[]> {
    const res = await fetch('/api/library?limit=500');
    if (!res.ok) return [];
    const j = (await res.json()) as { rows: { spotifyTrackUri: string }[] };
    return j.rows.map((r) => r.spotifyTrackUri);
  }

  onMount(() => {
    poll();
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (errorTimer !== null) clearTimeout(errorTimer);
    };
  });

  // Keep the rating in sync with the SDK's current track when disccovery owns audio.
  $effect(() => {
    if (!playback.isActive || !playback.state.track) return;
    const uri = playback.state.track.uri;
    // Best-effort: fetch the current rating for this URI.
    fetch(`/api/ratings?uri=${encodeURIComponent(uri)}`).then(async (r) => {
      if (!r.ok) return;
      const j = (await r.json()) as { ratingHalfSteps: number | null };
      rating = j.ratingHalfSteps;
      playback.setCurrentRating(uri, j.ratingHalfSteps);
    }).catch(() => {});
  });
</script>

<main class="relative flex min-h-screen flex-col items-center justify-center gap-6 p-6">
  <a
    href="/library"
    class="absolute right-4 top-4 text-sm text-spotify-green hover:underline"
  >
    Library
  </a>

  {#if playback.isActive && playback.state.track}
    <!-- disccovery is the audio source: show SDK state + transport. -->
    <NowPlaying
      playing={{
        uri: playback.state.track.uri,
        name: playback.state.track.name,
        artists: playback.state.track.artists.map((a) => a.name),
        album: playback.state.track.album.name,
        albumArtUrl: playback.state.track.album.images[0]?.url ?? null,
        durationMs: playback.state.duration_ms,
        progressMs: playback.state.position_ms,
        isPlaying: !playback.state.paused,
        isrc: null,
      }}
      {rating}
      loading={false}
      onrate={handleRate}
    />
    <PremiumGate {product}>
      <Transport store={playback} />
    </PremiumGate>
    <LabelChips trackUri={playback.state.track.uri} />
  {:else}
    <!-- Spotify-elsewhere or nothing playing. -->
    <NowPlaying {playing} {rating} {loading} onrate={handleRate} />

    {#if playing}
      <PremiumGate {product}>
        <ContinueHereButton
          store={playback}
          contextUri={playing.contextUri ?? null}
          trackUri={playing.uri}
          positionMs={playing.progressMs ?? 0}
        />
      </PremiumGate>
      <LabelChips trackUri={playing.uri} />
    {/if}
  {/if}

  <PremiumGate {product}>
    <ShuffleButton
      store={playback}
      getUris={shuffleEverything}
      label="Shuffle my library"
    />
  </PremiumGate>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
    {#if playback.error === 'premium'}Premium required to play in disccovery.{/if}
    {#if playback.error === 'unsupported'}Playback unavailable in this browser.{/if}
    {#if playback.error === 'transient'}Playback hiccup — try again.{/if}
  </div>
</main>
