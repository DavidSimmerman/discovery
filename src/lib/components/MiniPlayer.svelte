<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let { store, currentRoute }: { store: PlaybackStore; currentRoute: string } = $props();
  const shown = $derived(store.isActive && currentRoute !== '/now-playing');
</script>

{#if shown && store.state.track}
  <button
    type="button"
    class="fixed inset-x-2 bottom-2 z-40 flex items-center gap-3 rounded-lg border border-spotify-green/40 bg-black/80 px-3 py-2 text-left backdrop-blur"
    onclick={() => goto('/now-playing')}
    aria-label="Open now playing"
  >
    <span class="block h-8 w-8 shrink-0 rounded bg-spotify-green/60"></span>
    <span class="flex min-w-0 flex-col">
      <span class="truncate text-sm font-semibold text-white">{store.state.track.name}</span>
      <span class="truncate text-xs text-white/60">
        {store.state.track.artists.map((a) => a.name).join(', ')}
      </span>
    </span>
    <span
      class="ml-auto text-xl text-spotify-green"
      onclick={(e) => { e.stopPropagation(); store.togglePlay(); }}
      role="button"
      tabindex="0"
      aria-label={store.state.paused ? 'Play' : 'Pause'}
    >{store.state.paused ? '▶' : '⏸'}</span>
  </button>
{/if}
