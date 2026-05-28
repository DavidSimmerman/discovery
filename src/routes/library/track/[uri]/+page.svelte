<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChevronLeft, Play } from '@lucide/svelte';
  import StarRating from '$lib/components/StarRating.svelte';
  import LabelChips from '$lib/components/LabelChips.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';
  import OtherVersions from '$lib/components/OtherVersions.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';

  type Track = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    labels: string[];
  };

  const { data } = $props<{ data: { track: Track } }>();

  let rating = $state<number>(0);
  $effect(() => {
    rating = data.track.rating ?? 0;
  });
  let error = $state<string | null>(null);
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');
  const isPlaying = $derived(playback.state.track?.uri === data.track.uri && !playback.state.paused);

  function setError(msg: string) {
    error = msg;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { error = null; errorTimer = null; }, 4000);
  }

  async function handleRate(next: number) {
    const prev = rating;
    rating = next;
    try {
      const res =
        next === 0
          ? await fetch('/api/ratings', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ spotifyTrackUri: data.track.uri }),
            })
          : await fetch('/api/ratings', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ spotifyTrackUri: data.track.uri, ratingStars: next }),
            });
      if (!res.ok) {
        rating = prev;
        setError("Couldn't save your rating. Try again.");
        return;
      }
      playback.setCurrentRating(data.track.uri, next === 0 ? null : next);
    } catch {
      rating = prev;
      setError("Couldn't save your rating. Check your connection.");
    }
  }

  function playNow() {
    void playback.playTrack(data.track.uri, [data.track.uri]);
  }
</script>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 p-4 pb-32">
  <button
    type="button"
    onclick={() => goto('/library')}
    class="-ml-1 flex w-fit items-center gap-1 text-xs text-white/60 hover:text-white"
    aria-label="Back to library"
  >
    <ChevronLeft class="size-4" />
    Library
  </button>

  <div class="flex flex-col items-center gap-4 text-center">
    {#if data.track.albumArtUrl}
      <img
        src={data.track.albumArtUrl}
        alt=""
        class="aspect-square w-full max-w-xs rounded-2xl object-cover shadow-2xl shadow-black/50"
      />
    {:else}
      <div class="aspect-square w-full max-w-xs rounded-2xl bg-white/10 shadow-2xl shadow-black/50" aria-hidden="true"></div>
    {/if}

    <div class="min-w-0">
      <h1 class="truncate text-2xl font-extrabold">{data.track.title ?? 'Unknown track'}</h1>
      {#if data.track.artists.length > 0}
        <p class="truncate text-sm text-white/60">{data.track.artists.join(', ')}</p>
      {/if}
    </div>

    <StarRating value={rating} size={36} interactive onchange={handleRate} />

    <PremiumGate {product}>
      <button
        type="button"
        onclick={playNow}
        data-testid="track-play-now"
        class="inline-flex items-center gap-2 rounded-full bg-spotify-green px-6 py-2.5 text-sm font-semibold text-black shadow shadow-spotify-green/40 transition-transform hover:scale-[1.02] active:scale-95"
      >
        <Play class="size-4 fill-current" />
        {isPlaying ? 'Playing' : 'Play now'}
      </button>
    </PremiumGate>
  </div>

  <div class="mt-2">
    <LabelChips trackUri={data.track.uri} />
  </div>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>

  <OtherVersions trackUri={data.track.uri} currentUri={data.track.uri} />
</main>
