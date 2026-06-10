<script lang="ts">
  // Tabbed panel that lives on /now-playing under the transport. Four tabs:
  //   queue    — Spotify's REAL live queue (read-only; car mode hands Spotify a
  //              real context, so its queue is the source of truth — edits happen
  //              in Spotify itself). Visible only while sampling.
  //   versions — library + catalog versions of the current track
  //   artist   — artist stats (avg/rating/rank) + top unrated tracks (Last.fm
  //              playcount, lazy) + the artist's rated tracks in the library
  //   covers   — MusicBrainz-backed covers; kept lazy (external hop)
  //
  // Tab click triggers the fetch for that tab. Counts for versions + artist
  // preload on track change so the tab pills show numbers without the user
  // opening them. Covers stays uncounted by design.

  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Play, Star, Loader2 } from '@lucide/svelte';
  import OpenInSpotifyLink from '$lib/components/OpenInSpotifyLink.svelte';
  import { formatPlays } from '$lib/format';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  type Entry = {
    uri: string;
    title: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    rating: number | null;
    versionType: string | null;
  };

  type LibraryRow = {
    uri: string;
    title: string | null;
    artists: string[];
    albumArtUrl: string | null;
    rating: number | null;
    album: string | null;
    plays: number;
  };

  type TrackMeta = {
    uri: string;
    title: string | null;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
  };

  type SpotifyQueueItem = { uri: string; name: string | null; artists: string[]; albumArtUrl?: string | null };

  type TopUnratedTrack = {
    uri: string;
    title: string;
    album: string | null;
    albumArtUrl: string | null;
    playcount: number;
    rank: number;
  };
  type ArtistStats = { avg: number; rating: number; rank: number; total: number; count: number };
  type DiscoveryData = { stats: ArtistStats | null; topUnrated: TopUnratedTrack[] };

  type Tab = 'queue' | 'versions' | 'artist' | 'covers';

  let {
    trackUri,
    artistName,
    playback,
    showQueue = true,
  }: { trackUri: string; artistName: string; playback: PlaybackStore; showQueue?: boolean } =
    $props();

  // The Queue tab is now-playing-only (it mirrors Spotify's live sampler queue).
  // Surfaces that don't sample (e.g. the song details page) pass showQueue=false.
  // showQueue is effectively constant per surface, so capture it once for the
  // initial tab (untrack avoids the "only captures initial value" warning).
  let activeTab = $state<Tab>(untrack(() => (showQueue ? 'queue' : 'versions')));
  let loadedFor = $state<string | null>(null);

  // Versions / Artist data (preloaded on track change). null = not loaded yet.
  let versionsData = $state<{ library: Entry[]; catalog: Entry[] } | null>(null);
  let artistData = $state<LibraryRow[] | null>(null);
  // "In your library" list: collapsed to 10 rows by default; Show all expands,
  // and a sticky Hide pill lets you collapse again from anywhere in the list.
  const ARTIST_LIST_COLLAPSED = 10;
  let artistListExpanded = $state(false);

  // Artist-tab discovery (stats + top unrated). Lazy — loaded when the Artist
  // tab is opened, keyed by artist (not track) so same-artist track changes keep
  // it. The lookup can hit Last.fm + Spotify, so it's never preloaded.
  let discoveryData = $state<DiscoveryData | null>(null);
  let discoveryState = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  let discoveryFor = $state<string | null>(null);
  let discoveryAc: AbortController | null = null;

  // Covers data (lazy, click-triggered).
  type CoverState = 'idle' | 'loading' | 'done' | 'unavailable' | 'error';
  let coverState = $state<CoverState>('idle');
  let covers = $state<Entry[]>([]);
  let coverError = $state<string | null>(null);

  // Spotify's REAL live queue (read-only). queueMeta holds album art hydrated
  // from our tracks table (the Spotify queue endpoint returns name+artists but
  // no art).
  type QueueState = 'idle' | 'loading' | 'done' | 'error';
  let spotifyQueue = $state<SpotifyQueueItem[]>([]);
  let queueState = $state<QueueState>('idle');
  let queueMeta = $state<Map<string, TrackMeta>>(new Map());

  // Per-tab fetch controllers so a track-change abort doesn't leak.
  let versionsAc: AbortController | null = null;
  let artistAc: AbortController | null = null;
  let queueAc: AbortController | null = null;
  let queueMetaAc: AbortController | null = null;

  const isSampling = $derived(playback.isSampling);
  const versionsCount = $derived(
    versionsData ? versionsData.library.length + versionsData.catalog.length : null,
  );
  const artistCount = $derived(artistData ? artistData.length : null);
  const queueCount = $derived(queueState === 'done' ? spotifyQueue.length : null);

  // Reload preloads + reset lazy state when the source track changes. Guard on
  // loadedFor so we don't re-fire when trackUri reactive churn fires the effect
  // with the same URI.
  $effect(() => {
    const uri = trackUri;
    if (!uri || uri === loadedFor) return;
    loadedFor = uri;
    resetForUri();
    void loadVersions(uri);
    void loadArtist(artistName);
    // Preload discovery (stats + top unrated) as soon as the track plays so the
    // Artist tab is ready when opened — no late pop-in. Keyed by artist, so
    // consecutive tracks by the same artist reuse the in-flight/loaded result.
    if (discoveryFor !== artistName) void loadDiscovery(artistName);
    // Refresh Spotify's queue too — it shifts as playback advances.
    if (isSampling && showQueue) void loadSpotifyQueue();
  });

  // Default tab follows sampler state: sampling → queue, otherwise → versions.
  // Only flips when the user hasn't manually picked a different tab.
  let userPickedTab = $state(false);
  $effect(() => {
    if (userPickedTab) return;
    activeTab = isSampling && showQueue ? 'queue' : 'versions';
  });

  function resetForUri(): void {
    versionsAc?.abort();
    artistAc?.abort();
    versionsData = null;
    artistData = null;
    coverState = 'idle';
    covers = [];
    coverError = null;
    // Queue metadata cache is per-uri-content, not per-current-track — keep it.
  }

  async function loadVersions(uri: string): Promise<void> {
    versionsAc?.abort();
    const ac = new AbortController();
    versionsAc = ac;
    try {
      const res = await fetch(`/api/track-versions/${encodeURIComponent(uri)}`, { signal: ac.signal });
      // Stale-write guard: between fetch dispatch and response, trackUri may
      // have changed (rapid sampler advance). Only commit if we're still the
      // active controller for the still-current URI.
      if (versionsAc !== ac || trackUri !== uri) return;
      if (!res.ok) { versionsData = { library: [], catalog: [] }; return; }
      const data = (await res.json()) as { library: Entry[]; catalog: Entry[] };
      if (versionsAc !== ac || trackUri !== uri) return;
      versionsData = { library: data.library ?? [], catalog: data.catalog ?? [] };
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (versionsAc === ac && trackUri === uri) versionsData = { library: [], catalog: [] };
    }
  }

  async function loadArtist(name: string): Promise<void> {
    artistAc?.abort();
    artistListExpanded = false; // new artist → back to the collapsed view
    const trimmed = (name ?? '').trim();
    if (trimmed === '') { artistData = []; return; }
    const ac = new AbortController();
    artistAc = ac;
    // Snapshot the URI this fetch is bound to so a rapid track change doesn't
    // let an in-flight artist fetch paint the wrong now-playing track.
    const uriAtStart = trackUri;
    try {
      const res = await fetch(
        `/api/library?artist=${encodeURIComponent(trimmed)}&sort=top`,
        { signal: ac.signal },
      );
      if (artistAc !== ac || trackUri !== uriAtStart) return;
      if (!res.ok) { artistData = []; return; }
      const data = (await res.json()) as { rows: LibraryRow[] };
      if (artistAc !== ac || trackUri !== uriAtStart) return;
      artistData = data.rows ?? [];
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (artistAc === ac && trackUri === uriAtStart) artistData = [];
    }
  }

  async function loadDiscovery(name: string): Promise<void> {
    discoveryAc?.abort();
    const trimmed = (name ?? '').trim();
    discoveryFor = trimmed;
    if (trimmed === '') {
      discoveryData = { stats: null, topUnrated: [] };
      discoveryState = 'done';
      return;
    }
    const ac = new AbortController();
    discoveryAc = ac;
    discoveryState = 'loading';
    discoveryData = null; // drop the previous artist's data so it can't flash
    try {
      const res = await fetch(
        `/api/library/artist/${encodeURIComponent(trimmed)}/discovery`,
        { signal: ac.signal },
      );
      if (discoveryAc !== ac) return;
      if (!res.ok) { discoveryState = 'error'; return; }
      const data = (await res.json()) as DiscoveryData;
      if (discoveryAc !== ac) return;
      discoveryData = { stats: data.stats ?? null, topUnrated: data.topUnrated ?? [] };
      discoveryState = 'done';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (discoveryAc === ac) discoveryState = 'error';
    }
  }

  async function loadSpotifyQueue(): Promise<void> {
    queueAc?.abort();
    const ac = new AbortController();
    queueAc = ac;
    if (spotifyQueue.length === 0) queueState = 'loading';
    try {
      const res = await fetch('/api/spotify/queue', { signal: ac.signal });
      if (queueAc !== ac) return;
      if (!res.ok) { queueState = 'error'; return; }
      const data = (await res.json()) as { queue: SpotifyQueueItem[] };
      if (queueAc !== ac) return;
      spotifyQueue = (data.queue ?? []).filter((t) => t.uri);
      queueState = 'done';
      // Hydrate album art for any queue URIs we don't have yet.
      const missing = spotifyQueue.filter((t) => !t.albumArtUrl && !queueMeta.has(t.uri)).map((t) => t.uri);
      if (missing.length > 0) void hydrateArt(missing);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (queueAc === ac) queueState = 'error';
    }
  }

  async function hydrateArt(missing: readonly string[]): Promise<void> {
    queueMetaAc?.abort();
    const ac = new AbortController();
    queueMetaAc = ac;
    try {
      const res = await fetch(
        `/api/tracks?uris=${encodeURIComponent(missing.slice(0, 50).join(','))}`,
        { signal: ac.signal },
      );
      if (queueMetaAc !== ac || !res.ok) return;
      const data = (await res.json()) as { tracks: TrackMeta[] };
      const next = new Map(queueMeta);
      for (const t of data.tracks) next.set(t.uri, t);
      queueMeta = next;
    } catch {
      /* art is best-effort; rows fall back to a placeholder box */
    }
  }

  async function loadCovers(): Promise<void> {
    if (coverState === 'loading' || coverState === 'done') return;
    coverState = 'loading';
    coverError = null;
    // Snapshot the URI so a track change mid-MusicBrainz-hop doesn't paint
    // the previous track's covers under the new now-playing.
    const uriAtStart = trackUri;
    try {
      const res = await fetch(`/api/track-versions/${encodeURIComponent(uriAtStart)}/covers`);
      if (trackUri !== uriAtStart) return;
      if (res.status === 404) { coverState = 'unavailable'; return; }
      if (!res.ok) { coverError = "Couldn't load covers — try again."; coverState = 'error'; return; }
      const data = (await res.json()) as { covers: Entry[] };
      if (trackUri !== uriAtStart) return;
      covers = data.covers ?? [];
      coverState = 'done';
    } catch {
      if (trackUri !== uriAtStart) return;
      coverError = "Couldn't reach the server.";
      coverState = 'error';
    }
  }

  function pickTab(tab: Tab): void {
    userPickedTab = true;
    activeTab = tab;
    // Tab-click as fetch trigger.
    if (tab === 'queue') void loadSpotifyQueue();
    if (tab === 'covers' && coverState === 'idle') void loadCovers();
    if (tab === 'versions' && versionsData == null) void loadVersions(trackUri);
    if (tab === 'artist') {
      if (artistData == null) void loadArtist(artistName);
      if (discoveryFor !== artistName) void loadDiscovery(artistName);
    }
  }

  async function playEntry(uri: string): Promise<void> {
    await playback.playTrack(uri, [uri]);
    // No device anywhere -> play went pending; surface its card on Now Playing.
    if (playback.pendingPlay && location.pathname !== '/now-playing') {
      await goto('/now-playing');
    }
  }

  function versionLabel(e: Entry): string {
    if (e.versionType && e.versionType !== 'original') return e.versionType.replace(/_/g, ' ');
    return e.album ?? '';
  }

  onMount(() => () => {
    versionsAc?.abort();
    artistAc?.abort();
    discoveryAc?.abort();
    queueAc?.abort();
    queueMetaAc?.abort();
  });
</script>

<section class="flex w-full flex-col gap-3" data-testid="tabbed-panel">
  <!-- tab bar -->
  <div class="flex gap-1 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/10">
    {#if isSampling && showQueue}
      <button
        type="button"
        data-testid="tab-queue"
        onclick={() => pickTab('queue')}
        class="flex-1 rounded-full py-1 text-[11px] font-semibold tracking-wide transition-colors {activeTab === 'queue' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}"
      >
        Queue <span class="ml-0.5 {activeTab === 'queue' ? 'text-white/60' : 'text-white/30'}">{queueCount}</span>
      </button>
    {/if}
    <button
      type="button"
      data-testid="tab-versions"
      onclick={() => pickTab('versions')}
      class="flex-1 rounded-full py-1 text-[11px] font-semibold tracking-wide transition-colors {activeTab === 'versions' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}"
    >
      Versions{#if versionsCount != null}<span class="ml-0.5 {activeTab === 'versions' ? 'text-white/60' : 'text-white/30'}"> {versionsCount}</span>{/if}
    </button>
    <button
      type="button"
      data-testid="tab-artist"
      onclick={() => pickTab('artist')}
      class="flex-1 rounded-full py-1 text-[11px] font-semibold tracking-wide transition-colors {activeTab === 'artist' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}"
    >
      Artist{#if artistCount != null}<span class="ml-0.5 {activeTab === 'artist' ? 'text-white/60' : 'text-white/30'}"> {artistCount}</span>{/if}
    </button>
    <button
      type="button"
      data-testid="tab-covers"
      onclick={() => pickTab('covers')}
      class="flex-1 rounded-full py-1 text-[11px] font-semibold tracking-wide transition-colors {activeTab === 'covers' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}"
    >
      Covers
    </button>
  </div>

  <!-- ─── QUEUE (Spotify's live queue, read-only) ──────────────────── -->
  {#if activeTab === 'queue'}
    {#if !isSampling}
      <p class="text-xs text-white/50">Start a shuffle to build a queue.</p>
    {:else if queueState === 'loading'}
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Loading queue…
      </div>
    {:else if queueState === 'error'}
      <p class="text-xs text-red-400">Couldn't load the queue.</p>
    {:else if spotifyQueue.length === 0}
      <p class="text-xs text-white/50">Queue is empty.</p>
    {:else}
      <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Up next · edit in Spotify
      </p>
      <div class="flex flex-col gap-1" role="list" data-testid="queue-list">
        {#each spotifyQueue.slice(0, 30) as item, i (item.uri + ':' + i)}
          {@const meta = queueMeta.get(item.uri) ?? null}
          {@const art = item.albumArtUrl ?? meta?.albumArtUrl ?? null}
          <div
            class="flex items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-white/[0.04]"
            role="listitem"
            data-testid="queue-row"
            data-uri={item.uri}
          >
            <span class="w-5 shrink-0 text-center text-[10px] font-semibold text-white/30">{i + 1}</span>
            {#if art}
              <img src={art} alt="" class="size-9 shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-9 shrink-0 rounded-md bg-white/10"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{item.name ?? meta?.title ?? 'Track'}</p>
              <p class="truncate text-[11px] text-white/50">{item.artists.join(', ') || (meta?.artists?.join(', ') ?? '')}</p>
            </div>
            <OpenInSpotifyLink uri={item.uri} />
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- ─── VERSIONS ──────────────────────────────────────────────── -->
  {#if activeTab === 'versions'}
    {#if versionsData == null}
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Looking for other versions…
      </div>
    {:else if versionsData.library.length === 0 && versionsData.catalog.length === 0}
      <p class="text-xs text-white/45">No other versions found by this artist.</p>
    {:else}
      {#if versionsData.library.length > 0}
        <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">In your library</p>
        <div class="flex flex-col gap-1.5">
          {#each versionsData.library as v (v.uri)}
            {@const playingHere = playback.state.track?.uri === v.uri}
            {@const label = versionLabel(v)}
            <div class="flex items-center gap-1">
              <button
                type="button"
                onclick={() => {
                  if (v.rating == null) void playEntry(v.uri);
                  else void goto(`/library/track/${encodeURIComponent(v.uri)}`);
                }}
                disabled={v.uri === trackUri}
                class="flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-white/[0.04] p-2 text-left transition-colors hover:bg-white/[0.08] disabled:opacity-40"
              >
                {#if v.albumArtUrl}
                  <img src={v.albumArtUrl} alt="" class="size-10 shrink-0 rounded-md object-cover shadow shadow-black/40" />
                {:else}
                  <div class="size-10 shrink-0 rounded-md bg-white/10"></div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white'}">{v.title}</div>
                  {#if label}<div class="truncate text-[10px] text-white/45">{label}</div>{/if}
                </div>
                {#if v.rating != null && v.rating > 0}
                  <span class="flex items-center gap-0.5 text-spotify-green">
                    <Star class="size-3.5 fill-current" />
                    <span class="text-sm font-bold tabular-nums">{v.rating}</span>
                  </span>
                {/if}
              </button>
              <OpenInSpotifyLink uri={v.uri} />
            </div>
          {/each}
        </div>
      {/if}
      {#if versionsData.catalog.length > 0}
        <p class="mt-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">Other versions</p>
        <div class="flex flex-col gap-1.5">
          {#each versionsData.catalog as v (v.uri)}
            {@const playingHere = playback.state.track?.uri === v.uri}
            {@const label = versionLabel(v)}
            <div class="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2">
              {#if v.albumArtUrl}
                <img src={v.albumArtUrl} alt="" class="size-10 shrink-0 rounded-md object-cover shadow shadow-black/40" />
              {:else}
                <div class="size-10 shrink-0 rounded-md bg-white/10"></div>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white/80'}">{v.title}</div>
                {#if label}<div class="truncate text-[10px] text-white/40">{label}</div>{/if}
              </div>
              <button
                type="button"
                onclick={() => playEntry(v.uri)}
                aria-label="Play"
                class="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium hover:bg-white/15"
              ><Play class="size-3 fill-current" />Play</button>
              <OpenInSpotifyLink uri={v.uri} />
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}

  <!-- ─── ARTIST ────────────────────────────────────────────────── -->
  {#if activeTab === 'artist'}
    {@const stats = discoveryData?.stats ?? null}
    {@const topUnrated = discoveryData?.topUnrated ?? []}
    {@const rated = artistData ?? []}
    {@const tabLoading =
      artistData == null || discoveryState === 'idle' || discoveryState === 'loading'}
    {@const empty =
      !stats && topUnrated.length === 0 && rated.length === 0 && discoveryState !== 'error'}

    {#if tabLoading}
      <!-- One unified spinner for the whole tab: don't reveal the library songs
           and then re-flow when discovery (stats + top unrated) lands. -->
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Loading {artistName || 'artist'}…
      </div>
    {:else}
      <!-- stats: avg rating · artist rating (composite score) · rank — mirrors the library list -->
      {#if stats}
        <div class="grid grid-cols-3 gap-2 rounded-xl bg-white/[0.04] p-2 text-center" data-testid="artist-stats">
          <div>
            <div class="text-sm font-bold tabular-nums text-spotify-green">{stats.avg.toFixed(1)}</div>
            <div class="text-[10px] text-white/45">avg rating</div>
          </div>
          <div>
            <div class="text-sm font-bold tabular-nums text-spotify-green">{stats.rating}</div>
            <div class="text-[10px] text-white/45">artist rating</div>
          </div>
          <div>
            <div class="text-sm font-bold tabular-nums">#{stats.rank}</div>
            <div class="text-[10px] text-white/45">of {stats.total} artists</div>
          </div>
        </div>
      {/if}

      <!-- top unrated (Last.fm playcount rank) -->
      {#if topUnrated.length > 0}
        <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">Top unrated</p>
        <div class="flex flex-col gap-1" data-testid="top-unrated-list">
          {#each topUnrated as t, i (t.uri)}
            {@const playingHere = playback.state.track?.uri === t.uri}
            <div class="flex items-center gap-1">
              <button
                type="button"
                onclick={() => void goto(`/library/track/${encodeURIComponent(t.uri)}`)}
                class="flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-left transition-colors hover:bg-white/[0.06]"
              >
                <span class="w-4 shrink-0 text-center text-xs font-bold tabular-nums text-white/40">{i + 1}</span>
                {#if t.albumArtUrl}
                  <img src={t.albumArtUrl} alt="" class="size-10 shrink-0 rounded-md object-cover shadow shadow-black/40" />
                {:else}
                  <div class="size-10 shrink-0 rounded-md bg-white/10"></div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white'}">{t.title}</div>
                  <div class="truncate text-[10px] text-white/45">
                    {formatPlays(t.playcount)} plays{#if playingHere} · <span class="text-spotify-green">now playing</span>{/if}
                  </div>
                </div>
              </button>
              <OpenInSpotifyLink uri={t.uri} />
            </div>
          {/each}
        </div>
      {:else if discoveryState === 'error'}
        <p class="text-xs text-white/45">Couldn't load top tracks right now.</p>
      {/if}

      <!-- the artist's rated tracks in the library -->
      {#if rated.length > 0}
        <p class="mt-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{artistName} · in your library</p>
        <div class="relative flex flex-col gap-1" data-testid="artist-list">
          {#each artistListExpanded ? rated : rated.slice(0, ARTIST_LIST_COLLAPSED) as row (row.uri)}
            {@const playingHere = playback.state.track?.uri === row.uri}
            <div class="flex items-center gap-1">
              <button
                type="button"
                onclick={() => void goto(`/library/track/${encodeURIComponent(row.uri)}`)}
                class="flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-left transition-colors hover:bg-white/[0.06]"
              >
                {#if row.albumArtUrl}
                  <img src={row.albumArtUrl} alt="" class="size-10 shrink-0 rounded-md object-cover shadow shadow-black/40" />
                {:else}
                  <div class="size-10 shrink-0 rounded-md bg-white/10"></div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium {playingHere ? 'text-spotify-green' : 'text-white'}">{row.title ?? 'Track'}</div>
                  <div class="truncate text-[10px] text-white/45">
                    {row.album ?? ''}{row.album ? ' · ' : ''}{row.plays} {row.plays === 1 ? 'play' : 'plays'}{#if playingHere} · <span class="text-spotify-green">now playing</span>{/if}
                  </div>
                </div>
                {#if row.rating != null && row.rating > 0}
                  <span class="flex items-center gap-0.5 text-spotify-green">
                    <Star class="size-3.5 fill-current" />
                    <span class="text-sm font-bold tabular-nums">{row.rating}</span>
                  </span>
                {/if}
              </button>
              <OpenInSpotifyLink uri={row.uri} />
            </div>
          {/each}
          {#if rated.length > ARTIST_LIST_COLLAPSED}
            {#if !artistListExpanded}
              <button
                type="button"
                data-testid="artist-list-show-all"
                onclick={() => (artistListExpanded = true)}
                class="mt-1 w-full rounded-xl border border-white/10 bg-white/[0.04] py-2 text-center text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                Show all {rated.length}
              </button>
            {:else}
              <!-- sticky so the list can be collapsed from anywhere mid-scroll;
                   bottom offset clears the bottom nav + mini player -->
              <div class="sticky bottom-32 z-10 mt-1 flex justify-center">
                <button
                  type="button"
                  data-testid="artist-list-hide"
                  onclick={() => (artistListExpanded = false)}
                  class="rounded-full border border-white/15 bg-black/80 px-4 py-1.5 text-xs font-medium text-white/80 shadow-lg shadow-black/50 backdrop-blur transition-colors hover:bg-black/60"
                >
                  Hide all
                </button>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if empty}
        <p class="text-xs text-white/45">Nothing from {artistName || 'this artist'} yet.</p>
      {/if}
    {/if}
  {/if}

  <!-- ─── COVERS ────────────────────────────────────────────────── -->
  {#if activeTab === 'covers'}
    {#if coverState === 'loading'}
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Searching covers…
      </div>
    {:else if coverState === 'unavailable'}
      <p class="text-xs text-white/45">Couldn't look up covers — no MusicBrainz match for this recording.</p>
    {:else if coverState === 'error'}
      <p class="text-xs text-red-400">{coverError}</p>
      <button
        type="button"
        onclick={() => { coverState = 'idle'; void loadCovers(); }}
        class="w-fit rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-medium hover:bg-white/10"
      >Try again</button>
    {:else if coverState === 'done' && covers.length === 0}
      <p class="text-xs text-white/45">No covers found.</p>
    {:else if coverState === 'done'}
      <div class="flex flex-col gap-1.5">
        {#each covers as v (v.uri)}
          <div class="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2">
            {#if v.albumArtUrl}
              <img src={v.albumArtUrl} alt="" class="size-10 shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-10 shrink-0 rounded-md bg-white/10"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-white/85">{v.title}</div>
              <div class="truncate text-[10px] text-white/45">{v.artists.join(', ') || versionLabel(v)}</div>
            </div>
            <button
              type="button"
              onclick={() => playEntry(v.uri)}
              aria-label="Play"
              class="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium hover:bg-white/15"
            ><Play class="size-3 fill-current" />Play</button>
            <OpenInSpotifyLink uri={v.uri} />
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>
