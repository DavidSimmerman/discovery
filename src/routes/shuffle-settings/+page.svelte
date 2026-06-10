<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Ban, Check, Library, Plus, Sparkles, X } from '@lucide/svelte';
  import PlaylistPickerSheet, {
    type PickerPlaylist,
  } from '$lib/components/PlaylistPickerSheet.svelte';
  import FilterPickerSheet, {
    type FilterOption,
    type FilterChipState,
  } from '$lib/components/FilterPickerSheet.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import type {
    ShuffleSettings,
    PlaylistSourceMode,
    FilterEntry,
  } from '$lib/server/shuffle/config';

  const playback = getPlaybackStore();

  type Tab = 'sources' | 'filters' | 'weighting';
  let tab = $state<Tab>('sources');

  let settings = $state<ShuffleSettings | null>(null);
  let libraryCount = $state(0);
  let loadError = $state<string | null>(null);

  // ---- playlist catalogue (picker) ------------------------------------------
  let pickerOpen = $state(false);
  let playlistsLoading = $state(false);
  let playlistsLoaded = false;
  let missingScope = $state(false);
  let catalogue = $state<PickerPlaylist[]>([]);
  // stats per playlist id, filled progressively
  let stats = $state<Record<string, { total: number; rated: number; unrated: number }>>({});

  async function loadCatalogue() {
    if (playlistsLoaded) return;
    playlistsLoading = true;
    try {
      const res = await fetch('/api/shuffle/playlists');
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      if (json.reason === 'missing-scope') {
        missingScope = true;
        return;
      }
      // Seed counts already fetched for saved playlists (stats load on mount).
      catalogue = (json.playlists as { id: string; name: string; imageUrl: string | null; total: number }[])
        .map((p) => ({ ...p, unrated: stats[p.id]?.unrated ?? null }));
      playlistsLoaded = true;
      void loadStats(catalogue.map((p) => p.id));
    } catch {
      loadError = "Couldn't load your playlists.";
    } finally {
      playlistsLoading = false;
    }
  }

  // Fan out stats requests with limited concurrency; counts stream into the UI.
  async function loadStats(ids: string[]) {
    const queue = ids.filter((id) => stats[id] === undefined);
    const CONCURRENCY = 3;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            const res = await fetch(`/api/shuffle/playlists/${id}/stats`);
            if (!res.ok) continue;
            const s = await res.json();
            stats = { ...stats, [id]: s };
            catalogue = catalogue.map((p) => (p.id === id ? { ...p, unrated: s.unrated } : p));
          } catch {
            // leave the count unknown; the row still works
          }
        }
      }),
    );
  }

  // ---- settings load / mutate ------------------------------------------------
  onMount(async () => {
    try {
      const res = await fetch('/api/shuffle/settings');
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      settings = json.settings;
      lastSaved = JSON.stringify({ settings: json.settings }); // seed: no save for what we just loaded
      libraryCount = json.libraryCount;
      // Counts for already-selected playlists power the CTA total.
      if (json.settings.sources.playlists.length > 0) {
        void loadStats(json.settings.sources.playlists.map((p: { id: string }) => p.id));
      }
    } catch {
      loadError = "Couldn't load shuffle settings.";
    }
  });

  function toggleLibrary() {
    if (!settings) return;
    settings.sources.library = !settings.sources.library;
  }

  function setMode(id: string, mode: PlaylistSourceMode) {
    if (!settings) return;
    settings.sources.playlists = settings.sources.playlists.map((p) =>
      p.id === id ? { ...p, mode } : p,
    );
  }

  function togglePlaylist(id: string) {
    if (!settings) return;
    const existing = settings.sources.playlists.find((p) => p.id === id);
    if (existing) {
      settings.sources.playlists = settings.sources.playlists.filter((p) => p.id !== id);
      return;
    }
    const cat = catalogue.find((p) => p.id === id);
    if (!cat) return;
    // 'unrated' default: the picker exists to rate-walk playlists.
    settings.sources.playlists = [
      ...settings.sources.playlists,
      { id, name: cat.name, mode: 'unrated' },
    ];
  }

  const selectedIds = $derived(new Set(settings?.sources.playlists.map((p) => p.id) ?? []));

  // ---- filter options + helpers ----------------------------------------------
  type Options = {
    artists: FilterOption[];
    genres: FilterOption[];
    versionTypes: { id: string; count: number }[];
    labels: FilterOption[];
  };
  let filterOptions = $state<Options | null>(null);
  let optionsLoading = $state(false);
  let optionsAttempted = false; // one shot per page visit — no retry loop on failure
  let artistPickerOpen = $state(false);
  let genrePickerOpen = $state(false);

  async function loadFilterOptions() {
    if (optionsAttempted) return;
    optionsAttempted = true;
    optionsLoading = true;
    try {
      const res = await fetch('/api/shuffle/filter-options');
      if (res.ok) filterOptions = await res.json();
    } finally {
      optionsLoading = false;
    }
  }
  $effect(() => {
    if (tab === 'filters') void loadFilterOptions();
  });

  type Axis = 'artists' | 'genres' | 'labels';

  function axisState(axis: Axis, id: string): FilterChipState {
    const a = settings?.filters[axis];
    if (!a) return null;
    if (a.include.some((e) => e.id === id)) return 'include';
    if (a.exclude.some((e) => e.id === id)) return 'exclude';
    return null;
  }

  // neutral → include → exclude → neutral
  function cycleAxis(axis: Axis, opt: { id: string; name: string }) {
    if (!settings) return;
    const a = settings.filters[axis];
    const entry: FilterEntry = { id: opt.id, name: opt.name };
    const st = axisState(axis, opt.id);
    if (st === null) {
      a.include = [...a.include, entry];
    } else if (st === 'include') {
      a.include = a.include.filter((e) => e.id !== opt.id);
      a.exclude = [...a.exclude, entry];
    } else {
      a.exclude = a.exclude.filter((e) => e.id !== opt.id);
    }
  }

  function flipAxis(axis: Axis, id: string) {
    if (!settings) return;
    const a = settings.filters[axis];
    const inc = a.include.find((e) => e.id === id);
    if (inc) {
      a.include = a.include.filter((e) => e.id !== id);
      a.exclude = [...a.exclude, inc];
    } else {
      const exc = a.exclude.find((e) => e.id === id);
      if (!exc) return;
      a.exclude = a.exclude.filter((e) => e.id !== id);
      a.include = [...a.include, exc];
    }
  }

  function removeAxis(axis: Axis, id: string) {
    if (!settings) return;
    const a = settings.filters[axis];
    a.include = a.include.filter((e) => e.id !== id);
    a.exclude = a.exclude.filter((e) => e.id !== id);
  }

  function toggleVersion(id: string) {
    if (!settings) return;
    const ex = settings.filters.versionTypes.exclude;
    settings.filters.versionTypes.exclude = ex.includes(id)
      ? ex.filter((v) => v !== id)
      : [...ex, id];
  }

  function toggleStar(star: number) {
    if (!settings) return;
    const r = settings.filters.rating;
    // Chip semantics over a contiguous range: tap outside extends the range to
    // the tapped star; tap on an edge shrinks past it; tap mid-range collapses
    // the range to just that star.
    if (star < r.minStars) r.minStars = star;
    else if (star > r.maxStars) r.maxStars = star;
    else if (star === r.minStars && r.minStars < r.maxStars) r.minStars = star + 1;
    else if (star === r.maxStars && r.minStars < r.maxStars) r.maxStars = star - 1;
    else if (r.minStars === r.maxStars) {
      r.minStars = 1;
      r.maxStars = 5; // tapping the only selected star resets the range
    } else {
      r.minStars = star;
      r.maxStars = star;
    }
  }

  // ---- live CTA count (exact, server-computed) ---------------------------------
  let previewCount = $state<number | null>(null);
  let previewPending = $state(false);
  let previewSeq = 0;

  $effect(() => {
    if (!settings) return;
    const body = JSON.stringify({ settings }); // deep read = dependency tracking
    const seq = ++previewSeq;
    previewPending = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/shuffle/preview-count', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (seq !== previewSeq) return; // stale response
        if (res.ok) previewCount = (await res.json()).count;
      } finally {
        if (seq === previewSeq) previewPending = false;
      }
    }, 350);
    return () => clearTimeout(t);
  });

  const canShuffle = $derived(
    settings != null &&
      (settings.sources.library || settings.sources.playlists.length > 0) &&
      (previewCount == null || previewCount > 0 || previewPending),
  );

  // ---- save + shuffle ----------------------------------------------------------
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSaved = ''; // serialized form of what the server has
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  async function saveSettings(): Promise<boolean> {
    // Never PUT before the initial load resolves — {settings: null} would
    // normalize to defaults server-side and wipe the user's saved sources.
    if (!settings) return true;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const body = JSON.stringify({ settings });
    if (body === lastSaved) return true;
    const res = await fetch('/api/shuffle/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      // Survives an immediate navigation (e.g. tapping Back right after a toggle).
      keepalive: true,
    });
    if (res.ok) lastSaved = body;
    return res.ok;
  }

  // Auto-save: any edit persists after a short debounce — no explicit save step.
  $effect(() => {
    if (!settings) return;
    const body = JSON.stringify({ settings }); // deep read = dependency tracking
    if (body === lastSaved) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveSettings();
    }, 400);
    return () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
    };
  });

  async function shuffleNow() {
    if (!settings || saving) return;
    saving = true;
    saveError = null;
    try {
      if (!(await saveSettings())) {
        saveError = "Couldn't save settings. Try again.";
        return;
      }
      await playback.startSampler({ reset: true });
      await goto('/now-playing');
    } finally {
      saving = false;
    }
  }

  function goBack() {
    void saveSettings(); // flush any pending debounce (keepalive carries it)
    if (history.length > 1) history.back();
    else void goto('/now-playing');
  }
</script>

<main class="mx-auto min-h-screen w-full max-w-md px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-44">
  <header class="mb-4 flex items-center gap-3">
    <button
      type="button"
      onclick={goBack}
      aria-label="Back"
      class="grid size-9 place-items-center rounded-full bg-white/[0.06] text-white/70 transition-colors hover:bg-white/[0.12]"
    >
      <ArrowLeft class="size-4.5" />
    </button>
    <h1 class="text-xl font-extrabold">Shuffle settings</h1>
  </header>

  <!-- tabs -->
  <div class="mb-5 flex rounded-full border border-white/10 bg-white/[0.06] p-1 text-xs" role="tablist">
    {#each [['sources', 'Sources'], ['filters', 'Filters'], ['weighting', 'Weighting']] as [key, label] (key)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === key}
        onclick={() => (tab = key as Tab)}
        class="flex-1 rounded-full py-1.5 font-semibold transition-colors {tab === key
          ? 'bg-gradient-to-b from-purple-500 to-purple-700 text-white'
          : 'text-white/60'}"
      >
        {label}
      </button>
    {/each}
  </div>

  {#if loadError}
    <p class="rounded-2xl bg-red-500/10 p-4 text-sm text-red-300">{loadError}</p>
  {:else if !settings}
    <p class="p-4 text-center text-sm text-white/40">Loading…</p>
  {:else if tab === 'sources'}
    <p class="mb-2 px-1 text-[11px] font-bold uppercase tracking-wide text-white/40">
      Pull songs from
    </p>
    <div class="flex flex-col gap-2">
      <!-- Discovery library -->
      <button
        type="button"
        data-testid="source-library"
        onclick={toggleLibrary}
        class="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-colors {settings
          .sources.library
          ? 'border border-purple-400/40 bg-purple-500/[0.07]'
          : 'bg-white/[0.04] hover:bg-white/[0.07]'}"
      >
        <span class="grid size-10 flex-shrink-0 place-items-center rounded-lg bg-white/[0.06]">
          <Library class="size-5 text-white/70" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold">Discovery library</div>
          <div class="text-xs text-white/45">Everything you've rated · {libraryCount.toLocaleString()}</div>
        </div>
        <div
          class="grid size-5 flex-shrink-0 place-items-center rounded-md {settings.sources.library
            ? 'bg-purple-500 text-white'
            : 'border border-white/25'}"
        >
          {#if settings.sources.library}<Check class="size-3.5" strokeWidth={3} />{/if}
        </div>
      </button>

      <!-- Selected playlists -->
      {#each settings.sources.playlists as p (p.id)}
        {@const s = stats[p.id]}
        {@const cat = catalogue.find((c) => c.id === p.id)}
        <div
          data-testid="source-playlist"
          class="rounded-2xl border border-purple-400/40 bg-purple-500/[0.07] p-3"
        >
          <div class="flex items-center gap-3">
            {#if cat?.imageUrl}
              <img src={cat.imageUrl} alt="" class="size-10 flex-shrink-0 rounded-lg object-cover" />
            {:else}
              <div class="grid size-10 flex-shrink-0 place-items-center rounded-lg bg-gradient-to-br from-white/15 to-white/5 text-sm font-bold text-white/60">
                {p.name.charAt(0)}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold">{p.name}</div>
              <div class="text-xs text-white/45">
                {#if s}
                  Playlist · {s.unrated} unrated of {s.total}
                {:else}
                  Playlist
                {/if}
              </div>
            </div>
            <button
              type="button"
              aria-label="Remove {p.name}"
              onclick={() => togglePlaylist(p.id)}
              class="grid size-5 flex-shrink-0 place-items-center rounded-md bg-purple-500 text-white"
            >
              <Check class="size-3.5" strokeWidth={3} />
            </button>
          </div>
          <div class="mt-3 flex rounded-full border border-white/10 bg-black/30 p-0.5 text-[11px]">
            {#each [['unrated', 'Unrated only'], ['rated', 'Rated'], ['both', 'Both']] as [mode, label] (mode)}
              <button
                type="button"
                onclick={() => setMode(p.id, mode as PlaylistSourceMode)}
                class="flex-1 rounded-full py-1.5 font-semibold transition-colors {p.mode === mode
                  ? 'bg-gradient-to-b from-purple-500 to-purple-700 text-white'
                  : 'text-white/60'}"
              >
                {label}
              </button>
            {/each}
          </div>
        </div>
      {/each}

      <!-- Add a playlist -->
      <button
        type="button"
        data-testid="add-playlist"
        onclick={() => {
          pickerOpen = true;
          void loadCatalogue();
        }}
        class="flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] p-3 text-left transition-colors hover:bg-white/[0.07]"
      >
        <span class="grid size-10 flex-shrink-0 place-items-center rounded-lg bg-white/[0.06] text-[#1DB954]">
          <Plus class="size-5" />
        </span>
        <div class="flex-1">
          <div class="text-sm font-semibold">Add a playlist…</div>
          <div class="text-xs text-white/45">Pick from your Spotify playlists</div>
        </div>
      </button>
    </div>

    <div class="mt-5 rounded-2xl border border-white/5 bg-white/[0.03] p-3 text-xs leading-relaxed text-white/45">
      Sources combine. Filters &amp; weighting apply across everything you pick here.
    </div>
  {:else if tab === 'filters'}
    {@const r = settings.filters.rating}
    <div class="flex flex-col gap-3">
      <!-- Rating -->
      <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="filter-rating">
        <div class="mb-3 flex items-center justify-between">
          <span class="text-sm font-semibold">Rating</span>
          <div class="flex rounded-full border border-white/10 bg-black/30 p-0.5 text-[11px]">
            {#each [['unrated', 'Unrated'], ['rated', 'Rated'], ['both', 'Both']] as [mode, label] (mode)}
              <button
                type="button"
                onclick={() => (settings!.filters.rating.mode = mode as typeof r.mode)}
                class="rounded-full px-2.5 py-1 font-semibold transition-colors {r.mode === mode
                  ? 'bg-gradient-to-b from-purple-500 to-purple-700 text-white'
                  : 'text-white/50'}"
              >
                {label}
              </button>
            {/each}
          </div>
        </div>
        <div class={r.mode === 'unrated' ? 'pointer-events-none opacity-40' : ''}>
          <div class="mb-1.5 flex justify-between text-xs text-white/50">
            <span>Range (rated songs)</span>
            <span data-testid="filter-rating-range">{r.minStars}★ – {r.maxStars}★</span>
          </div>
          <div class="flex gap-1.5">
            {#each [1, 2, 3, 4, 5] as star (star)}
              <button
                type="button"
                data-testid="filter-star-{star}"
                onclick={() => toggleStar(star)}
                class="flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors {star >= r.minStars &&
                star <= r.maxStars
                  ? 'bg-purple-500/30 text-purple-200 ring-1 ring-purple-400/40'
                  : 'bg-white/[0.05] text-white/40'}"
              >
                {star}★
              </button>
            {/each}
          </div>
          {#if r.mode === 'unrated'}
            <p class="mt-1.5 text-[10px] text-white/30">Disabled while “Unrated” is selected</p>
          {/if}
        </div>
      </div>

      <!-- Artists + Genres (picker-backed axes) -->
      {#each [['artists', 'Artists'], ['genres', 'Genres']] as [axis, title] (axis)}
        {@const a = settings.filters[axis as Axis]}
        <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="filter-{axis}">
          <div class="mb-2.5 flex items-center justify-between">
            <span class="text-sm font-semibold">{title}</span>
            <button
              type="button"
              data-testid="filter-{axis}-add"
              onclick={() => {
                if (axis === 'artists') artistPickerOpen = true;
                else genrePickerOpen = true;
              }}
              class="text-xs font-medium text-purple-300"
            >
              + add
            </button>
          </div>
          {#if a.include.length === 0 && a.exclude.length === 0}
            <p class="text-xs text-white/30">Any — tap “+ add” to include or exclude</p>
          {:else}
            <div class="flex flex-wrap gap-1.5 text-[11px]">
              {#each [...a.include.map((e) => ({ ...e, st: 'include' as const })), ...a.exclude.map((e) => ({ ...e, st: 'exclude' as const }))] as chip (chip.st + chip.id)}
                <span
                  class="inline-flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1.5 {chip.st === 'include'
                    ? 'border-purple-400/40 bg-purple-500/25 text-purple-200'
                    : 'border-red-500/30 bg-red-500/15 text-red-300'}"
                >
                  <button type="button" class="inline-flex items-center gap-1" onclick={() => flipAxis(axis as Axis, chip.id)}>
                    {#if chip.st === 'include'}<Check class="size-3" />{:else}<Ban class="size-3" />{/if}
                    {chip.name}
                  </button>
                  <button type="button" aria-label="Remove {chip.name}" onclick={() => removeAxis(axis as Axis, chip.id)}>
                    <X class="size-3 opacity-60" />
                  </button>
                </span>
              {/each}
            </div>
            <p class="mt-2 text-[10px] text-white/30">Tap a chip to flip include ↔ exclude</p>
          {/if}
        </div>
      {/each}

      <!-- Labels -->
      <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="filter-labels">
        <div class="mb-2.5 flex items-center justify-between">
          <span class="text-sm font-semibold">Labels</span>
        </div>
        {#if !filterOptions}
          <p class="text-xs text-white/30">Loading…</p>
        {:else if filterOptions.labels.length === 0}
          <p class="text-xs text-white/30">No labels yet — add them with “+ label” on a song</p>
        {:else}
          <div class="flex flex-wrap gap-1.5 text-[11px]">
            {#each filterOptions.labels as l (l.id)}
              {@const st = axisState('labels', l.id)}
              <button
                type="button"
                data-testid="filter-label-chip"
                onclick={() => cycleAxis('labels', l)}
                class="rounded-full border px-2.5 py-1 transition-colors {st === 'include'
                  ? 'border-purple-400/40 bg-purple-500/25 text-purple-200'
                  : st === 'exclude'
                    ? 'border-red-500/30 bg-red-500/15 text-red-300'
                    : 'border-transparent bg-white/[0.06] text-white/60'}"
              >
                {#if st === 'include'}✓ {:else if st === 'exclude'}⊘ {/if}{l.name}
              </button>
            {/each}
          </div>
          <p class="mt-2 text-[10px] text-white/30">Tap to cycle: neutral → ✓ include → ⊘ exclude</p>
        {/if}
      </div>

      <!-- Versions -->
      <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="filter-versions">
        <div class="mb-2.5 flex items-center justify-between">
          <span class="text-sm font-semibold">Versions</span>
        </div>
        {#if !filterOptions}
          <p class="text-xs text-white/30">Loading…</p>
        {:else if filterOptions.versionTypes.length === 0}
          <p class="text-xs text-white/30">No version info on your songs yet</p>
        {:else}
          <div class="flex flex-wrap gap-1.5 text-[11px]">
            {#each filterOptions.versionTypes as v (v.id)}
              {@const excluded = settings.filters.versionTypes.exclude.includes(v.id)}
              <button
                type="button"
                data-testid="filter-version-chip"
                onclick={() => toggleVersion(v.id)}
                class="rounded-full border px-2.5 py-1 transition-colors {excluded
                  ? 'border-red-500/30 bg-red-500/15 text-red-300'
                  : 'border-transparent bg-white/[0.06] text-white/60'}"
              >
                {#if excluded}⊘ {/if}{v.id.replace('_', ' ')}
              </button>
            {/each}
          </div>
          <p class="mt-2 text-[10px] text-white/30">Tap to exclude a version type</p>
        {/if}
      </div>

      <!-- Explicit -->
      <div class="flex items-center justify-between rounded-2xl bg-white/[0.04] p-4">
        <div>
          <div class="text-sm font-semibold">Allow explicit</div>
          <div class="mt-0.5 text-[10px] text-white/30">Off hides songs marked explicit</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.filters.allowExplicit}
          aria-label="Allow explicit"
          data-testid="filter-explicit"
          onclick={() => (settings!.filters.allowExplicit = !settings!.filters.allowExplicit)}
          class="relative h-6 w-11 rounded-full transition-colors {settings.filters.allowExplicit
            ? 'bg-purple-500'
            : 'bg-white/15'}"
        >
          <span
            class="absolute top-0.5 size-5 rounded-full bg-white transition-all {settings.filters
              .allowExplicit
              ? 'left-[22px]'
              : 'left-0.5'}"
          ></span>
        </button>
      </div>
    </div>
  {:else}
    <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-6 text-center">
      <p class="text-sm font-semibold text-white/70">Weighting coming soon</p>
      <p class="mt-1 text-xs text-white/40">
        Star-tier, artist and genre weighting plus freshness controls land here.
      </p>
    </div>
  {/if}

  <!-- sticky CTA -->
  <div class="fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-black via-black/95 to-transparent px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-6">
    <div class="mx-auto w-full max-w-md">
      {#if saveError}
        <p class="mb-2 text-center text-xs text-red-400">{saveError}</p>
      {/if}
      <button
        type="button"
        data-testid="shuffle-cta"
        disabled={!canShuffle || saving}
        onclick={shuffleNow}
        class="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-purple-500 to-purple-700 py-3.5 font-bold text-white shadow-lg shadow-purple-900/40 transition-opacity disabled:opacity-40"
      >
        <Sparkles class="size-4.5" />
        {#if saving}
          Starting…
        {:else if !settings || previewCount == null}
          Shuffle
        {:else if previewPending}
          Shuffle <span class="opacity-60">{previewCount.toLocaleString()}…</span>
        {:else}
          Shuffle {previewCount.toLocaleString()} {previewCount === 1 ? 'song' : 'songs'}
        {/if}
      </button>
    </div>
  </div>
</main>

<PlaylistPickerSheet
  playlists={catalogue}
  {selectedIds}
  open={pickerOpen}
  loading={playlistsLoading}
  {missingScope}
  ontoggle={togglePlaylist}
  onclose={() => (pickerOpen = false)}
/>

<FilterPickerSheet
  title="Artists"
  options={filterOptions?.artists ?? []}
  open={artistPickerOpen}
  loading={optionsLoading}
  stateOf={(id) => axisState('artists', id)}
  oncycle={(o) => cycleAxis('artists', o)}
  onclose={() => (artistPickerOpen = false)}
/>

<FilterPickerSheet
  title="Genres"
  options={filterOptions?.genres ?? []}
  open={genrePickerOpen}
  loading={optionsLoading}
  stateOf={(id) => axisState('genres', id)}
  oncycle={(o) => cycleAxis('genres', o)}
  onclose={() => (genrePickerOpen = false)}
/>
