<script lang="ts">
  import { Shuffle, Sparkles } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    getUris,
    label = 'Shuffle',
    sampler = false,
  }: {
    store: PlaybackStore;
    // Required for plain (scoped) shuffle; unused when sampler=true.
    getUris?: () => Promise<readonly string[]>;
    label?: string;
    // true → car-mode smart shuffle over the user's whole rated library.
    // false → plain Fisher-Yates of the scoped URI set from getUris (a filtered
    // library view or a single artist's tracks).
    sampler?: boolean;
  } = $props();

  let loading = $state(false);

  async function onClick() {
    if (loading) return;
    loading = true;
    try {
      if (sampler) {
        // Smart shuffle: hand Spotify a real context built from the sampler and
        // keep following it. reset:true so each press is a fresh queue.
        await store.startSampler({ reset: true });
      } else {
        const uris = (await getUris?.()) ?? [];
        if (uris.length > 0) await store.shuffle(uris);
      }
      // No device anywhere → the play went pending (server fires it when
      // Spotify opens). The pending card lives on Now Playing; take the user
      // there so the action has a visible result.
      if (store.pendingPlay && page.url.pathname !== '/now-playing') {
        await goto('/now-playing');
      }
    } finally {
      loading = false;
    }
  }
</script>

<button
  type="button"
  class="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-50"
  class:is-sampler={sampler}
  disabled={loading}
  onclick={onClick}
  data-testid="shuffle-button"
  data-sampler={sampler}
  title={sampler ? 'Smart shuffle your library' : label}
>
  {#if loading}
    <span>Loading…</span>
  {:else if sampler}
    <Sparkles class="size-3.5" />
    <span>{label}</span>
  {:else}
    <Shuffle class="size-3.5" />
    <span>{label}</span>
  {/if}
</button>

<style>
  .is-sampler {
    border-color: rgb(168 85 247 / 0.4);
    background: rgb(168 85 247 / 0.15);
  }
</style>
