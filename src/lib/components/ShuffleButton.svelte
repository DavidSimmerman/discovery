<script lang="ts">
  import { Shuffle, Sparkles } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    getUris,
    label = 'Shuffle',
  }: { store: PlaybackStore; getUris: () => Promise<readonly string[]>; label?: string } = $props();

  let loading = $state(false);
  // Dev/smoke-test toggle: localStorage.setItem('discovery.sampler', '1') in the browser
  // console flips this button from the dumb fisher-yates path to one /api/shuffle/next pick
  // per click. Auto-advance through the sampler comes in a later slice.
  let useSampler = $state(false);
  onMount(() => {
    try {
      useSampler = localStorage.getItem('discovery.sampler') === '1';
    } catch {
      // localStorage can throw in private mode; default off
    }
  });

  async function onClick() {
    if (loading) return;
    loading = true;
    try {
      if (useSampler) {
        // Sampler mode plays one pick and then keeps Spotify's queue topped up,
        // so playback advances automatically without further clicks.
        await store.startSampler();
        return;
      }
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
  class:is-sampler={useSampler}
  disabled={loading}
  onclick={onClick}
  data-testid="shuffle-button"
  data-sampler={useSampler}
  title={useSampler ? 'Sampler engine (dev)' : label}
>
  {#if loading}
    <span>Loading…</span>
  {:else if useSampler}
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
