<script lang="ts">
  // Tabbed panel that lives on /now-playing under the transport. Replaces the
  // standalone OtherVersions section. Four tabs:
  //   queue    — virtual timeline upcoming (visible only while sampler runs)
  //   versions — same data as the old OtherVersions: library + catalog
  //   artist   — primary artist's top tracks in the user's library (rating + plays)
  //   covers   — MusicBrainz-backed covers; kept lazy (external hop)
  //
  // Tab click triggers the fetch for that tab (cached per uri). Counts for
  // versions + artist preload on track change so the tab pills show numbers
  // without the user opening them. Covers stays uncounted by design.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Play, Star, Loader2, X, ChevronUp, ChevronDown } from '@lucide/svelte';
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

  type Tab = 'queue' | 'versions' | 'artist' | 'covers';

  let {
    trackUri,
    artistName,
    playback,
  }: { trackUri: string; artistName: string; playback: PlaybackStore } = $props();

  let activeTab = $state<Tab>('queue');
  let loadedFor = $state<string | null>(null);

  // Versions / Artist data (preloaded on track change). null = not loaded yet.
  let versionsData = $state<{ library: Entry[]; catalog: Entry[] } | null>(null);
  let artistData = $state<LibraryRow[] | null>(null);

  // Covers data (lazy, click-triggered).
  type CoverState = 'idle' | 'loading' | 'done' | 'unavailable' | 'error';
  let coverState = $state<CoverState>('idle');
  let covers = $state<Entry[]>([]);
  let coverError = $state<string | null>(null);

  // Track metadata for upcoming URIs (queue tab).
  let queueMeta = $state<Map<string, TrackMeta>>(new Map());
  let queueMetaLoading = $state(false);

  // Per-tab fetch controllers so a track-change abort doesn't leak.
  let versionsAc: AbortController | null = null;
  let artistAc: AbortController | null = null;
  let queueAc: AbortController | null = null;

  const isSampling = $derived(playback.isSampling);
  const upcoming = $derived(playback.timeline?.upcoming ?? []);
  const versionsCount = $derived(
    versionsData ? versionsData.library.length + versionsData.catalog.length : null,
  );
  const artistCount = $derived(artistData ? artistData.length : null);
  const queueCount = $derived(upcoming.length);

  // upcoming[0] is locked once we've actually pushed it into Spotify's queue.
  // Using samplerQueuedUri (not "remainingMs < 5s") as the truth source matters
  // because a user can seek backward after pre-queue fires — remainingMs would
  // climb back over the threshold, but the URI is still queued in Spotify and
  // removing it locally would desync the cursor at natural advance.
  const firstRowLocked = $derived(
    playback.samplerQueuedUri != null && upcoming[0] === playback.samplerQueuedUri,
  );

  // Reload preloads + reset lazy state when the source track changes. Guard on
  // loadedFor so we don't re-fire when trackUri reactive churn fires the effect
  // with the same URI (same pattern OtherVersions used).
  $effect(() => {
    const uri = trackUri;
    if (!uri || uri === loadedFor) return;
    loadedFor = uri;
    resetForUri();
    void loadVersions(uri);
    void loadArtist(artistName);
  });

  // Hydrate queue metadata whenever upcoming changes. Diff against the existing
  // map and only fetch URIs we haven't seen — keeps reorders/single-removes from
  // refetching the whole queue. Failures fall back to nulls (rendered as "Track").
  $effect(() => {
    const uris = upcoming;
    if (uris.length === 0) return;
    const missing = uris.filter((u) => !queueMeta.has(u));
    if (missing.length === 0) return;
    void hydrateQueue(missing);
  });

  // Default tab follows sampler state: sampling → queue, otherwise → versions.
  // Only flips when the user hasn't manually picked a different tab.
  let userPickedTab = $state(false);
  $effect(() => {
    if (userPickedTab) return;
    activeTab = isSampling ? 'queue' : 'versions';
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

  async function hydrateQueue(missing: readonly string[]): Promise<void> {
    queueAc?.abort();
    const ac = new AbortController();
    queueAc = ac;
    queueMetaLoading = true;
    try {
      const res = await fetch(
        `/api/tracks?uris=${encodeURIComponent(missing.join(','))}`,
        { signal: ac.signal },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { tracks: TrackMeta[] };
      const next = new Map(queueMeta);
      for (const t of data.tracks) next.set(t.uri, t);
      queueMeta = next;
    } catch {
      /* leave nulls, queue rows will fall back to "Track" */
    } finally {
      if (queueAc === ac) queueMetaLoading = false;
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
    // Tab-click as fetch trigger: covers loads here (lazy), the rest are already
    // preloaded but we still call as a no-op safety in case of failure-and-retry.
    if (tab === 'covers' && coverState === 'idle') void loadCovers();
    if (tab === 'versions' && versionsData == null) void loadVersions(trackUri);
    if (tab === 'artist' && artistData == null) void loadArtist(artistName);
  }

  function playEntry(uri: string): void {
    void playback.playTrack(uri, [uri]);
  }

  function versionLabel(e: Entry): string {
    if (e.versionType && e.versionType !== 'original') return e.versionType.replace(/_/g, ' ');
    return e.album ?? '';
  }

  function removeUpcoming(uri: string, index: number): void {
    if (firstRowLocked && index === 0) return;
    void playback.removeFromQueue(uri, index);
  }

  function moveUp(index: number): void {
    if (index <= 0) return;
    // Can't move INTO slot 0 if it's locked.
    if (firstRowLocked && index === 1) return;
    void playback.reorderQueue(index, index - 1);
  }

  function moveDown(index: number): void {
    if (index >= upcoming.length - 1) return;
    void playback.reorderQueue(index, index + 1);
  }

  onMount(() => () => {
    versionsAc?.abort();
    artistAc?.abort();
    queueAc?.abort();
  });
</script>

<section class="flex w-full flex-col gap-3" data-testid="tabbed-panel">
  <!-- tab bar -->
  <div class="flex gap-1 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/10">
    {#if isSampling}
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

  <!-- ─── QUEUE ─────────────────────────────────────────────────── -->
  {#if activeTab === 'queue'}
    {#if !isSampling}
      <p class="text-xs text-white/50">Start a shuffle to build a queue.</p>
    {:else if upcoming.length === 0}
      <p class="text-xs text-white/50">Queue is empty.</p>
    {:else}
      <div class="flex flex-col gap-1" data-testid="queue-list">
        {#each upcoming as uri, i (uri + ':' + i)}
          {@const meta = queueMeta.get(uri) ?? null}
          {@const locked = i === 0 && firstRowLocked}
          <div
            class="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors {locked ? 'bg-white/[0.06] ring-1 ring-white/10' : 'hover:bg-white/[0.04]'}"
            data-testid="queue-row"
            data-uri={uri}
            data-locked={locked ? 'true' : 'false'}
          >
            <span class="w-4 text-[10px] font-semibold {locked ? 'text-amber-300' : 'text-white/40'}">{i + 1}</span>
            {#if meta?.albumArtUrl}
              <img src={meta.albumArtUrl} alt="" class="size-9 shrink-0 rounded-md object-cover shadow shadow-black/40" />
            {:else}
              <div class="size-9 shrink-0 rounded-md bg-white/10"></div>
            {/if}
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{meta?.title ?? 'Track'}</p>
              <p class="truncate text-[11px] {locked ? 'text-amber-300/80' : 'text-white/50'}">
                {#if locked}about to play · locked{:else}{meta?.artists?.join(', ') ?? ''}{/if}
              </p>
            </div>
            {#if !locked}
              <button
                type="button"
                aria-label="Move up"
                disabled={i <= 0 || (firstRowLocked && i === 1)}
                onclick={() => moveUp(i)}
                class="text-white/30 hover:text-white/70 disabled:opacity-20"
              ><ChevronUp class="size-4" /></button>
              <button
                type="button"
                aria-label="Move down"
                disabled={i >= upcoming.length - 1}
                onclick={() => moveDown(i)}
                class="text-white/30 hover:text-white/70 disabled:opacity-20"
              ><ChevronDown class="size-4" /></button>
              <button
                type="button"
                aria-label="Remove from queue"
                data-testid="queue-remove"
                onclick={() => removeUpcoming(uri, i)}
                class="text-white/30 hover:text-white/70"
              ><X class="size-4" /></button>
            {/if}
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
            <button
              type="button"
              onclick={() => {
                if (v.rating == null) playEntry(v.uri);
                else void goto(`/library/track/${encodeURIComponent(v.uri)}`);
              }}
              disabled={v.uri === trackUri}
              class="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2 text-left transition-colors hover:bg-white/[0.08] disabled:opacity-40"
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
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}

  <!-- ─── ARTIST ────────────────────────────────────────────────── -->
  {#if activeTab === 'artist'}
    {#if artistData == null}
      <div class="flex items-center gap-2 text-xs text-white/45">
        <Loader2 class="size-3.5 animate-spin" />
        Loading {artistName}'s top tracks…
      </div>
    {:else if artistData.length === 0}
      <p class="text-xs text-white/45">Nothing from {artistName || 'this artist'} in your library yet.</p>
    {:else}
      <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{artistName} · top in your library</p>
      <div class="flex flex-col gap-1" data-testid="artist-list">
        {#each artistData as row (row.uri)}
          {@const playingHere = playback.state.track?.uri === row.uri}
          <button
            type="button"
            onclick={() => { if (!playingHere) playEntry(row.uri); }}
            disabled={playingHere}
            class="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2 text-left transition-colors hover:bg-white/[0.06] disabled:cursor-default disabled:bg-white/[0.06]"
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
        {/each}
      </div>
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
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>
