<script lang="ts">
  import { goto } from '$app/navigation';
  import { Pause, Play, Star } from '@lucide/svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    currentRoute,
    navVisible = false,
  }: { store: PlaybackStore; currentRoute: string; navVisible?: boolean } = $props();

  // Hidden on /now-playing (redundant there) and /shuffle-settings (that page
  // pins its own full-width Shuffle CTA to the bottom edge — the mini player
  // showed through the CTA's translucent disabled state).
  const shown = $derived(
    store.isActive && currentRoute !== '/now-playing' && currentRoute !== '/shuffle-settings',
  );
  // Track the nav's bottom offset (max(1rem, safe-area) — slight margin, or just
  // above the home indicator). When the nav is visible, sit above it (nav h-12 +
  // gap ≈ 3.75rem). When hidden, share the nav's resting offset.
  const bottomClass = $derived(
    navVisible
      ? 'bottom-[calc(max(1rem,env(safe-area-inset-bottom))+3.75rem)]'
      : 'bottom-[max(1rem,env(safe-area-inset-bottom))]',
  );

  const ratingLabel = $derived(
    store.currentRating != null && store.currentRating > 0
      ? store.currentRating.toString()
      : null,
  );
</script>

{#if shown && store.state.track}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="button"
    tabindex="0"
    class="fixed inset-x-3 z-40 flex transform-gpu cursor-pointer items-center gap-3 rounded-2xl border border-white/15 bg-white/[0.08] px-3 py-2.5 text-left shadow-2xl shadow-black/60 backdrop-blur-xl transition-[bottom] [backface-visibility:hidden] {bottomClass}"
    onclick={() => goto('/now-playing')}
    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && goto('/now-playing')}
    aria-label="Open now playing"
  >
    {#if store.state.track?.album?.images?.[0]?.url}
      <img
        src={store.state.track.album.images[0].url}
        alt=""
        class="block h-9 w-9 shrink-0 rounded-lg object-cover"
      />
    {:else}
      <span class="block h-9 w-9 shrink-0 rounded-lg bg-spotify-green/60"></span>
    {/if}
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="flex items-center gap-1 truncate text-xs font-semibold text-white">
        {#if ratingLabel}
          <span class="inline-flex items-center gap-0.5 text-spotify-green">
            <Star class="size-3 fill-current" />{ratingLabel}
          </span>
        {/if}
        <span class="truncate">{store.state.track.name}</span>
      </span>
      <span class="truncate text-[10px] text-white/60">
        {store.state.track.artists.map((a) => a.name).join(', ')}
      </span>
    </span>
    <button
      type="button"
      class="ml-auto flex size-8 shrink-0 items-center justify-center rounded-full bg-spotify-green text-black shadow shadow-spotify-green/40"
      onclick={(e) => { e.stopPropagation(); store.togglePlay(); }}
      aria-label={store.state.paused ? 'Play' : 'Pause'}
    >
      {#if store.state.paused}
        <Play class="size-3.5 fill-current" />
      {:else}
        <Pause class="size-3.5 fill-current" />
      {/if}
    </button>
  </div>
{/if}
