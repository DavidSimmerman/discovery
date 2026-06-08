<script lang="ts">
  import StarRating from '$lib/components/StarRating.svelte';
  import ArtistLink from '$lib/components/ArtistLink.svelte';
  import { ExternalLink } from '@lucide/svelte';
  import { spotifyTrackUrl } from '$lib/spotifyLink';

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
  };

  type Props = {
    playing: Playing | null;
    rating: number | null;
    loading: boolean;
    onrate: (next: number) => void;
  };

  let { playing, rating, loading, onrate }: Props = $props();

  const spotifyUrl = $derived(spotifyTrackUrl(playing?.uri));
</script>

{#if loading && !playing}
  <div class="flex flex-col items-center gap-6">
    <div class="aspect-square w-64 max-w-full animate-pulse rounded-2xl bg-white/10"></div>
    <div class="h-6 w-48 animate-pulse rounded bg-white/10"></div>
    <div class="h-4 w-32 animate-pulse rounded bg-white/5"></div>
  </div>
{:else if !playing}
  <div class="flex flex-col items-center gap-3 text-center">
    <p class="text-lg font-semibold">Nothing playing in Spotify right now</p>
    <p class="max-w-xs text-sm opacity-50">
      Open Spotify and press play — it'll show up here.
    </p>
  </div>
{:else}
  <div class="flex flex-col items-center gap-6 text-center" data-track-uri={playing?.uri ?? ''}>
    {#if playing.albumArtUrl}
      <img
        src={playing.albumArtUrl}
        alt={playing.album ? `${playing.album} album art` : 'Album art'}
        class="aspect-square w-64 max-w-full rounded-2xl object-cover shadow-2xl shadow-black/80"
      />
    {:else}
      <div class="flex aspect-square w-64 max-w-full items-center justify-center rounded-2xl bg-white/10 text-sm opacity-40 shadow-2xl shadow-black/80">
        No artwork
      </div>
    {/if}

    <div class="flex w-full max-w-xs flex-col items-center gap-1">
      <h2 class="text-2xl font-extrabold leading-tight text-balance break-words">{playing.name}</h2>
      <ArtistLink artists={playing.artists} class="text-sm text-white/70 text-balance break-words" />
      {#if spotifyUrl}
        <a
          href={spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1 text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-spotify-green"
        >
          <ExternalLink class="size-3.5" />
          Open in Spotify
        </a>
      {/if}
    </div>

    <StarRating interactive value={rating ?? 0} size={42} onchange={onrate} />
  </div>
{/if}
