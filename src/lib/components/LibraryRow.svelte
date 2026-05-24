<script lang="ts">
  import StarRating from './StarRating.svelte';

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
  }: { row: Row; onclick?: (uri: string) => void; isPlaying?: boolean } = $props();

  const artistText = $derived(row.artists.join(', '));
  const labelText = $derived(row.labels.slice(0, 2).join(', '));
  const subline = $derived([artistText, labelText].filter((s) => s !== '').join(' · '));
</script>

<button
  type="button"
  data-testid="library-row"
  data-uri={row.uri}
  data-playing={isPlaying ? 'true' : 'false'}
  onclick={() => onclick?.(row.uri)}
  class="flex w-full items-center gap-3 text-left"
>
  {#if row.albumArtUrl}
    <img
      src={row.albumArtUrl}
      alt=""
      class="size-11 flex-shrink-0 rounded object-cover"
    />
  {:else}
    <div class="size-11 flex-shrink-0 rounded bg-white/10" aria-hidden="true"></div>
  {/if}

  <div class="min-w-0 flex-1">
    <div class="truncate font-medium {isPlaying ? 'text-spotify-green' : ''}">{row.title ?? 'Unknown track'}</div>
    {#if subline}
      <div class="truncate text-xs opacity-60">{subline}</div>
    {/if}
  </div>

  <div class="flex flex-shrink-0 items-center gap-2">
    {#if isPlaying}
      <span class="text-xs text-spotify-green" aria-label="Now playing">▶</span>
    {/if}
    <StarRating value={row.rating ?? 0} size={14} />
  </div>
</button>
