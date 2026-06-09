<script lang="ts">
  import StarRating from '$lib/components/StarRating.svelte';
  import OpenInSpotifyLink from '$lib/components/OpenInSpotifyLink.svelte';
  import { formatRelativeTime, formatPlays } from '$lib/format';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    playedAt: string;
    playCount: number;
    source: 'spotify' | 'discovery' | 'both';
  };

  let {
    row,
    onrate,
    onopen,
    now = Date.now(),
  }: {
    row: Row;
    // Inline rating change. stars 1–5 sets a rating; 0 clears it.
    onrate: (uri: string, stars: number) => void;
    onopen?: (uri: string) => void;
    now?: number;
  } = $props();

  const artistText = $derived(row.artists.join(', '));
  const relTime = $derived(formatRelativeTime(row.playedAt, now));
  // "played 3×" only when it was heard more than once in the window.
  const playsText = $derived(row.playCount > 1 ? `played ${formatPlays(row.playCount)}×` : null);
</script>

<div
  data-testid="history-row"
  data-uri={row.uri}
  data-rating={row.rating ?? 0}
  class="flex w-full items-center gap-3 rounded-xl bg-white/[0.04] p-2 transition-colors"
>
  <!-- Tapping art/title opens the track detail; the stars area rates inline. -->
  <button
    type="button"
    aria-label={row.title ?? 'Unknown track'}
    onclick={() => onopen?.(row.uri)}
    class="flex min-w-0 flex-1 items-center gap-3 text-left"
  >
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
      <div class="truncate text-sm font-semibold">{row.title ?? 'Unknown track'}</div>
      {#if artistText}
        <div class="truncate text-xs text-white/50">{artistText}</div>
      {/if}
      <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/35">
        {#if row.source === 'spotify' || row.source === 'both'}
          <!-- Played on Spotify (possibly outside disccovery). -->
          <span class="inline-block size-1.5 flex-shrink-0 rounded-full bg-spotify-green" aria-hidden="true"></span>
        {/if}
        <span class="truncate">{relTime}{#if playsText} · {playsText}{/if}</span>
      </div>
    </div>
  </button>

  <div class="flex flex-shrink-0 flex-col items-end gap-1">
    <OpenInSpotifyLink uri={row.uri} />
    <StarRating
      value={row.rating ?? 0}
      size={18}
      interactive
      onchange={(next) => onrate(row.uri, next)}
    />
  </div>
</div>
