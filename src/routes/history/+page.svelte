<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { slide } from 'svelte/transition';
  import HistoryRow from '$lib/components/HistoryRow.svelte';
  import { historyBadge } from '$lib/history/badge.svelte';

  type Row = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    isrc: string | null;
    rating: number | null;
    playedAt: string;
    playCount: number;
    source: 'spotify' | 'discovery' | 'both';
  };

  type Tab = 'unrated' | 'all';

  let rows = $state<Row[]>([]);
  let unratedCount = $state(0);
  let tab = $state<Tab>('unrated');
  let loading = $state(true);
  let hasLoaded = $state(false);
  let error = $state<string | null>(null);

  // Single timestamp captured per render pass so every row's relative time is
  // consistent and stable (avoids re-reading Date.now() per row).
  const now = Date.now();

  // Abort an in-flight load when the tab flips so a slow earlier request can't
  // overwrite a newer one.
  let abort: AbortController | null = null;

  async function load() {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    loading = true;
    const qs = tab === 'all' ? '?includeRated=1' : '';
    try {
      const res = await fetch(`/api/history${qs}`, { signal: ac.signal });
      if (!res.ok) {
        error = "Couldn't load your history. Try again.";
        return;
      }
      const data = await res.json();
      if (ac.signal.aborted) return;
      rows = data.rows ?? [];
      unratedCount = typeof data.unratedCount === 'number' ? data.unratedCount : 0;
      historyBadge.set(unratedCount);
      error = null;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      error = "Couldn't load your history. Check your connection.";
    } finally {
      if (abort === ac) {
        loading = false;
        hasLoaded = true;
        abort = null;
      }
    }
  }

  function setTab(next: Tab) {
    if (tab === next) return;
    tab = next;
    void load();
  }

  function onOpen(uri: string) {
    void goto(`/library/track/${encodeURIComponent(uri)}`);
  }

  // Rows for the same recording (tapped URI + any sibling sharing its ISRC).
  // Ratings dedupe by ISRC server-side, so rating/clearing one flips them all.
  function siblingsOf(uri: string, isrc: string | null): Row[] {
    return rows.filter((r) => r.uri === uri || (isrc != null && r.isrc === isrc));
  }

  async function onRate(uri: string, stars: number) {
    const row = rows.find((r) => r.uri === uri);
    if (!row) return;
    const prev = row.rating;
    const clearing = stars === 0;
    const newRating = clearing ? null : stars;

    // Optimistic update of the tapped row.
    row.rating = newRating;
    rows = [...rows];

    try {
      const res = clearing
        ? await fetch('/api/ratings', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ spotifyTrackUri: uri }),
          })
        : await fetch('/api/ratings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ spotifyTrackUri: uri, ratingStars: stars }),
          });
      if (!res.ok) throw new Error(String(res.status));

      const siblings = siblingsOf(uri, row.isrc);

      // Badge delta across the whole ISRC group: each unrated→rated flip removes
      // one, each rated→unrated flip adds one. (For the tapped row use its prior
      // rating; siblings haven't been optimistically changed yet.)
      let delta = 0;
      for (const r of siblings) {
        const wasUnrated = (r.uri === uri ? prev : r.rating) == null;
        const nowUnrated = newRating == null;
        if (wasUnrated && !nowUnrated) delta -= 1;
        else if (!wasUnrated && nowUnrated) delta += 1;
      }
      if (delta !== 0) {
        unratedCount = Math.max(0, unratedCount + delta);
        if (delta < 0) historyBadge.decrement(-delta);
        else historyBadge.increment(delta);
      }

      if (tab === 'unrated' && newRating != null) {
        // Freshly-rated tracks (and their siblings) leave the Unrated list.
        const drop = new Set(siblings.map((r) => r.uri));
        rows = rows.filter((r) => !drop.has(r.uri));
      } else {
        // All view (or a clear): reflect the new rating on every sibling in place.
        for (const r of rows) {
          if (r.uri === uri || (row.isrc != null && r.isrc === row.isrc)) r.rating = newRating;
        }
        rows = [...rows];
      }
    } catch {
      // Revert the optimistic change.
      row.rating = prev;
      rows = [...rows];
      error = "Couldn't save that rating. Try again.";
    }
  }

  onMount(load);
</script>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-32">
  <header class="flex items-baseline justify-between gap-3">
    <h1 class="text-2xl font-extrabold">
      History
      {#if unratedCount > 0}
        <span class="text-sm font-normal text-white/40">{unratedCount} to rate</span>
      {/if}
    </h1>
  </header>

  <!-- Unrated / All toggle. Unrated is the default — the whole point is catching
       songs you listened to but haven't rated. -->
  <div
    role="tablist"
    aria-label="History filter"
    class="flex rounded-full border border-white/10 bg-white/[0.08] p-1 text-xs backdrop-blur"
  >
    {#each [{ id: 'unrated' as Tab, label: 'Unrated' }, { id: 'all' as Tab, label: 'All' }] as item (item.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        data-testid="history-tab-{item.id}"
        onclick={() => setTab(item.id)}
        class="flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 transition-colors {tab === item.id
          ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] font-semibold text-black shadow shadow-spotify-green/30'
          : 'text-white/70 hover:text-white'}"
      >
        {item.label}
        {#if item.id === 'unrated' && unratedCount > 0}
          <span class="opacity-70">{unratedCount}</span>
        {/if}
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
  {:else if rows.length === 0}
    <p class="py-8 text-center text-sm opacity-60">
      {#if tab === 'unrated'}
        You're all caught up — nothing unrated in the last 7 days.
      {:else}
        No listening history in the last 7 days.
      {/if}
    </p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each rows as row (row.uri)}
        <div transition:slide={{ duration: 200 }}>
          <HistoryRow {row} {now} onrate={onRate} onopen={onOpen} />
        </div>
      {/each}
    </div>
  {/if}
</main>
