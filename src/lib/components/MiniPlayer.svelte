<script lang="ts">
  import { goto } from '$app/navigation';
  import { Pause, Play, Star } from '@lucide/svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    currentRoute,
    navVisible = false,
  }: { store: PlaybackStore; currentRoute: string; navVisible?: boolean } = $props();

  const shown = $derived(store.isActive && currentRoute !== '/now-playing');
  // Sit above the bottom nav (h-12 + bottom-4 + gap) when it's visible.
  const bottomClass = $derived(
    navVisible
      ? 'bottom-[calc(5rem+env(safe-area-inset-bottom))]'
      : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]',
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
    class="fixed inset-x-3 z-40 flex cursor-pointer items-center gap-3 rounded-2xl border border-white/15 bg-white/[0.08] px-3 py-2.5 text-left shadow-2xl shadow-black/60 backdrop-blur-xl transition-[bottom] {bottomClass}"
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
