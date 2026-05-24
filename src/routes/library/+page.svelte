<script lang="ts">
  import { onMount } from 'svelte';
  import LibraryRow from '$lib/components/LibraryRow.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import ShuffleButton from '$lib/components/ShuffleButton.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';
  import { page } from '$app/state';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    labels: string[];
  };

  type Facets = {
    total: number;
    topLabels: { name: string; count: number }[];
  };

  let rows = $state<Row[]>([]);
  let facets = $state<Facets>({ total: 0, topLabels: [] });
  let loading = $state(true);
  let error = $state<string | null>(null);

  let search = $state('');
  let minRating = $state<number | null>(null);
  let activeLabel = $state<string | null>(null);

  // First-load spinner only — don't flash a spinner on subsequent filter fetches.
  let hasLoaded = $state(false);

  const hasFilters = $derived(
    search.trim() !== '' || minRating !== null || activeLabel !== null,
  );

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  function onRowClick(uri: string) {
    const all = rows.map((r) => r.uri);
    void playback.playTrack(uri, all);
  }

  async function getCurrentFilterUris(): Promise<readonly string[]> {
    const qs = new URLSearchParams(page.url.searchParams);
    qs.set('limit', '500');
    const res = await fetch(`/api/library?${qs.toString()}`);
    if (!res.ok) return rows.map((r) => r.uri);
    const j = (await res.json()) as { rows: { uri: string }[] };
    return j.rows.map((r) => r.uri);
  }

  async function load() {
    loading = true;
    const params = new URLSearchParams();
    const trimmed = search.trim();
    if (trimmed !== '') params.set('search', trimmed);
    if (minRating !== null) params.set('minRating', String(minRating));
    if (activeLabel !== null) params.set('label', activeLabel);

    try {
      const qs = params.toString();
      const res = await fetch(`/api/library${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        error = "Couldn't load your library. Try again.";
        return;
      }
      const data = await res.json();
      rows = data.rows ?? [];
      facets = data.facets ?? { total: 0, topLabels: [] };
      error = null;
    } catch {
      // Keep existing rows on a transient failure.
      error = "Couldn't load your library. Check your connection.";
    } finally {
      loading = false;
      hasLoaded = true;
    }
  }

  function onSearchInput() {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void load();
    }, 250);
  }

  function toggleRating(value: number) {
    minRating = minRating === value ? null : value;
    void load();
  }

  function toggleLabel(name: string) {
    activeLabel = activeLabel === name ? null : name;
    void load();
  }

  onMount(() => {
    void load();
    return () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
    };
  });
</script>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 p-4">
  <header class="flex items-baseline justify-between gap-3">
    <h1 class="text-2xl font-bold">
      Library <span class="text-base font-normal opacity-50">{facets.total}</span>
    </h1>
    <a href="/now-playing" class="text-sm text-spotify-green hover:underline">Now playing</a>
  </header>

  <input
    type="text"
    bind:value={search}
    oninput={onSearchInput}
    maxlength="100"
    aria-label="Search your library"
    placeholder="Search…"
    class="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-spotify-green focus:outline-none"
  />

  <div class="flex items-center gap-2">
    <div class="-mx-1 flex flex-1 gap-2 overflow-x-auto px-1 pb-1">
      <button
        type="button"
        aria-pressed={minRating === 10}
        onclick={() => toggleRating(10)}
        class="flex-shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm transition-colors {minRating ===
        10
          ? 'bg-spotify-green text-black'
          : 'bg-white/10 text-white/70 hover:bg-white/20'}"
      >
        ★★★★★
      </button>
      <button
        type="button"
        aria-pressed={minRating === 8}
        onclick={() => toggleRating(8)}
        class="flex-shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm transition-colors {minRating ===
        8
          ? 'bg-spotify-green text-black'
          : 'bg-white/10 text-white/70 hover:bg-white/20'}"
      >
        ★★★★+
      </button>

      {#each facets.topLabels as label (label.name)}
        <button
          type="button"
          aria-pressed={activeLabel === label.name}
          onclick={() => toggleLabel(label.name)}
          class="flex-shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm transition-colors {activeLabel ===
          label.name
            ? 'bg-spotify-green text-black'
            : 'bg-white/10 text-white/70 hover:bg-white/20'}"
        >
          {label.name}
        </button>
      {/each}
    </div>
    <PremiumGate {product}><ShuffleButton store={playback} getUris={getCurrentFilterUris} label="Shuffle" /></PremiumGate>
  </div>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>

  {#if loading && !hasLoaded}
    <div class="flex flex-col gap-3">
      {#each [0, 1, 2, 3, 4] as i (i)}
        <div class="flex items-center gap-3">
          <div class="size-11 flex-shrink-0 animate-pulse rounded bg-white/10"></div>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="h-3.5 w-2/3 animate-pulse rounded bg-white/10"></div>
            <div class="h-2.5 w-1/2 animate-pulse rounded bg-white/10"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if rows.length === 0}
    <p class="py-8 text-center text-sm opacity-60">
      {#if hasFilters}
        No tracks match your filters.
      {:else}
        No rated or labeled tracks yet — go rate something on now-playing.
      {/if}
    </p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each rows as row (row.uri)}
        <LibraryRow {row} onclick={onRowClick} isPlaying={playback.state.track?.uri === row.uri} />
      {/each}
    </div>
  {/if}
</main>
