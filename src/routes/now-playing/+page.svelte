<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import NowPlaying from '$lib/components/NowPlaying.svelte';
  import LabelChips from '$lib/components/LabelChips.svelte';
  import Transport from '$lib/components/Transport.svelte';
  import Scrubber from '$lib/components/Scrubber.svelte';
  import ShuffleButton from '$lib/components/ShuffleButton.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';
  import TabbedPanel from '$lib/components/TabbedPanel.svelte';
  import PendingPlayCard from '$lib/components/PendingPlayCard.svelte';
  import ResumeShuffleOffer from '$lib/components/ResumeShuffleOffer.svelte';
  import LikedAlertCard from '$lib/components/LikedAlertCard.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import { SlidersHorizontal } from '@lucide/svelte';

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');
  // True while the resume CHIP is visible — relabels Shuffle → "New shuffle".
  let resumeOffered = $state(false);

  let error = $state<string | null>(null);
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

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
    const uri = playback.state.track?.uri;
    if (!uri) return;
    const isrc = playback.state.isrc ?? undefined;
    const prev = playback.currentRating;
    playback.setCurrentRating(uri, next === 0 ? null : next);
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
              body: JSON.stringify({ spotifyTrackUri: uri, ratingStars: next, isrc }),
            });
      if (!res.ok) {
        playback.setCurrentRating(uri, prev);
        setError("Couldn't save your rating. Try again.");
        return;
      }
      clearError();
    } catch {
      playback.setCurrentRating(uri, prev);
      setError("Couldn't save your rating. Check your connection.");
    }
  }


  onMount(() => {
    playback.init();
    return () => {
      if (errorTimer !== null) clearTimeout(errorTimer);
    };
  });

  const backdropUrl = $derived(
    playback.state.track?.album.images[0]?.url ?? null,
  );

  // The store is the single source of truth — build the NowPlaying view-model
  // from playback.state so all reactivity flows through the store.
  const playingForView = $derived(
    playback.state.track
      ? {
          uri: playback.state.track.uri,
          name: playback.state.track.name,
          artists: playback.state.track.artists.map((a) => a.name),
          album: playback.state.track.album.name || null,
          albumArtUrl: playback.state.track.album.images[0]?.url ?? null,
          durationMs: playback.state.duration_ms,
          progressMs: playback.state.position_ms,
          isPlaying: !playback.state.paused,
          isrc: playback.state.isrc,
        }
      : null,
  );
</script>

<main class="relative isolate flex min-h-screen flex-col items-center justify-center gap-6 p-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-32">
  {#if backdropUrl}
    <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        class="absolute inset-0 scale-110 bg-cover bg-center opacity-65 blur-3xl"
        style="background-image: url({backdropUrl});"
      ></div>
      <div class="absolute inset-0 bg-black/55"></div>
    </div>
  {/if}

  {#if playingForView}
    <!-- A foreign track is playing while an interrupted shuffle is parked
         server-side — offer to take back over. Dismissible, session-scoped. -->
    <ResumeShuffleOffer store={playback} variant="banner" />
  {/if}

  {#if !playingForView && playback.pendingPlay}
    <PendingPlayCard store={playback} />
  {:else}
    <NowPlaying
      playing={playingForView}
      rating={playback.currentRating}
      loading={!playback.isReady && !playback.isActive}
      onrate={handleRate}
    />
  {/if}

  {#if playingForView}
    <PremiumGate {product}>
      <Scrubber
        positionMs={playback.state.position_ms}
        durationMs={playback.state.duration_ms}
        paused={playback.state.paused}
        onseek={(ms) => playback.seek(ms)}
      />
      <Transport
        paused={playback.state.paused}
        ontoggle={() => playback.togglePlay()}
        onnext={() => playback.next()}
        onprev={() => playback.prev()}
      />
    </PremiumGate>
    <LabelChips trackUri={playingForView.uri} />

    <div class="w-full max-w-md">
      <TabbedPanel
        trackUri={playingForView.uri}
        artistName={playingForView.artists[0] ?? ''}
        {playback}
      />
    </div>
  {/if}

  {#if !playback.pendingPlay}
    <PremiumGate {product}>
      <div class="flex flex-col items-center gap-2.5">
        {#if !playingForView}
          <ResumeShuffleOffer store={playback} variant="chip" bind:offered={resumeOffered} />
        {/if}
        <div class="flex items-center gap-2">
          <ShuffleButton store={playback} sampler label={resumeOffered ? 'New shuffle' : 'Shuffle'} />
          <a
            href="/shuffle-settings"
            aria-label="Shuffle settings"
            data-testid="shuffle-settings-link"
            class="inline-flex items-center gap-1.5 rounded-full border border-purple-400/40 bg-purple-500/15 px-3 py-1.5 text-xs backdrop-blur transition-colors hover:bg-purple-500/25"
          >
            <SlidersHorizontal class="size-3.5" />
          </a>
        </div>
      </div>
    </PremiumGate>
  {/if}

  <div class="w-full max-w-md">
    <LikedAlertCard />
  </div>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
    {#if playback.error === 'no_device'}
      Open Spotify on a phone, desktop, or browser to start playback.
    {/if}
    {#if playback.error === 'premium'}Premium required to control Spotify playback.{/if}
    {#if playback.error === 'transient'}Connection hiccup — try again.{/if}
    {#if playback.error === 'auth'}Session expired — log in again.{/if}
  </div>
</main>
