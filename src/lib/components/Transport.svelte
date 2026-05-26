<script lang="ts">
  import { Pause, Play, SkipBack, SkipForward } from '@lucide/svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';
  let { store }: { store: PlaybackStore } = $props();
</script>

<div class="flex items-center gap-6">
  <button
    aria-label="Previous track"
    class="text-white/80 transition-colors hover:text-white"
    onclick={() => store.prev()}
  >
    <SkipBack class="size-6 fill-current" />
  </button>

  <button
    aria-label={store.state.paused ? 'Play' : 'Pause'}
    class="flex size-14 items-center justify-center rounded-full bg-white text-black shadow-2xl shadow-black/40 transition-transform hover:scale-105"
    onclick={() => store.togglePlay()}
  >
    {#if store.state.paused}
      <Play class="size-6 fill-current" />
    {:else}
      <Pause class="size-6 fill-current" />
    {/if}
  </button>

  <button
    aria-label="Next track"
    class="text-white/80 transition-colors hover:text-white"
    onclick={() => store.next()}
  >
    <SkipForward class="size-6 fill-current" />
  </button>
</div>
