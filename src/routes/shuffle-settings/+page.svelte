<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Check, Library, Plus, Sparkles } from '@lucide/svelte';
  import PlaylistPickerSheet, {
    type PickerPlaylist,
  } from '$lib/components/PlaylistPickerSheet.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import type { ShuffleSettings, PlaylistSourceMode } from '$lib/server/shuffle/config';

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

  // Live CTA count: sum of per-source contributions. Approximate — overlap
  // between sources isn't deduped here (the engine dedupes for real).
  const ctaCount = $derived.by(() => {
    if (!settings) return null;
    let n = settings.sources.library ? libraryCount : 0;
    let pending = false;
    for (const p of settings.sources.playlists) {
      const s = stats[p.id];
      if (!s) {
        pending = true;
        continue;
      }
      n += p.mode === 'unrated' ? s.unrated : p.mode === 'rated' ? s.rated : s.total;
    }
    return { n, pending };
  });

  const canShuffle = $derived(
    settings != null &&
      (settings.sources.library || settings.sources.playlists.length > 0) &&
      (ctaCount == null || ctaCount.n > 0 || ctaCount.pending),
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
  {:else}
    <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-6 text-center">
      <p class="text-sm font-semibold text-white/70">
        {tab === 'filters' ? 'Filters' : 'Weighting'} coming soon
      </p>
      <p class="mt-1 text-xs text-white/40">
        {tab === 'filters'
          ? 'Artist, genre, label, version and explicit filters land here.'
          : 'Star-tier, artist and genre weighting plus freshness controls land here.'}
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
        {:else if !settings || ctaCount == null}
          Shuffle
        {:else if ctaCount.pending}
          Shuffle {ctaCount.n > 0 ? `${ctaCount.n.toLocaleString()}+` : ''} songs
        {:else}
          Shuffle {ctaCount.n.toLocaleString()} {ctaCount.n === 1 ? 'song' : 'songs'}
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
