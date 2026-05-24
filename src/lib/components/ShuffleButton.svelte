<script lang="ts">
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
  class="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
  disabled={loading}
  onclick={onClick}
  data-testid="shuffle-button"
>
  {loading ? 'Loading…' : `🔀 ${label}`}
</button>
