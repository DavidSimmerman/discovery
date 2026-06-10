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
  import { DEFAULT_SAMPLER_CONFIG } from '$lib/shuffle/defaults';
  import type {
    ShuffleSettings,
    PlaylistSourceMode,
    FilterEntry,
  } from '$lib/server/shuffle/config';
  import type { RatingTier } from '$lib/server/shuffle/sampler';

  const playback = getPlaybackStore();

  type Tab = 'sources' | 'filters' | 'weighting';
  let tab = $state<Tab>('sources');

  let settings = $state<ShuffleSettings | null>(null);
  let libraryCount = $state(0);
  let discoveryCount = $state(0);
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
      discoveryCount = json.discoveryCount ?? 0;
      activePresetId = json.presetId ?? null;
      void loadPresets(); // pill needs names even before the menu opens
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

  function toggleDiscovery() {
    if (!settings) return;
    settings.sources.discovery = !settings.sources.discovery;
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
    // Weighting needs the same catalogue: boost rows resolve names from it.
    if (tab === 'filters' || tab === 'weighting') void loadFilterOptions();
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

  // ---- presets -------------------------------------------------------------------
  type Preset = { id: string; name: string; updatedAt: string };
  let presets = $state<Preset[]>([]);
  let activePresetId = $state<string | null>(null);
  let presetMenuOpen = $state(false);
  // Row whose ⋯ actions are expanded; 'save-as' | preset id for the name input.
  let presetActionsId = $state<string | null>(null);
  let presetEditing = $state<'save-as' | string | null>(null);
  let presetNameInput = $state('');
  let presetBusy = $state(false);
  let presetError = $state<string | null>(null);

  const activePresetName = $derived(
    presets.find((p) => p.id === activePresetId)?.name ?? null,
  );

  async function loadPresets() {
    try {
      const res = await fetch('/api/shuffle/presets');
      if (res.ok) presets = (await res.json()).presets;
    } catch {
      // pill just reads "Presets"; the menu shows an empty list
    }
  }

  function togglePresetMenu() {
    presetMenuOpen = !presetMenuOpen;
    presetActionsId = null;
    presetEditing = null;
    presetError = null;
  }

  async function applyPreset(id: string) {
    if (presetBusy) return;
    presetBusy = true;
    presetError = null;
    try {
      // Flush (and cancel) any pending autosave first, so a stale PUT can't
      // land after the apply and overwrite the preset's settings.
      if (!(await saveSettings())) throw new Error('flush failed');
      const res = await fetch(`/api/shuffle/presets/${id}/apply`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      settings = json.settings;
      // The server just persisted exactly this — don't echo it back.
      lastSaved = JSON.stringify({ settings: json.settings });
      activePresetId = id;
      presetMenuOpen = false;
    } catch {
      presetError = "Couldn't apply that preset.";
    } finally {
      presetBusy = false;
    }
  }

  async function savePresetAs() {
    const name = presetNameInput.trim();
    if (!name || !settings || presetBusy) return;
    presetBusy = true;
    presetError = null;
    try {
      if (!(await saveSettings())) throw new Error('flush failed'); // serialize vs autosave
      const res = await fetch('/api/shuffle/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, settings }),
      });
      if (res.status === 409) {
        presetError = 'That name is already taken.';
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const { preset } = await res.json();
      presets = [preset, ...presets];
      presetEditing = null;
      presetNameInput = '';
      // The new preset IS the current settings — link the session to it, and
      // only show it as active once the server agrees. (Local `settings` is
      // left alone: any mid-flight edit re-saves via the autosave debounce.)
      if (await linkPreset(preset.id)) activePresetId = preset.id;
    } catch {
      presetError = "Couldn't save the preset.";
    } finally {
      presetBusy = false;
    }
  }

  // Point shuffle_sessions.preset_id at a preset whose blob matches the
  // current settings. Apply is idempotent here — it re-persists the same blob.
  async function linkPreset(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/shuffle/presets/${id}/apply`, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function renamePreset(id: string) {
    const name = presetNameInput.trim();
    if (!name || presetBusy) return;
    presetBusy = true;
    presetError = null;
    try {
      const res = await fetch(`/api/shuffle/presets/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.status === 409) {
        presetError = 'That name is already taken.';
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const { preset } = await res.json();
      presets = presets.map((p) => (p.id === id ? preset : p));
      presetEditing = null;
      presetActionsId = null;
      presetNameInput = '';
    } catch {
      presetError = "Couldn't rename the preset.";
    } finally {
      presetBusy = false;
    }
  }

  // Overwrite the preset's blob with the current live settings.
  async function resavePreset(id: string) {
    if (!settings || presetBusy) return;
    presetBusy = true;
    presetError = null;
    try {
      if (!(await saveSettings())) throw new Error('flush failed'); // serialize vs autosave
      const res = await fetch(`/api/shuffle/presets/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error(String(res.status));
      presetActionsId = null;
      if (await linkPreset(id)) activePresetId = id;
    } catch {
      presetError = "Couldn't update the preset.";
    } finally {
      presetBusy = false;
    }
  }

  async function deletePreset(id: string) {
    if (presetBusy) return;
    presetBusy = true;
    presetError = null;
    try {
      const res = await fetch(`/api/shuffle/presets/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      presets = presets.filter((p) => p.id !== id);
      if (activePresetId === id) activePresetId = null; // server FK already nulled it
      presetActionsId = null;
    } catch {
      presetError = "Couldn't delete the preset.";
    } finally {
      presetBusy = false;
    }
  }

  // ---- weighting (soft sampler knobs) ------------------------------------------
  const TIERS: { key: RatingTier; label: string }[] = [
    { key: '1', label: '1★' },
    { key: '2', label: '2★' },
    { key: '3', label: '3★' },
    { key: '4', label: '4★' },
    { key: '5', label: '5★' },
    { key: 'unrated', label: 'unrated' },
  ];

  function setTierWeight(tier: RatingTier, value: number) {
    if (!settings) return;
    settings.sampler.tierWeights[tier] = Math.max(0, Math.min(100, value));
  }

  // Drag anywhere in a bar's track; weight follows the pointer in 5-steps.
  function tierDrag(e: PointerEvent, tier: RatingTier) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const apply = (clientY: number) => {
      const frac = 1 - (clientY - rect.top) / rect.height;
      setTierWeight(tier, Math.round(Math.max(0, Math.min(1, frac)) * 20) * 5);
    };
    apply(e.clientY);
    const move = (ev: PointerEvent) => apply(ev.clientY);
    const done = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  }

  function tierKeydown(e: KeyboardEvent, tier: RatingTier) {
    if (!settings) return;
    const cur = settings.sampler.tierWeights[tier];
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      setTierWeight(tier, cur + 5);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setTierWeight(tier, cur - 5);
    }
  }

  // Boost axes map straight onto SamplerConfig.filters (id → 0..100 slider,
  // 50 = neutral, 0 = never play). New entries start at 75 (1.5×).
  type BoostAxis = 'artists' | 'genres' | 'labels';
  const BOOST_DEFAULT = 75;
  let boostPicker = $state<BoostAxis | null>(null);

  const BOOST_AXES: { axis: BoostAxis; title: string; empty: string }[] = [
    { axis: 'artists', title: 'Artist boosts', empty: 'Play favorite artists more (or less)' },
    { axis: 'genres', title: 'Genre boosts', empty: 'Lean into a genre' },
    { axis: 'labels', title: 'Label boosts', empty: 'Weight by your own labels' },
  ];

  function boostOptions(axis: BoostAxis): FilterOption[] {
    if (!filterOptions) return [];
    return axis === 'artists'
      ? filterOptions.artists
      : axis === 'genres'
        ? filterOptions.genres
        : filterOptions.labels;
  }

  // Genres are their own ids; artists/labels resolve via the catalogue. A
  // boosted id that's left the catalogue still renders (and can be removed).
  function boostName(axis: BoostAxis, id: string): string {
    if (axis === 'genres') return id;
    return boostOptions(axis).find((o) => o.id === id)?.name ?? id;
  }

  function boostEntries(axis: BoostAxis): { id: string; name: string; value: number }[] {
    const map = settings?.sampler.filters[axis] ?? {};
    return Object.entries(map).map(([id, value]) => ({ id, name: boostName(axis, id), value }));
  }

  function toggleBoost(axis: BoostAxis, opt: { id: string }) {
    if (!settings) return;
    const map = { ...(settings.sampler.filters[axis] ?? {}) };
    if (opt.id in map) delete map[opt.id];
    else map[opt.id] = BOOST_DEFAULT;
    settings.sampler.filters[axis] = map;
  }

  function setBoost(axis: BoostAxis, id: string, value: number) {
    if (!settings) return;
    settings.sampler.filters[axis] = { ...(settings.sampler.filters[axis] ?? {}), [id]: value };
  }

  function multiplierLabel(value: number): string {
    return value === 0 ? 'never' : `${(value / 50).toFixed(1)}×`;
  }

  // Freshness preset lists; a persisted value outside the list is prepended so
  // the select never shows blank.
  const withCurrent = (presets: number[], cur: number) =>
    presets.includes(cur) ? presets : [cur, ...presets];
  const COOLDOWN_SONGS = [10, 25, 50, 100, 200];
  const COOLDOWN_HOURS = [1, 3, 6, 12, 24, 48];
  const DAILY_CAPS = [1, 2, 3, 5];

  function resetWeighting() {
    if (!settings) return;
    const def = structuredClone(DEFAULT_SAMPLER_CONFIG);
    settings.sampler.tierWeights = def.tierWeights;
    settings.sampler.filters = def.filters;
    settings.sampler.gates = def.gates;
    settings.sampler.discovery = def.discovery;
  }

  function discoveryAmountLabel(pct: number): string {
    if (pct <= 0) return 'off';
    if (pct >= 100) return 'every song';
    return `~1 in ${Math.round(100 / pct)} songs`;
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
      (settings.sources.library ||
        settings.sources.playlists.length > 0 ||
        settings.sources.discovery) &&
      (previewCount == null || previewCount > 0 || previewPending),
  );

  // ---- save + shuffle ----------------------------------------------------------
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSaved = ''; // serialized form of what the server has
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // All saves run strictly one-at-a-time through this chain. Without it, an
  // in-flight autosave could complete AFTER a preset apply and clobber the
  // just-applied settings (server-side) or the pill highlight (client-side).
  let saveChain: Promise<boolean> = Promise.resolve(true);
  function saveSettings(): Promise<boolean> {
    saveChain = saveChain.then(doSaveSettings, doSaveSettings);
    return saveChain;
  }

  async function doSaveSettings(): Promise<boolean> {
    // Never PUT before the initial load resolves — {settings: null} would
    // normalize to defaults server-side and wipe the user's saved sources.
    if (!settings) return true;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const body = JSON.stringify({ settings });
    if (body === lastSaved) return true;
    try {
      const res = await fetch('/api/shuffle/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        // Survives an immediate navigation (e.g. tapping Back right after a toggle).
        keepalive: true,
      });
      if (res.ok) {
        lastSaved = body;
        // The server dropped the preset link on this manual save (the settings
        // diverged) — mirror that so the pill stops claiming the preset.
        activePresetId = null;
      }
      return res.ok;
    } catch {
      return false;
    }
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
    <h1 class="flex-1 text-xl font-extrabold">Shuffle settings</h1>

    <!-- preset pill + dropdown (z-50: the pill stays clickable above the
         close-on-outside-click backdrop, so tapping it again closes the menu) -->
    <div class="relative z-50 flex-shrink-0">
      <button
        type="button"
        data-testid="preset-pill"
        aria-haspopup="menu"
        aria-expanded={presetMenuOpen}
        onclick={togglePresetMenu}
        class="relative z-50 max-w-36 truncate rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors {presetMenuOpen ||
        activePresetName
          ? 'border-purple-400/40 bg-purple-500/20 text-purple-200'
          : 'border-white/15 bg-white/[0.08] text-white/80'}"
      >
        {activePresetName ?? 'Presets'}
        {presetMenuOpen ? '▴' : '▾'}
      </button>

      {#if presetMenuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={() => (presetMenuOpen = false)} aria-hidden="true"></div>
        <div
          data-testid="preset-menu"
          class="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-white/10 bg-[#1a1a20] p-1.5 text-sm shadow-2xl shadow-black/60"
        >
          {#if presetError}
            <p class="px-3 py-1.5 text-xs text-red-400">{presetError}</p>
          {/if}
          {#if presets.length === 0}
            <p class="px-3 py-2 text-xs text-white/40">No presets yet — save the current settings below.</p>
          {/if}
          {#each presets as p (p.id)}
            <div>
              <div class="flex items-center">
                <button
                  type="button"
                  data-testid="preset-row"
                  onclick={() => applyPreset(p.id)}
                  class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors {p.id ===
                  activePresetId
                    ? 'bg-purple-500/15 font-semibold text-purple-200'
                    : 'text-white/80 hover:bg-white/[0.06]'}"
                >
                  <span class="truncate">{p.name}</span>
                  {#if p.id === activePresetId}<Check class="size-3.5 flex-shrink-0" />{/if}
                </button>
                <button
                  type="button"
                  aria-label="Actions for {p.name}"
                  data-testid="preset-actions"
                  onclick={() => {
                    presetActionsId = presetActionsId === p.id ? null : p.id;
                    presetEditing = null;
                  }}
                  class="px-2 text-white/40"
                >
                  ⋯
                </button>
              </div>
              {#if presetActionsId === p.id}
                {#if presetEditing === p.id}
                  <div class="flex gap-1.5 px-2 pb-2">
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      type="text"
                      data-testid="preset-name-input"
                      bind:value={presetNameInput}
                      autofocus
                      onkeydown={(e) => e.key === 'Enter' && renamePreset(p.id)}
                      class="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400/50"
                    />
                    <button
                      type="button"
                      data-testid="preset-name-save"
                      onclick={() => renamePreset(p.id)}
                      class="rounded-lg bg-purple-500/30 px-3 text-xs font-semibold text-purple-200"
                    >
                      Save
                    </button>
                  </div>
                {:else}
                  <div class="flex gap-1 px-2 pb-2 text-[11px]">
                    <button
                      type="button"
                      data-testid="preset-resave"
                      onclick={() => resavePreset(p.id)}
                      class="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-white/70"
                    >
                      Re-save current
                    </button>
                    <button
                      type="button"
                      data-testid="preset-rename"
                      onclick={() => {
                        presetEditing = p.id;
                        presetNameInput = p.name;
                      }}
                      class="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-white/70"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid="preset-delete"
                      onclick={() => deletePreset(p.id)}
                      class="rounded-lg bg-red-500/10 px-2.5 py-1.5 text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          {/each}
          <div class="my-1 h-px bg-white/10"></div>
          {#if presetEditing === 'save-as'}
            <div class="flex gap-1.5 p-1.5">
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                data-testid="preset-name-input"
                bind:value={presetNameInput}
                placeholder="Preset name"
                autofocus
                onkeydown={(e) => e.key === 'Enter' && savePresetAs()}
                class="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-2.5 py-1.5 text-xs placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
              />
              <button
                type="button"
                data-testid="preset-name-save"
                onclick={savePresetAs}
                disabled={presetBusy}
                class="rounded-lg bg-purple-500/30 px-3 text-xs font-semibold text-purple-200 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          {:else}
            <button
              type="button"
              data-testid="preset-save-as"
              onclick={() => {
                presetEditing = 'save-as';
                presetNameInput = '';
                presetActionsId = null;
              }}
              class="w-full rounded-xl px-3 py-2.5 text-left text-white/50 transition-colors hover:bg-white/[0.06]"
            >
              ＋ Save current as…
            </button>
          {/if}
        </div>
      {/if}
    </div>
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

      <!-- Discovery mode -->
      <button
        type="button"
        data-testid="source-discovery"
        onclick={toggleDiscovery}
        class="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-colors {settings
          .sources.discovery
          ? 'border border-purple-400/40 bg-purple-500/[0.07]'
          : 'bg-white/[0.04] hover:bg-white/[0.07]'}"
      >
        <span class="grid size-10 flex-shrink-0 place-items-center rounded-lg bg-white/[0.06]">
          <Sparkles class="size-5 text-white/70" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold">Discovery mode</div>
          <div class="text-xs text-white/45">
            {#if discoveryCount > 0}
              New songs similar to your favorites · {discoveryCount.toLocaleString()}
            {:else}
              New songs not in your library — rate more songs 4★+ to grow the pool
            {/if}
          </div>
        </div>
        <div
          class="grid size-5 flex-shrink-0 place-items-center rounded-md {settings.sources.discovery
            ? 'bg-purple-500 text-white'
            : 'border border-white/25'}"
        >
          {#if settings.sources.discovery}<Check class="size-3.5" strokeWidth={3} />{/if}
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
    {@const gates = settings.sampler.gates}
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between px-1">
        <p class="text-xs text-white/40">Soft preferences — what plays <i>more</i></p>
        <button
          type="button"
          data-testid="weight-reset"
          onclick={resetWeighting}
          class="text-xs font-medium text-white/50 transition-colors hover:text-white/80"
        >
          Reset
        </button>
      </div>

      <!-- star tiers -->
      <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="weight-tiers">
        <div class="mb-3 flex items-center justify-between">
          <span class="text-sm font-semibold">By star rating</span>
          <span class="text-[10px] text-white/30">drag bars · 0 = never</span>
        </div>
        <div class="flex items-end gap-2">
          {#each TIERS as t (t.key)}
            {@const w = settings.sampler.tierWeights[t.key]}
            <div class="flex flex-1 flex-col items-center gap-1.5">
              <span class="text-[9px] tabular-nums {w === 0 ? 'text-red-300/70' : 'text-white/40'}">{w}</span>
              <div
                role="slider"
                tabindex="0"
                aria-label="Weight for {t.label}"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={w}
                data-testid="weight-tier-{t.key}"
                onpointerdown={(e) => tierDrag(e, t.key)}
                onkeydown={(e) => tierKeydown(e, t.key)}
                class="relative h-24 w-full cursor-pointer touch-none select-none rounded-md bg-white/[0.03]"
              >
                <div
                  class="absolute inset-x-0 bottom-0 rounded-t-md {t.key === 'unrated'
                    ? 'bg-white/25'
                    : 'bg-gradient-to-t from-purple-700 to-purple-500'}"
                  style="height:{Math.max(w, 2)}%; opacity:{w === 0 ? 0.25 : 0.35 + (w / 100) * 0.65}"
                ></div>
              </div>
              <span class="text-[10px] text-white/40">{t.label}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- artist / genre / label boosts -->
      {#each BOOST_AXES as { axis, title, empty } (axis)}
        {@const entries = boostEntries(axis)}
        <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="boost-{axis}">
          <div class="mb-2.5 flex items-center justify-between">
            <span class="text-sm font-semibold">{title}</span>
            <button
              type="button"
              data-testid="boost-{axis}-add"
              onclick={() => (boostPicker = axis)}
              class="text-xs font-medium text-purple-300"
            >
              + add
            </button>
          </div>
          {#if entries.length === 0}
            <p class="text-xs text-white/30">{empty} — tap “+ add”</p>
          {:else}
            <div class="flex flex-col gap-3">
              {#each entries as entry (entry.id)}
                <div data-testid="boost-row">
                  <div class="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span class="truncate">{entry.name}</span>
                    <span class="flex flex-shrink-0 items-center gap-2">
                      <span
                        data-testid="boost-mult"
                        class="font-medium tabular-nums {entry.value === 0
                          ? 'text-red-300'
                          : entry.value < 50
                            ? 'text-white/50'
                            : 'text-purple-300'}"
                      >
                        {multiplierLabel(entry.value)}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove {entry.name}"
                        onclick={() => toggleBoost(axis, entry)}
                      >
                        <X class="size-3.5 text-white/40" />
                      </button>
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={entry.value}
                    aria-label="Boost for {entry.name}"
                    oninput={(e) => setBoost(axis, entry.id, Number(e.currentTarget.value))}
                    class="w-full accent-purple-500"
                  />
                </div>
              {/each}
            </div>
            <p class="mt-2 text-[10px] text-white/30">50 = neutral · 100 = 2× as often · 0 = never</p>
          {/if}
        </div>
      {/each}

      <!-- discovery amount -->
      <div class="rounded-2xl bg-white/[0.04] p-4" data-testid="weight-discovery">
        <div class="mb-1 flex justify-between text-sm">
          <span class="font-semibold">Discovery mode</span>
          <span class="text-xs text-white/40" data-testid="weight-discovery-label">
            {discoveryAmountLabel(settings.sampler.discovery?.pct ?? 0)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={settings.sampler.discovery?.pct ?? 0}
          aria-label="Discovery amount"
          data-testid="weight-discovery-pct"
          oninput={(e) =>
            (settings!.sampler.discovery = { pct: Number(e.currentTarget.value) })}
          class="mt-1 w-full accent-purple-500"
        />
        <p class="mt-1.5 text-[10px] text-white/30">
          How often a brand-new song is mixed in{settings.sources.discovery
            ? ''
            : ' — needs the Discovery mode source on'}
        </p>
      </div>

      <!-- freshness -->
      <p class="mt-2 px-1 text-[11px] font-bold uppercase tracking-wide text-white/40">Freshness</p>
      <div class="rounded-2xl bg-white/[0.04] text-sm divide-y divide-white/5">
        <div class="flex items-center justify-between gap-3 p-3.5">
          <span class="flex-1">No repeat within</span>
          <select
            data-testid="cooldown-count-n"
            disabled={!gates.cooldownCount.enabled}
            value={gates.cooldownCount.n}
            onchange={(e) => (gates.cooldownCount.n = Number(e.currentTarget.value))}
            class="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-xs disabled:opacity-40"
          >
            {#each withCurrent(COOLDOWN_SONGS, gates.cooldownCount.n) as n (n)}
              <option value={n}>{n} songs</option>
            {/each}
          </select>
          <button
            type="button"
            role="switch"
            aria-checked={gates.cooldownCount.enabled}
            aria-label="No repeat within songs"
            data-testid="cooldown-count-toggle"
            onclick={() => (gates.cooldownCount.enabled = !gates.cooldownCount.enabled)}
            class="relative h-6 w-11 flex-shrink-0 rounded-full transition-colors {gates.cooldownCount.enabled
              ? 'bg-purple-500'
              : 'bg-white/15'}"
          >
            <span
              class="absolute top-0.5 size-5 rounded-full bg-white transition-all {gates.cooldownCount.enabled
                ? 'left-[22px]'
                : 'left-0.5'}"
            ></span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-3 p-3.5">
          <span class="flex-1">No repeat within</span>
          <select
            data-testid="cooldown-time-hours"
            disabled={!gates.cooldownTime.enabled}
            value={gates.cooldownTime.hours}
            onchange={(e) => (gates.cooldownTime.hours = Number(e.currentTarget.value))}
            class="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-xs disabled:opacity-40"
          >
            {#each withCurrent(COOLDOWN_HOURS, gates.cooldownTime.hours) as h (h)}
              <option value={h}>{h} {h === 1 ? 'hour' : 'hours'}</option>
            {/each}
          </select>
          <button
            type="button"
            role="switch"
            aria-checked={gates.cooldownTime.enabled}
            aria-label="No repeat within hours"
            data-testid="cooldown-time-toggle"
            onclick={() => (gates.cooldownTime.enabled = !gates.cooldownTime.enabled)}
            class="relative h-6 w-11 flex-shrink-0 rounded-full transition-colors {gates.cooldownTime.enabled
              ? 'bg-purple-500'
              : 'bg-white/15'}"
          >
            <span
              class="absolute top-0.5 size-5 rounded-full bg-white transition-all {gates.cooldownTime.enabled
                ? 'left-[22px]'
                : 'left-0.5'}"
            ></span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-3 p-3.5">
          <span class="flex-1">Daily cap per song</span>
          <select
            data-testid="daily-cap-max"
            disabled={!gates.dailyCap.enabled}
            value={gates.dailyCap.max}
            onchange={(e) => (gates.dailyCap.max = Number(e.currentTarget.value))}
            class="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-xs disabled:opacity-40"
          >
            {#each withCurrent(DAILY_CAPS, gates.dailyCap.max) as m (m)}
              <option value={m}>{m}×</option>
            {/each}
          </select>
          <button
            type="button"
            role="switch"
            aria-checked={gates.dailyCap.enabled}
            aria-label="Daily cap per song"
            data-testid="daily-cap-toggle"
            onclick={() => (gates.dailyCap.enabled = !gates.dailyCap.enabled)}
            class="relative h-6 w-11 flex-shrink-0 rounded-full transition-colors {gates.dailyCap.enabled
              ? 'bg-purple-500'
              : 'bg-white/15'}"
          >
            <span
              class="absolute top-0.5 size-5 rounded-full bg-white transition-all {gates.dailyCap.enabled
                ? 'left-[22px]'
                : 'left-0.5'}"
            ></span>
          </button>
        </div>
      </div>
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
        class="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-purple-500 to-purple-700 py-3.5 font-bold text-white shadow-lg shadow-purple-900/40 transition-colors disabled:from-purple-950 disabled:to-purple-950 disabled:text-white/40 disabled:shadow-none"
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

<!-- Boost picker: same sheet, toggle semantics (selected = boosted at 1.5×). -->
<FilterPickerSheet
  title={BOOST_AXES.find((a) => a.axis === boostPicker)?.title ?? ''}
  options={boostPicker ? boostOptions(boostPicker) : []}
  open={boostPicker !== null}
  loading={optionsLoading}
  stateOf={(id) =>
    boostPicker && settings?.sampler.filters[boostPicker]?.[id] !== undefined ? 'include' : null}
  oncycle={(o) => boostPicker && toggleBoost(boostPicker, o)}
  onclose={() => (boostPicker = null)}
  hint="tap to add or remove"
/>
