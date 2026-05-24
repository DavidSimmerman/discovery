<script lang="ts">
  import type { PlaybackStore } from '$lib/playback/player.svelte';
  let { store }: { store: PlaybackStore } = $props();
</script>

<div class="flex items-center gap-4">
  <button
    aria-label="Previous track"
    class="text-2xl text-white/80 hover:text-white"
    onclick={() => store.prev()}
  >⏮</button>

  <button
    aria-label={store.state.paused ? 'Play' : 'Pause'}
    class="rounded-full bg-spotify-green px-4 py-2 text-2xl text-black hover:opacity-90"
    onclick={() => store.togglePlay()}
  >{store.state.paused ? '▶' : '⏸'}</button>

  <button
    aria-label="Next track"
    class="text-2xl text-white/80 hover:text-white"
    onclick={() => store.next()}
  >⏭</button>
</div>
