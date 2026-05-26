<script lang="ts">
  import { onMount } from 'svelte';
  import { Search, Star } from '@lucide/svelte';
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

  type Tab = 'all' | 'rated' | 'labeled';

  let rows = $state<Row[]>([]);
  let facets = $state<Facets>({ total: 0, topLabels: [] });
  let loading = $state(true);
  let error = $state<string | null>(null);

  let search = $state('');
  let minRating = $state<number | null>(null);
  let activeLabel = $state<string | null>(null);
  let tab = $state<Tab>('all');

  // First-load spinner only — don't flash a spinner on subsequent filter fetches.
  let hasLoaded = $state(false);

  // Apply tab as a client-side filter on the already-fetched rows. The server
  // already returns the union (rated ∪ labeled); tab just narrows that view.
  const visibleRows = $derived.by(() => {
    if (tab === 'rated') return rows.filter((r) => r.rating != null && r.rating > 0);
    if (tab === 'labeled') return rows.filter((r) => r.labels.length > 0);
    return rows;
  });

  const hasFilters = $derived(
    search.trim() !== '' || minRating !== null || activeLabel !== null || tab !== 'all',
  );

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  function onRowClick(uri: string) {
    const all = visibleRows.map((r) => r.uri);
    void playback.playTrack(uri, all);
  }

  // Shuffle uses the currently-visible URIs so it respects the active tab + chips.
  async function getCurrentFilterUris(): Promise<readonly string[]> {
    return visibleRows.map((r) => r.uri);
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

  function setTab(next: Tab) {
    tab = next;
  }

  onMount(() => {
    void load();
    return () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
    };
  });
</script>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 p-4 pb-32">
  <header class="flex items-baseline justify-between gap-3">
    <h1 class="text-2xl font-extrabold">
      Your Library <span class="text-sm font-normal text-white/40">{visibleRows.length}</span>
    </h1>
    <PremiumGate {product}>
      <ShuffleButton store={playback} getUris={getCurrentFilterUris} label="Shuffle" />
    </PremiumGate>
  </header>

  <div class="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.08] px-4 py-2.5 backdrop-blur">
    <Search class="size-4 text-white/50" />
    <input
      type="text"
      bind:value={search}
      oninput={onSearchInput}
      maxlength="100"
      aria-label="Search your library"
      placeholder="Search your library…"
      class="w-full bg-transparent text-sm text-white placeholder:text-white/40 focus:outline-none"
    />
  </div>

  <!-- Segmented tab bar: All / Rated / Labeled (client-side filter over the union). -->
  <div
    role="tablist"
    aria-label="Library tab"
    class="flex rounded-full border border-white/10 bg-white/[0.08] p-1 text-xs backdrop-blur"
  >
    {#each [{ id: 'all' as Tab, label: 'All' }, { id: 'rated' as Tab, label: 'Rated' }, { id: 'labeled' as Tab, label: 'Labeled' }] as item (item.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        data-testid="library-tab-{item.id}"
        onclick={() => setTab(item.id)}
        class="flex-1 rounded-full py-1.5 transition-colors {tab === item.id
          ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] font-semibold text-black shadow shadow-spotify-green/30'
          : 'text-white/70 hover:text-white'}"
      >
        {item.label}
      </button>
    {/each}
  </div>

  <!-- Rating + label chips. Glass-styled to match the rest of the screen. -->
  <div class="-mx-1 flex flex-wrap gap-2 px-1">
    <button
      type="button"
      aria-pressed={minRating === 10}
      aria-label="★★★★★"
      onclick={() => toggleRating(10)}
      class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors focus:outline-none {minRating ===
      10
        ? 'bg-spotify-green font-semibold text-black shadow shadow-spotify-green/40'
        : 'bg-white/10 text-white/70 backdrop-blur hover:bg-white/20'}"
    >
      <Star class="size-3 fill-current" />5
    </button>
    <button
      type="button"
      aria-pressed={minRating === 8}
      aria-label="★★★★+"
      onclick={() => toggleRating(8)}
      class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors focus:outline-none {minRating ===
      8
        ? 'bg-spotify-green font-semibold text-black shadow shadow-spotify-green/40'
        : 'bg-white/10 text-white/70 backdrop-blur hover:bg-white/20'}"
    >
      <Star class="size-3 fill-current" />4+
    </button>

    {#each facets.topLabels as label (label.name)}
      <button
        type="button"
        aria-pressed={activeLabel === label.name}
        onclick={() => toggleLabel(label.name)}
        class="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors focus:outline-none {activeLabel ===
        label.name
          ? 'bg-spotify-green font-semibold text-black shadow shadow-spotify-green/40'
          : 'bg-white/10 text-white/70 backdrop-blur hover:bg-white/20'}"
      >
        {label.name}
      </button>
    {/each}
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
  {:else if visibleRows.length === 0}
    <p class="py-8 text-center text-sm opacity-60">
      {#if hasFilters}
        No tracks match your filters.
      {:else}
        No rated or labeled tracks yet — go rate something on now-playing.
      {/if}
    </p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each visibleRows as row (row.uri)}
        <LibraryRow {row} onclick={onRowClick} isPlaying={playback.state.track?.uri === row.uri} />
      {/each}
    </div>
  {/if}
</main>
