<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ChevronLeft, ChevronDown, Star } from '@lucide/svelte';
  import LibraryRow from '$lib/components/LibraryRow.svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';
  import ShuffleButton from '$lib/components/ShuffleButton.svelte';
  import PremiumGate from '$lib/components/PremiumGate.svelte';
  import { groupSongs } from '$lib/song-group';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    labels: string[];
    songFamilyId: string | null;
    canonicalTitle: string | null;
    primaryArtistId: string | null;
    versionType: string | null;
    album: string | null;
  };

  type SongGroup = {
    key: string;
    primary: Row;       // highest-rated version, shown collapsed
    versions: Row[];    // all versions including primary, sorted by rating desc
  };

  type Sort = 'rating' | 'name';

  const artistName = $derived(page.params.name ?? '');

  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let hasLoaded = $state(false);
  let error = $state<string | null>(null);
  const SORT_KEY = 'library:artist:sort';

  function loadSort(): Sort {
    if (typeof sessionStorage === 'undefined') return 'rating';
    const v = sessionStorage.getItem(SORT_KEY);
    return v === 'name' || v === 'rating' ? v : 'rating';
  }

  let sort = $state<Sort>(loadSort());

  $effect(() => {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(SORT_KEY, sort);
    } catch {
      // ignore
    }
  });

  const playback = getPlaybackStore();
  const product = $derived(page.data.user?.product ?? 'open');

  // Collapse same-song duplicates: e.g. "Hurt" (original) + "Hurt - Acoustic"
  // share a row. Primary is the highest-rated version; variants live behind a tap.
  const songGroups = $derived.by<SongGroup[]>(() => {
    const partitioned = groupSongs(rows);
    const out = partitioned.map((group, i) => {
      const sorted = [...group].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      const primary = sorted[0];
      const key = primary.songFamilyId ?? `uri:${primary.uri}:${i}`;
      return { key, primary, versions: sorted };
    });
    if (sort === 'name') {
      out.sort((a, b) =>
        (a.primary.title ?? '').toLowerCase().localeCompare((b.primary.title ?? '').toLowerCase()),
      );
    } else {
      out.sort(
        (a, b) =>
          (b.primary.rating ?? 0) - (a.primary.rating ?? 0) ||
          (a.primary.title ?? '').toLowerCase().localeCompare((b.primary.title ?? '').toLowerCase()),
      );
    }
    return out;
  });

  // Tracks one song open at a time so the page doesn't explode when an artist
  // has many multi-version songs.
  let expandedKey = $state<string | null>(null);

  const stats = $derived.by(() => {
    const ratedGroups = songGroups.filter(
      (g) => g.primary.rating != null && g.primary.rating > 0,
    );
    const total = ratedGroups.length;
    if (total === 0) return { total: 0, avg: 0, fiveStars: 0 };
    const sum = ratedGroups.reduce((a, g) => a + (g.primary.rating ?? 0), 0);
    const fiveStars = ratedGroups.filter((g) => g.primary.rating === 5).length;
    return { total, avg: sum / total, fiveStars };
  });

  function formatVersionLabel(v: Row): string {
    if (v.versionType && v.versionType !== 'original') {
      return v.versionType.replace(/_/g, ' ');
    }
    return v.album ?? 'Original';
  }

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
    void goto(`/library/track/${encodeURIComponent(uri)}`);
  }

  function onGroupClick(group: SongGroup) {
    if (group.versions.length <= 1) {
      onRowClick(group.primary.uri);
      return;
    }
    expandedKey = expandedKey === group.key ? null : group.key;
  }

  async function getCurrentFilterUris(): Promise<readonly string[]> {
    // Shuffle the primary (highest-rated) version of each song — avoids the
    // queue containing "Hurt" + "Hurt - Acoustic" + "Hurt - Live" back to back.
    return songGroups.map((g) => g.primary.uri);
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
  {:else if songGroups.length === 0}
    <p class="py-8 text-center text-sm opacity-60">No tracks from this artist in your library.</p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each songGroups as group (group.key)}
        {@const expanded = expandedKey === group.key}
        {@const multi = group.versions.length > 1}
        {@const playingInGroup = group.versions.some((v) => playback.state.track?.uri === v.uri)}
        <div class="flex flex-col gap-1">
          <LibraryRow
            row={group.primary}
            onclick={() => onGroupClick(group)}
            isPlaying={playingInGroup}
          />

          {#if multi}
            <button
              type="button"
              data-testid="versions-toggle"
              aria-expanded={expanded}
              onclick={() => (expandedKey = expanded ? null : group.key)}
              class="ml-[4.25rem] flex w-fit items-center gap-1 self-start rounded-full px-2 py-0.5 text-[10px] font-medium text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <ChevronDown class="size-3 transition-transform {expanded ? 'rotate-180' : ''}" />
              {group.versions.length} versions
            </button>
          {/if}

          {#if multi && expanded}
            <div class="ml-[4.25rem] flex flex-col gap-1 border-l border-white/10 pl-3">
              {#each group.versions as v (v.uri)}
                <button
                  type="button"
                  data-testid="song-version"
                  data-uri={v.uri}
                  onclick={() => onRowClick(v.uri)}
                  class="flex items-center gap-2 rounded-lg bg-white/[0.03] p-2 text-left text-xs transition-colors hover:bg-white/[0.07]"
                >
                  {#if v.albumArtUrl}
                    <img
                      src={v.albumArtUrl}
                      alt=""
                      class="size-9 flex-shrink-0 rounded-md object-cover shadow shadow-black/40"
                    />
                  {:else}
                    <div class="size-9 flex-shrink-0 rounded-md bg-white/10 shadow shadow-black/40" aria-hidden="true"></div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium {playback.state.track?.uri === v.uri ? 'text-spotify-green' : 'text-white/90'}">
                      {v.title ?? 'Unknown'}
                    </div>
                    <div class="truncate text-[10px] text-white/45">{formatVersionLabel(v)}</div>
                  </div>
                  {#if v.rating != null && v.rating > 0}
                    <span class="flex flex-shrink-0 items-center gap-0.5 text-spotify-green">
                      <Star class="size-3 fill-current" />
                      <span class="text-xs font-bold tabular-nums">{v.rating}</span>
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</main>
