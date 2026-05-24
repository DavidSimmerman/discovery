<script lang="ts">
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    contextUri,
    trackUri,
    positionMs,
  }: {
    store: PlaybackStore;
    contextUri: string | null;
    trackUri: string;
    positionMs: number;
  } = $props();

  const shown = $derived(!store.isActive && contextUri !== null);
</script>

{#if shown && contextUri}
  <button
    type="button"
    class="rounded-full border border-spotify-green px-4 py-2 text-sm text-spotify-green hover:bg-spotify-green/10"
    onclick={() => store.takeover(contextUri, trackUri, positionMs)}
  >Continue in disccovery</button>
{/if}
