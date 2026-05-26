<script lang="ts">
  import { Shuffle } from '@lucide/svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    getUris,
    label = 'Shuffle',
  }: { store: PlaybackStore; getUris: () => Promise<readonly string[]>; label?: string } = $props();

  let loading = $state(false);

  async function onClick() {
    if (loading) return;
    loading = true;
    try {
      const uris = await getUris();
      if (uris.length > 0) await store.shuffle(uris);
    } finally {
      loading = false;
    }
  }
</script>

<button
  type="button"
  class="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-50"
  disabled={loading}
  onclick={onClick}
  data-testid="shuffle-button"
>
  {#if loading}
    <span>Loading…</span>
  {:else}
    <Shuffle class="size-3.5" />
    <span>{label}</span>
  {/if}
</button>
