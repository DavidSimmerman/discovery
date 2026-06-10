<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Heart, Shuffle } from '@lucide/svelte';
  import StarRating from '$lib/components/StarRating.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import { likedUnrated } from '$lib/liked/badge.svelte';
  import { shuffleUnratedLiked } from '$lib/liked/shuffle';

  const playback = getPlaybackStore();

  type Row = {
    uri: string;
    name: string;
    artists: string[];
    albumArtUrl: string | null;
    durationMs: number | null;
    isrc: string | null;
    // Local-only: set once the user rates the row (row stays visible so a
    // mis-tap can be corrected; it drops off on the next visit).
    rating: number;
  };

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rateError = $state<string | null>(null);
  let starting = $state(false);

  const remaining = $derived(rows.filter((r) => r.rating === 0).length);

  onMount(async () => {
    try {
      const res = await fetch('/api/liked/unrated');
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      rows = (json.tracks as Omit<Row, 'rating'>[]).map((t) => ({ ...t, rating: 0 }));
      total = json.total;
      likedUnrated.set(json.unrated, json.total);
    } catch {
      loadError = "Couldn't load your liked songs.";
    } finally {
      loading = false;
    }
  });

  async function rate(row: Row, stars: number) {
    if (stars < 1 || stars > 5) return;
    const prev = row.rating;
    rows = rows.map((r) => (r.uri === row.uri ? { ...r, rating: stars } : r));
    if (prev === 0) likedUnrated.decrement();
    rateError = null;
    try {
      const res = await fetch('/api/ratings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spotifyTrackUri: row.uri,
          ratingStars: stars,
          ...(row.isrc ? { isrc: row.isrc } : {}),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      rows = rows.map((r) => (r.uri === row.uri ? { ...r, rating: prev } : r));
      if (prev === 0) likedUnrated.increment();
      rateError = "Couldn't save that rating. Try again.";
    }
  }

  async function shuffleThem() {
    if (starting || remaining === 0) return;
    starting = true;
    try {
      if (await shuffleUnratedLiked(playback)) await goto('/now-playing');
    } finally {
      starting = false;
    }
  }

  function goBack() {
    if (history.length > 1) history.back();
    else void goto('/now-playing');
  }

  function fmtDuration(ms: number | null): string | null {
    if (ms == null) return null;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
</script>

<svelte:head><title>Unrated Liked Songs — disccovery</title></svelte:head>

<main class="mx-auto min-h-screen w-full max-w-md px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-32">
  <header class="mb-4 flex items-center gap-3">
    <button
      type="button"
      aria-label="Back"
      onclick={goBack}
      class="grid size-9 place-items-center rounded-full bg-white/[0.06]"
    >
      <ArrowLeft class="size-4" />
    </button>
    <div class="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-300">
      <Heart class="size-5 fill-white text-white" />
    </div>
    <div class="min-w-0">
      <h1 class="text-lg font-extrabold">Unrated Liked Songs</h1>
      <p class="text-xs text-white/45">
        {#if loading}
          Loading…
        {:else}
          {remaining} of {total} liked songs {remaining === 1 ? 'has' : 'have'} no rating
        {/if}
      </p>
    </div>
  </header>

  <button
    type="button"
    data-testid="liked-shuffle-cta"
    onclick={shuffleThem}
    disabled={starting || loading || remaining === 0}
    class="mb-4 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-purple-500 to-violet-600 py-2.5 text-sm font-bold disabled:opacity-40"
  >
    <Shuffle class="size-4" />
    {starting ? 'Starting…' : `Shuffle these ${remaining.toLocaleString()}`}
  </button>

  {#if rateError}
    <p class="mb-3 text-center text-xs text-red-400" aria-live="polite">{rateError}</p>
  {/if}

  {#if loadError}
    <p class="p-6 text-center text-sm text-white/40">{loadError}</p>
  {:else if !loading && rows.length === 0}
    <p class="p-6 text-center text-sm text-white/40">
      All caught up — every liked song has a rating. 🎉
    </p>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each rows as row (row.uri)}
        <div
          data-testid="liked-row"
          data-uri={row.uri}
          class="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2"
        >
          {#if row.albumArtUrl}
            <img
              src={row.albumArtUrl}
              alt=""
              class="size-12 flex-shrink-0 rounded-lg object-cover shadow-lg shadow-black/40"
            />
          {:else}
            <div class="size-12 flex-shrink-0 rounded-lg bg-white/10" aria-hidden="true"></div>
          {/if}
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">{row.name}</div>
            <div class="truncate text-xs text-white/45">
              {row.artists.join(', ')}{#if fmtDuration(row.durationMs)}&nbsp;· {fmtDuration(row.durationMs)}{/if}
            </div>
          </div>
          <StarRating
            value={row.rating}
            size={20}
            interactive
            onchange={(n) => void rate(row, n)}
          />
        </div>
      {/each}
    </div>
  {/if}
</main>
