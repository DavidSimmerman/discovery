<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Play, Star, Loader2, Search } from '@lucide/svelte';
  import { getPlaybackStore } from '$lib/playback/player.svelte';

  type Entry = {
    uri: string;
    title: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    rating: number | null;
    versionType: string | null;
  };

  type Cover = Entry & { sourceWork?: string | null };

  let { trackUri, currentUri = null }: { trackUri: string; currentUri?: string | null } = $props();

  let loading = $state(true);
  let library = $state<Entry[]>([]);
  let catalog = $state<Entry[]>([]);

  let coverState = $state<'idle' | 'loading' | 'done' | 'unavailable'>('idle');
  let covers = $state<Cover[]>([]);
  let coverError = $state<string | null>(null);

  const playback = getPlaybackStore();

  let inflight: AbortController | null = null;

  async function load() {
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    loading = true;
    try {
      const res = await fetch(`/api/track-versions/${encodeURIComponent(trackUri)}`, {
        signal: ac.signal,
      });
      if (!res.ok) {
        library = [];
        catalog = [];
        return;
      }
      const data = (await res.json()) as { library: Entry[]; catalog: Entry[] };
      library = data.library ?? [];
      catalog = data.catalog ?? [];
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        library = [];
        catalog = [];
      }
    } finally {
      if (inflight === ac) {
        loading = false;
        inflight = null;
      }
    }
  }

  async function loadCovers() {
    if (coverState === 'loading' || coverState === 'done') return;
    coverState = 'loading';
    coverError = null;
    try {
      const res = await fetch(`/api/track-versions/${encodeURIComponent(trackUri)}/covers`);
      if (res.status === 404) {
        coverState = 'unavailable';
        return;
      }
      if (!res.ok) {
        coverError = "Couldn't load covers — try again.";
        coverState = 'idle';
        return;
      }
      const data = (await res.json()) as { covers: Cover[] };
      covers = data.covers ?? [];
      coverState = 'done';
    } catch {
      coverError = "Couldn't reach the server.";
      coverState = 'idle';
    }
  }

  function playEntry(e: Entry) {
    void playback.playTrack(e.uri, [e.uri]);
  }

  function openTrack(e: Entry) {
    if (e.rating == null) {
      // Catalog entry — playing is the most useful action; the user can rate
      // it from now-playing once it starts.
      playEntry(e);
      return;
    }
    void goto(`/library/track/${encodeURIComponent(e.uri)}`);
  }

  function versionLabel(e: Entry): string {
    if (e.versionType && e.versionType !== 'original') {
      return e.versionType.replace(/_/g, ' ');
    }
    return e.album ?? '';
  }

  // Reload when the source track changes (e.g. now-playing flips to next song).
  $effect(() => {
    if (trackUri) void load();
  });

  onMount(() => {
    return () => inflight?.abort();
  });
</script>

<section class="flex w-full flex-col gap-3" data-testid="other-versions">
  {#if loading}
    <div class="flex items-center gap-2 text-xs text-white/45">
      <Loader2 class="size-3.5 animate-spin" />
      Looking for other versions…
    </div>
  {:else if library.length === 0 && catalog.length === 0 && coverState !== 'done'}
    <div class="flex flex-col gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-white/50">Other versions</h2>
      <p class="text-xs text-white/45">No other versions found by this artist.</p>
      <button
        type="button"
        onclick={loadCovers}
        disabled={coverState === 'loading'}
        class="mt-1 flex w-fit items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
      >
        {#if coverState === 'loading'}
          <Loader2 class="size-3.5 animate-spin" />
          Searching covers…
        {:else}
          <Search class="size-3.5" />
          Find covers by other artists
        {/if}
      </button>
      {#if coverError}
        <p class="text-xs text-red-400">{coverError}</p>
      {/if}
    </div>
  {:else}
    {#if library.length > 0}
      <div class="flex flex-col gap-1.5">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-white/50">
          In your library
        </h2>
        {#each library as v (v.uri)}
          {@const playingHere = playback.state.track?.uri === v.uri}
          {@const label = versionLabel(v)}
          {@const isCurrent = currentUri === v.uri}
          <button
            type="button"
            data-testid="other-version-row"
            data-uri={v.uri}
            onclick={() => openTrack(v)}
            disabled={isCurrent}
            class="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2 text-left transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          >
            {#if v.albumArtUrl}
              <img src={v.albumArtUrl} alt="" class="size-10 flex-shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-10 flex-shrink-0 rounded-md bg-white/10" aria-hidden="true"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white'}">
                {v.title}
              </div>
              {#if label}
                <div class="truncate text-[10px] text-white/45">{label}</div>
              {/if}
            </div>
            {#if v.rating != null && v.rating > 0}
              <span class="flex flex-shrink-0 items-center gap-0.5 text-spotify-green">
                <Star class="size-3.5 fill-current" />
                <span class="text-sm font-bold tabular-nums">{v.rating}</span>
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if catalog.length > 0}
      <div class="flex flex-col gap-1.5">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-white/50">
          Catalog versions
        </h2>
        {#each catalog as v (v.uri)}
          {@const playingHere = playback.state.track?.uri === v.uri}
          {@const label = versionLabel(v)}
          <div
            class="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-left"
            data-testid="other-version-row"
            data-uri={v.uri}
          >
            {#if v.albumArtUrl}
              <img src={v.albumArtUrl} alt="" class="size-10 flex-shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-10 flex-shrink-0 rounded-md bg-white/10" aria-hidden="true"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white/80'}">
                {v.title}
              </div>
              {#if label}
                <div class="truncate text-[10px] text-white/40">{label}</div>
              {/if}
            </div>
            <button
              type="button"
              onclick={() => playEntry(v)}
              aria-label="Play"
              class="flex flex-shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/15"
            >
              <Play class="size-3 fill-current" />
              Play
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if coverState === 'idle'}
      <button
        type="button"
        onclick={loadCovers}
        class="mt-1 flex w-fit items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
      >
        <Search class="size-3.5" />
        Find covers by other artists
      </button>
    {:else if coverState === 'loading'}
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Searching covers…
      </div>
    {:else if coverState === 'done' && covers.length === 0}
      <p class="text-xs text-white/45">No covers found.</p>
    {:else if coverState === 'unavailable'}
      <p class="text-xs text-white/45">
        Couldn't look up covers — no MusicBrainz match for this recording.
      </p>
    {/if}
    {#if coverError}
      <p class="text-xs text-red-400">{coverError}</p>
    {/if}

    {#if covers.length > 0}
      <div class="flex flex-col gap-1.5">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-white/50">
          Covers by other artists
        </h2>
        {#each covers as v (v.uri)}
          {@const label = versionLabel(v)}
          <div class="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-left">
            {#if v.albumArtUrl}
              <img src={v.albumArtUrl} alt="" class="size-10 flex-shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-10 flex-shrink-0 rounded-md bg-white/10" aria-hidden="true"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-white/85">{v.title}</div>
              <div class="truncate text-[10px] text-white/45">{v.artists.join(', ') || label}</div>
            </div>
            <button
              type="button"
              onclick={() => playEntry(v)}
              aria-label="Play"
              class="flex flex-shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/15"
            >
              <Play class="size-3 fill-current" />
              Play
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>
