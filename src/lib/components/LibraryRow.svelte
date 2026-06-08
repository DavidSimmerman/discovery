<script lang="ts">
  import { Star } from '@lucide/svelte';
  import OpenInSpotifyLink from '$lib/components/OpenInSpotifyLink.svelte';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    labels: string[];
  };

  let {
    row,
    onclick,
    isPlaying = false,
    rank = null,
  }: {
    row: Row;
    onclick?: (uri: string) => void;
    isPlaying?: boolean;
    // Spotify listen rank (1 = most listened). When set, a rank number is shown
    // on the left — used by the "Most listened" sort to convey ordering.
    rank?: number | null;
  } = $props();

  const artistText = $derived(row.artists.join(', '));
  const labelText = $derived(row.labels.slice(0, 2).join(', '));
  const subline = $derived([artistText, labelText].filter((s) => s !== '').join(' · '));

  // Whole stars (0–5). Empty when unrated.
  const ratingText = $derived(
    row.rating != null && row.rating > 0 ? row.rating.toString() : null,
  );
</script>

<div
  role="button"
  tabindex="0"
  aria-label={row.title ?? 'Unknown track'}
  data-testid="library-row"
  data-uri={row.uri}
  data-playing={isPlaying ? 'true' : 'false'}
  onclick={() => onclick?.(row.uri)}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick?.(row.uri); } }}
  class="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-white/[0.04] p-2 text-left transition-colors hover:bg-white/[0.08]"
>
  {#if rank != null}
    <div class="w-6 flex-shrink-0 text-center text-sm font-semibold tabular-nums text-white/40">
      {rank}
    </div>
  {/if}

  {#if row.albumArtUrl}
    <img
      src={row.albumArtUrl}
      alt=""
      class="size-12 flex-shrink-0 rounded-lg object-cover shadow-lg shadow-black/40"
    />
  {:else}
    <div class="size-12 flex-shrink-0 rounded-lg bg-white/10 shadow-lg shadow-black/40" aria-hidden="true"></div>
  {/if}

  <div class="min-w-0 flex-1">
    <div class="truncate text-sm font-semibold {isPlaying ? 'text-spotify-green' : ''}">{row.title ?? 'Unknown track'}</div>
    {#if subline}
      <div class="truncate text-xs text-white/50">{subline}</div>
    {/if}
  </div>

  <div class="flex flex-shrink-0 items-center gap-1.5">
    {#if isPlaying}
      <span class="text-xs text-spotify-green" aria-label="Now playing">▶</span>
    {/if}
    {#if ratingText}
      <span class="flex items-center gap-0.5 text-spotify-green">
        <Star class="size-3.5 fill-current" />
        <span class="text-sm font-bold tabular-nums">{ratingText}</span>
      </span>
    {/if}
    <OpenInSpotifyLink uri={row.uri} />
  </div>
</div>
