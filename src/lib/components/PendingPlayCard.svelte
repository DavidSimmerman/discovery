<script lang="ts">
  // Cold-start pending play (the "cover fan hero"): shown on Now Playing when a
  // play was started but Spotify has no available device anywhere. The queue is
  // already armed server-side; the server fires it the moment Spotify opens, so
  // the CTA only needs to get the user into the Spotify app.
  import { Play, Sparkles } from '@lucide/svelte';
  import { openSpotifyApp } from '$lib/spotifyLink';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let { store }: { store: PlaybackStore } = $props();

  type Meta = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
  };
  let meta = $state<Meta[]>([]);

  const uris = $derived(store.pendingPlay?.uris ?? []);
  const total = $derived(uris.length);
  const first = $derived(meta[0] ?? null);

  // Hydrate art/title for the fan from the local tracks table. Un-enriched
  // URIs come back with nulls — the fallbacks below cover that.
  $effect(() => {
    const head = uris.slice(0, 3);
    if (head.length === 0) {
      meta = [];
      return;
    }
    let alive = true;
    void fetch(`/api/tracks?uris=${encodeURIComponent(head.join(','))}`)
      .then((r) => (r.ok ? r.json() : { tracks: [] }))
      .then((j: { tracks?: Meta[] }) => {
        if (alive) meta = j.tracks ?? [];
      })
      .catch(() => {
        /* fan renders placeholders */
      });
    return () => {
      alive = false;
    };
  });
</script>

{#snippet fanCover(m: Meta | undefined, cls: string)}
  {#if m?.albumArtUrl}
    <img src={m.albumArtUrl} alt="" class={cls} />
  {:else}
    <div class="{cls} bg-white/10"></div>
  {/if}
{/snippet}

<div
  class="flex flex-col items-center gap-6"
  data-testid="pending-play-card"
>
  <!-- fanned covers: up-first front and center, next two peeking behind -->
  <div class="relative h-40 w-44">
    {@render fanCover(meta[2], 'absolute left-0 top-6 size-24 -rotate-12 rounded-xl opacity-50 shadow-xl')}
    {@render fanCover(meta[1], 'absolute right-0 top-6 size-24 rotate-12 rounded-xl opacity-50 shadow-xl')}
    {@render fanCover(meta[0], 'absolute left-1/2 top-0 size-32 -translate-x-1/2 rounded-xl shadow-2xl ring-1 ring-white/10')}
    {#if total > 1}
      <div
        class="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full border border-purple-400/40 bg-[#0a0a0c] px-2.5 py-0.5 text-[10px] text-purple-300"
      >
        +{total - 1} more
      </div>
    {/if}
  </div>

  <div class="text-center">
    <p class="text-base font-semibold">{first?.title ?? 'Track'}</p>
    <p class="text-sm text-white/60">{first?.artists?.join(', ') || 'Unknown artist'}</p>
    <p class="mt-2 flex items-center justify-center gap-1.5 text-xs text-white/50">
      <Sparkles class="size-3 text-purple-400" />
      Shuffle queued and ready
    </p>
  </div>

  <button
    type="button"
    data-testid="open-spotify-button"
    onclick={() => openSpotifyApp()}
    class="inline-flex w-full max-w-[260px] items-center justify-center gap-2 rounded-full bg-spotify-green px-5 py-3 text-sm font-semibold text-black transition hover:brightness-110"
  >
    <Play class="size-4 fill-black" />
    Open Spotify &amp; play
  </button>
  <p class="-mt-3 text-[11px] text-white/40">starts automatically when Spotify opens</p>

  <button
    type="button"
    data-testid="pending-cancel"
    onclick={() => void store.cancelPendingPlay()}
    class="text-xs text-white/40 underline-offset-2 hover:underline"
  >
    Cancel
  </button>
</div>
