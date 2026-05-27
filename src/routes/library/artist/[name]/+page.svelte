<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ChevronLeft, Star } from '@lucide/svelte';
  import LibraryRow from '$lib/components/LibraryRow.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import ShuffleButton from '$lib/components/ShuffleButton.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    labels: string[];
  };

  type Sort = 'rating' | 'name';

  const artistName = $derived(page.params.name ?? '');

  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let hasLoaded = $state(false);
  let error = $state<string | null>(null);
  let sort = $state<Sort>('rating');

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  const stats = $derived.by(() => {
    const rated = rows.filter((r) => r.rating != null && r.rating > 0);
    const total = rated.length;
    if (total === 0) return { total: 0, avg: 0, fiveStars: 0 };
    const sum = rated.reduce((a, r) => a + (r.rating ?? 0), 0);
    const fiveStars = rated.filter((r) => r.rating === 5).length;
    return { total, avg: sum / total, fiveStars };
  });

  let inflight: AbortController | null = null;

  async function load() {
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    loading = true;
    const params = new URLSearchParams();
    params.set('artist', artistName);
    params.set('sort', sort === 'rating' ? 'rating' : 'name');
    try {
      const res = await fetch(`/api/library?${params.toString()}`, { signal: ac.signal });
      if (!res.ok) {
        error = "Couldn't load this artist's tracks.";
        return;
      }
      const data = await res.json();
      rows = data.rows ?? [];
      error = null;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      error = "Couldn't load. Check your connection.";
    } finally {
      if (inflight === ac) {
        loading = false;
        hasLoaded = true;
        inflight = null;
      }
    }
  }

  function onRowClick(uri: string) {
    const all = rows.map((r) => r.uri);
    void playback.playTrack(uri, all);
  }

  async function getCurrentFilterUris(): Promise<readonly string[]> {
    return rows.map((r) => r.uri);
  }

  function setSort(next: Sort) {
    if (sort === next) return;
    sort = next;
    void load();
  }

  onMount(() => {
    void load();
  });
</script>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 p-4 pb-32">
  <button
    type="button"
    onclick={() => goto('/library?view=artists')}
    class="-ml-1 flex w-fit items-center gap-1 text-xs text-white/60 hover:text-white"
    aria-label="Back to artists"
  >
    <ChevronLeft class="size-4" />
    Artists
  </button>

  <header class="flex items-center gap-3">
    <div class="grid size-20 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-2xl font-bold uppercase text-white/80 shadow-lg shadow-black/40">
      {artistName.charAt(0)}
    </div>
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-xl font-extrabold">{artistName}</h1>
      <p class="text-xs text-white/50">{stats.total} {stats.total === 1 ? 'song' : 'songs'} rated</p>
      {#if stats.total > 0}
        <div class="mt-1 flex items-center gap-2 text-xs">
          <span class="flex items-center gap-0.5 font-semibold text-spotify-green">
            <Star class="size-3 fill-current" />
            {stats.avg.toFixed(1)} avg
          </span>
          {#if stats.fiveStars > 0}
            <span class="text-white/40">· {stats.fiveStars} five-star</span>
          {/if}
        </div>
      {/if}
    </div>
    <PremiumGate {product}>
      <ShuffleButton store={playback} getUris={getCurrentFilterUris} label="Shuffle" />
    </PremiumGate>
  </header>

  <div class="flex gap-2 rounded-full border border-white/10 bg-white/[0.05] p-1 text-[11px]">
    <button
      type="button"
      data-testid="artist-sort-rating"
      aria-pressed={sort === 'rating'}
      onclick={() => setSort('rating')}
      class="flex-1 rounded-full py-1.5 transition-colors {sort === 'rating' ? 'bg-white/15 font-medium text-white' : 'text-white/60 hover:text-white'}"
    >
      Rating
    </button>
    <button
      type="button"
      data-testid="artist-sort-name"
      aria-pressed={sort === 'name'}
      onclick={() => setSort('name')}
      class="flex-1 rounded-full py-1.5 transition-colors {sort === 'name' ? 'bg-white/15 font-medium text-white' : 'text-white/60 hover:text-white'}"
    >
      Alphabetical
    </button>
  </div>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>

  {#if loading && !hasLoaded}
    <div class="flex flex-col gap-2">
      {#each [0, 1, 2, 3, 4] as i (i)}
        <div class="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2">
          <div class="size-12 flex-shrink-0 animate-pulse rounded-lg bg-white/10"></div>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="h-3.5 w-2/3 animate-pulse rounded bg-white/10"></div>
            <div class="h-2.5 w-1/2 animate-pulse rounded bg-white/10"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if rows.length === 0}
    <p class="py-8 text-center text-sm opacity-60">No tracks from this artist in your library.</p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each rows as row (row.uri)}
        <LibraryRow {row} onclick={onRowClick} isPlaying={playback.state.track?.uri === row.uri} />
      {/each}
    </div>
  {/if}
</main>
