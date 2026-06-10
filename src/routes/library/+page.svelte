<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, Star, ArrowUpDown } from '@lucide/svelte';
  import LibraryRow from '$lib/components/LibraryRow.svelte';
  import ArtistRow from '$lib/components/ArtistRow.svelte';
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
    rank?: number | null;
  };

  type ArtistAggRow = {
    name: string;
    count: number;
    avg: number;
    score: number;
  };

  type Facets = {
    total: number;
    topLabels: { name: string; count: number }[];
  };

  type Tab = 'all' | 'rated' | 'labeled';
  type View = 'songs' | 'artists';
  type SongSort = 'recency' | 'rating' | 'name' | 'artist' | 'listens';
  type ArtistSort = 'score' | 'average' | 'name' | 'count' | 'listens';

  const SONG_SORT_LABEL: Record<SongSort, string> = {
    recency: 'Recent',
    rating: 'Rating',
    name: 'Name',
    artist: 'Artist',
    listens: 'Most listened',
  };

  const ARTIST_SORT_LABEL: Record<ArtistSort, string> = {
    score: 'Score',
    average: 'Average',
    name: 'Name',
    count: 'Most rated',
    listens: 'Most listened',
  };

  // How many rows to request per page; the list lazy-loads the next page as the
  // user scrolls. Mirrors LIBRARY_PAGE_SIZE on the server.
  const PAGE_SIZE = 50;

  let rows = $state<Row[]>([]);
  // True (uncapped) number of rows matching the current tab + filters, from the
  // server. Drives the header count and tells us when to stop lazy-loading.
  let total = $state(0);
  let loadingMore = $state(false);
  let sentinel = $state<HTMLDivElement | null>(null);
  // Bumped on every reset (loadSongs); an in-flight loadMore whose generation no
  // longer matches discards its result instead of appending stale rows.
  let reqGen = 0;
  let artistRows = $state<ArtistAggRow[]>([]);
  // Spotify top artists (most-listened order) — a separate dataset from the
  // rated-library aggregates above, loaded only when the "Most listened" sort
  // is active since it can include artists not yet in the library.
  let topArtistRows = $state<ArtistAggRow[]>([]);
  let facets = $state<Facets>({ total: 0, topLabels: [] });
  let loading = $state(true);
  let artistsLoading = $state(false);
  let topArtistsLoading = $state(false);
  let error = $state<string | null>(null);

  type Persisted = {
    view: View;
    search: string;
    minRating: number | null;
    activeLabel: string | null;
    tab: Tab;
    songSort: SongSort;
    artistSort: ArtistSort;
  };

  const STORAGE_KEY = 'library:state';

  function loadPersisted(): Partial<Persisted> {
    if (typeof sessionStorage === 'undefined') return {};
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    } catch {
      return {};
    }
  }

  const persisted = loadPersisted();

  let view = $state<View>(persisted.view ?? 'songs');
  let search = $state(persisted.search ?? '');
  let minRating = $state<number | null>(persisted.minRating ?? null);
  let activeLabel = $state<string | null>(persisted.activeLabel ?? null);
  let tab = $state<Tab>(persisted.tab ?? 'all');
  // Rating is the default sort — this is a rating app; recency is one tap away.
  let songSort = $state<SongSort>(persisted.songSort ?? 'rating');
  let artistSort = $state<ArtistSort>(persisted.artistSort ?? 'score');
  let sortMenuOpen = $state(false);

  $effect(() => {
    if (typeof sessionStorage === 'undefined') return;
    const snapshot: Persisted = { view, search, minRating, activeLabel, tab, songSort, artistSort };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // ignore quota / disabled storage
    }
  });

  let hasLoaded = $state(false);
  let artistsLoaded = $state(false);
  let topArtistsLoaded = $state(false);

  const visibleRows = $derived.by(() => {
    // The library listing is already tab-filtered + paginated server-side, so its
    // rows render as-is. Only "Most listened" (a fully-loaded ≤50 snapshot that
    // ignores the tab server-side) is filtered here.
    if (songSort !== 'listens') return rows;
    if (tab === 'rated') return rows.filter((r) => r.rating != null && r.rating > 0);
    if (tab === 'labeled') return rows.filter((r) => r.labels.length > 0);
    return rows;
  });

  // Header count: the true server total for the paginated library; for the fixed
  // "Most listened" snapshot it's the (client-tab-filtered) loaded count.
  const songCount = $derived(songSort === 'listens' ? visibleRows.length : total);

  // More pages to lazy-load? Never for the non-paginated "Most listened" view.
  const hasMore = $derived(songSort !== 'listens' && rows.length < total);

  const sortedArtists = $derived.by(() => {
    // "Most listened" comes from the server already in Spotify rank order.
    if (artistSort === 'listens') return topArtistRows;
    const copy = [...artistRows];
    if (artistSort === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (artistSort === 'count') {
      copy.sort((a, b) => b.count - a.count || b.score - a.score);
    } else if (artistSort === 'average') {
      copy.sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name));
    }
    // 'score' is already the server's default order.
    return copy;
  });

  const visibleArtists = $derived.by(() => {
    const s = search.trim().toLowerCase();
    if (s === '') return sortedArtists;
    return sortedArtists.filter((a) => a.name.toLowerCase().includes(s));
  });

  const hasFilters = $derived(
    search.trim() !== '' || minRating !== null || activeLabel !== null || tab !== 'all',
  );

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  function onRowClick(uri: string) {
    void goto(`/library/track/${encodeURIComponent(uri)}`);
  }

  function onArtistClick(name: string) {
    void goto(`/library/artist/${encodeURIComponent(name)}`);
  }

  async function getCurrentFilterUris(): Promise<readonly string[]> {
    // "Most listened" is fully loaded (≤50) — shuffle what's on screen.
    if (songSort === 'listens') return visibleRows.map((r) => r.uri);
    // Otherwise fetch every matching uri so shuffle covers the whole filtered
    // library, not just the pages scrolled into view. Falls back to the loaded
    // rows if the request fails.
    try {
      const params = buildParams();
      params.set('uris', '1');
      const res = await fetch(`/api/library?${params.toString()}`);
      if (!res.ok) return visibleRows.map((r) => r.uri);
      const data = await res.json();
      return (data.uris ?? []) as string[];
    } catch {
      return visibleRows.map((r) => r.uri);
    }
  }

  // Query string shared by the page fetch, the lazy-load fetch and the shuffle
  // uri fetch. Omits the tab for "Most listened" (which ignores it server-side).
  function buildParams(): URLSearchParams {
    const params = new URLSearchParams();
    const trimmed = search.trim();
    if (trimmed !== '') params.set('search', trimmed);
    if (minRating !== null) params.set('minRating', String(minRating));
    if (activeLabel !== null) params.set('label', activeLabel);
    if (songSort !== 'recency') params.set('sort', songSort);
    if (tab !== 'all' && songSort !== 'listens') params.set('tab', tab);
    return params;
  }

  // Cancel any in-flight songs fetch so a faster, newer request can't be
  // overwritten by a slow earlier one (e.g. mount + immediate filter change).
  let songsAbort: AbortController | null = null;

  // Reset to page 1. Aborts any in-flight fetch and bumps reqGen so a racing
  // loadMore discards its result.
  async function loadSongs() {
    const gen = ++reqGen;
    songsAbort?.abort();
    const ac = new AbortController();
    songsAbort = ac;
    loading = true;
    loadingMore = false;
    const params = buildParams();
    // Page 1. Explicit so the server paginates (its no-param default is the
    // larger back-compat cap used by non-paginating callers). "Most listened"
    // ignores paging — it's a fixed ≤50 snapshot — so don't bother sending it.
    if (songSort !== 'listens') params.set('limit', String(PAGE_SIZE));

    try {
      const qs = params.toString();
      const res = await fetch(`/api/library${qs ? `?${qs}` : ''}`, { signal: ac.signal });
      if (!res.ok) {
        error = "Couldn't load your library. Try again.";
        return;
      }
      const data = await res.json();
      if (gen !== reqGen) return; // a newer reset superseded us
      rows = data.rows ?? [];
      total = typeof data.total === 'number' ? data.total : rows.length;
      facets = data.facets ?? { total: 0, topLabels: [] };
      error = null;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      error = "Couldn't load your library. Check your connection.";
    } finally {
      if (songsAbort === ac) {
        loading = false;
        hasLoaded = true;
        songsAbort = null;
      }
    }
  }

  // Append the next page. Guarded so only one runs at a time and never during a
  // reset; a reset that lands mid-flight (reqGen advances) discards the result.
  async function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    const gen = reqGen;
    const ac = new AbortController();
    songsAbort = ac;
    loadingMore = true;
    const params = buildParams();
    params.set('offset', String(rows.length));
    params.set('limit', String(PAGE_SIZE));

    try {
      const res = await fetch(`/api/library?${params.toString()}`, { signal: ac.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (gen !== reqGen) return; // dataset changed underneath us → discard
      rows = [...rows, ...(data.rows ?? [])];
      if (typeof data.total === 'number') total = data.total;
      error = null;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
    } finally {
      loadingMore = false;
      if (songsAbort === ac) songsAbort = null;
    }
  }

  async function loadArtists() {
    artistsLoading = true;
    let ok = false;
    try {
      const res = await fetch('/api/library/artists');
      if (!res.ok) {
        error = "Couldn't load your artists. Try again.";
        return;
      }
      const data = await res.json();
      artistRows = data.rows ?? [];
      error = null;
      ok = true;
    } catch {
      error = "Couldn't load your artists. Check your connection.";
    } finally {
      artistsLoading = false;
      // Only flip artistsLoaded on success so failures stay retryable when the
      // user toggles back to the Artists tab.
      if (ok) artistsLoaded = true;
    }
  }

  async function loadTopArtists() {
    topArtistsLoading = true;
    let ok = false;
    try {
      const res = await fetch('/api/library/artists?sort=listens');
      if (!res.ok) {
        error = "Couldn't load your top artists. Try again.";
        return;
      }
      const data = await res.json();
      topArtistRows = data.rows ?? [];
      error = null;
      ok = true;
    } catch {
      error = "Couldn't load your top artists. Check your connection.";
    } finally {
      topArtistsLoading = false;
      if (ok) topArtistsLoaded = true;
    }
  }

  // Load whichever artist dataset the current sort needs (the rated-library
  // aggregates, or the Spotify top-artist snapshot for "Most listened").
  function ensureArtistData() {
    if (artistSort === 'listens') {
      if (!topArtistsLoaded) void loadTopArtists();
    } else if (!artistsLoaded) {
      void loadArtists();
    }
  }

  function onSearchInput() {
    if (view === 'artists') return; // client-filtered, no debounce needed
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void loadSongs();
    }, 250);
  }

  function toggleRating(value: number) {
    minRating = minRating === value ? null : value;
    void loadSongs();
  }

  function toggleLabel(name: string) {
    activeLabel = activeLabel === name ? null : name;
    void loadSongs();
  }

  function setTab(next: Tab) {
    if (tab === next) return;
    tab = next;
    // The library listing is tab-filtered + paginated server-side, so a tab
    // change is a fresh page-1 fetch. "Most listened" filters client-side
    // (visibleRows reacts on its own), so it needs no refetch.
    if (songSort !== 'listens') void loadSongs();
  }

  function setView(next: View) {
    const prev = view;
    view = next;
    sortMenuOpen = false;
    if (next === 'artists') ensureArtistData();
    // Reload songs when returning to Songs: the user may have typed in the
    // shared search box while in Artists view, which skipped the song fetch.
    if (next === 'songs' && prev !== 'songs') void loadSongs();
  }

  function setSongSort(next: SongSort) {
    songSort = next;
    sortMenuOpen = false;
    void loadSongs();
  }

  function setArtistSort(next: ArtistSort) {
    artistSort = next;
    sortMenuOpen = false;
    ensureArtistData();
  }

  onMount(() => {
    // Back-link query param overrides persisted view (kept for backward compat).
    if (page.url.searchParams.get('view') === 'artists') {
      view = 'artists';
    }
    if (view === 'artists') ensureArtistData();
    void loadSongs();
    return () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
    };
  });

  // Lazy-load the next page when the sentinel below the list scrolls into view.
  // Re-runs whenever `sentinel` mounts/unmounts (it only renders while hasMore).
  // rootMargin preloads a page before the user actually hits the bottom.
  $effect(() => {
    const el = sentinel;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  });
</script>


<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-32">
  <header class="flex items-baseline justify-between gap-3">
    <h1 class="text-2xl font-extrabold">
      Your Library
      <span class="text-sm font-normal text-white/40">
        {view === 'songs' ? songCount : visibleArtists.length}
      </span>
    </h1>
    {#if view === 'songs'}
      <PremiumGate {product}>
        <ShuffleButton store={playback} getUris={getCurrentFilterUris} label="Shuffle" />
      </PremiumGate>
    {/if}
  </header>

  <div class="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.08] px-4 py-2.5 backdrop-blur">
    <Search class="size-4 text-white/50" />
    <input
      type="text"
      bind:value={search}
      oninput={onSearchInput}
      maxlength="100"
      aria-label={view === 'songs' ? 'Search your library' : 'Search artists'}
      placeholder={view === 'songs' ? 'Search your library…' : 'Search artists…'}
      class="w-full bg-transparent text-sm text-white placeholder:text-white/40 focus:outline-none"
    />
  </div>

  <!-- Top-level Songs / Artists toggle -->
  <div
    role="tablist"
    aria-label="Library view"
    class="flex rounded-full border border-white/10 bg-white/[0.08] p-1 text-xs backdrop-blur"
  >
    {#each [{ id: 'songs' as View, label: 'Songs' }, { id: 'artists' as View, label: 'Artists' }] as item (item.id)}
      <button
        type="button"
        role="tab"
        aria-selected={view === item.id}
        data-testid="library-view-{item.id}"
        onclick={() => setView(item.id)}
        class="flex-1 rounded-full py-1.5 transition-colors {view === item.id
          ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] font-semibold text-black shadow shadow-spotify-green/30'
          : 'text-white/70 hover:text-white'}"
      >
        {item.label}
      </button>
    {/each}
  </div>

  {#if view === 'songs'}
    <!-- All / Rated / Labeled + sort dropdown -->
    <div class="flex items-center gap-2">
      <div
        role="tablist"
        aria-label="Library tab"
        class="flex flex-1 rounded-full border border-white/10 bg-white/[0.05] p-1 text-[11px] backdrop-blur"
      >
        {#each [{ id: 'all' as Tab, label: 'All' }, { id: 'rated' as Tab, label: 'Rated' }, { id: 'labeled' as Tab, label: 'Labeled' }] as item (item.id)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid="library-tab-{item.id}"
            onclick={() => setTab(item.id)}
            class="flex-1 rounded-full py-1 transition-colors {tab === item.id
              ? 'bg-white/15 font-medium text-white'
              : 'text-white/60 hover:text-white'}"
          >
            {item.label}
          </button>
        {/each}
      </div>

      <div class="relative">
        <button
          type="button"
          data-testid="library-sort-button"
          aria-label="Sort"
          aria-expanded={sortMenuOpen}
          onclick={() => { sortMenuOpen = !sortMenuOpen; }}
          class="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/80 hover:bg-white/10"
        >
          <ArrowUpDown class="size-3" />
          {SONG_SORT_LABEL[songSort]}
        </button>
        {#if sortMenuOpen}
          <div
            class="absolute right-0 top-full z-10 mt-1 flex flex-col rounded-xl border border-white/10 bg-black/95 p-1 text-xs shadow-xl backdrop-blur"
          >
            {#each (['recency', 'rating', 'name', 'artist', 'listens'] as const) as opt (opt)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={songSort === opt}
                data-testid="library-sort-{opt}"
                onclick={() => setSongSort(opt)}
                class="whitespace-nowrap rounded-lg px-3 py-1.5 text-left transition-colors {songSort === opt ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}"
              >
                {SONG_SORT_LABEL[opt]}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- Rating + label chips. Hidden under "Most listened": that view is the
         fixed Spotify top-50, not the filterable library. -->
    {#if songSort !== 'listens'}
    <div class="-mx-1 flex flex-wrap gap-2 px-1">
      <button
        type="button"
        aria-pressed={minRating === 5}
        aria-label="★★★★★"
        onclick={() => toggleRating(5)}
        class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors focus:outline-none {minRating ===
        5
          ? 'bg-spotify-green font-semibold text-black shadow shadow-spotify-green/40'
          : 'bg-white/10 text-white/70 backdrop-blur hover:bg-white/20'}"
      >
        <Star class="size-3 fill-current" />5
      </button>
      <button
        type="button"
        aria-pressed={minRating === 4}
        aria-label="★★★★+"
        onclick={() => toggleRating(4)}
        class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors focus:outline-none {minRating ===
        4
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
    {/if}
  {:else}
    <!-- Artists sort -->
    <div class="flex justify-end">
      <div class="relative">
        <button
          type="button"
          data-testid="artists-sort-button"
          aria-label="Sort"
          aria-expanded={sortMenuOpen}
          onclick={() => { sortMenuOpen = !sortMenuOpen; }}
          class="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/80 hover:bg-white/10"
        >
          <ArrowUpDown class="size-3" />
          {ARTIST_SORT_LABEL[artistSort]}
        </button>
        {#if sortMenuOpen}
          <div
            class="absolute right-0 top-full z-10 mt-1 flex flex-col rounded-xl border border-white/10 bg-black/95 p-1 text-xs shadow-xl backdrop-blur"
          >
            {#each (['score', 'average', 'name', 'count', 'listens'] as const) as opt (opt)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={artistSort === opt}
                data-testid="artists-sort-{opt}"
                onclick={() => setArtistSort(opt)}
                class="whitespace-nowrap rounded-lg px-3 py-1.5 text-left transition-colors {artistSort === opt ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}"
              >
                {ARTIST_SORT_LABEL[opt]}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>

  {#if view === 'songs'}
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
        {#if songSort === 'listens' && !hasFilters}
          No Spotify listening data yet — listen on Spotify and check back.
        {:else if hasFilters}
          No tracks match your filters.
        {:else}
          No rated or labeled tracks yet — go rate something on now-playing.
        {/if}
      </p>
    {:else}
      <div class="flex flex-col gap-2">
        {#each visibleRows as row (row.uri)}
          <LibraryRow {row} rank={row.rank ?? null} onclick={onRowClick} isPlaying={playback.state.track?.uri === row.uri} />
        {/each}
      </div>
      {#if hasMore}
        <!-- Sentinel: when it scrolls near the viewport, the next page loads. -->
        <div bind:this={sentinel} class="h-px w-full" aria-hidden="true"></div>
        <div class="flex justify-center py-4 text-xs text-white/40" aria-live="polite">
          {#if loadingMore}Loading more…{/if}
        </div>
      {/if}
    {/if}
  {:else}
    {#if artistSort === 'listens' ? topArtistsLoading && !topArtistsLoaded : artistsLoading && !artistsLoaded}
      <div class="flex flex-col gap-2">
        {#each [0, 1, 2, 3, 4] as i (i)}
          <div class="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2">
            <div class="size-12 flex-shrink-0 animate-pulse rounded-full bg-white/10"></div>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <div class="h-3.5 w-2/3 animate-pulse rounded bg-white/10"></div>
              <div class="h-2.5 w-1/2 animate-pulse rounded bg-white/10"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if visibleArtists.length === 0}
      <p class="py-8 text-center text-sm opacity-60">
        {#if search.trim() !== ''}
          No artists match your search.
        {:else if artistSort === 'listens'}
          No Spotify listening data yet — listen on Spotify and check back.
        {:else}
          No rated tracks yet — go rate something on now-playing.
        {/if}
      </p>
    {:else}
      <div class="flex flex-col gap-2">
        {#each visibleArtists as artist, i (artist.name)}
          <ArtistRow row={artist} rank={i + 1} onclick={onArtistClick} />
        {/each}
      </div>
    {/if}
  {/if}
</main>
