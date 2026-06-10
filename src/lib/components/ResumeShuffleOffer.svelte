<script lang="ts">
  // Interrupted-shuffle recovery. Two skins over the same offer:
  //   chip   — "Resume shuffle · N left" pill on the empty Now Playing state
  //   banner — slim dismissible strip at the top while a foreign track plays
  // The offer comes from the server timeline (getResumeInfo), which survives
  // client stopSampling — divergence, reloads, cold starts. Resume is just
  // startSampler() without reset: push [current, ...upcoming] and follow.
  import { Play, RotateCcw, X } from '@lucide/svelte';
  import type { PlaybackStore, ResumeInfo } from '$lib/playback/player.svelte';

  let {
    store,
    variant,
    offered = $bindable(false),
  }: {
    store: PlaybackStore;
    variant: 'chip' | 'banner';
    // Bindable so the page can relabel its Shuffle button "New shuffle" when
    // the chip is visible.
    offered?: boolean;
  } = $props();

  // Session-scoped dismissal, keyed by the session's current track so a NEW
  // interrupted session shows the banner again after an old one was dismissed.
  const DISMISS_KEY = 'discovery.resumeBannerDismissed';

  let info = $state<ResumeInfo | null>(null);
  let nextMeta = $state<{ title: string | null; artists: string[] } | null>(null);
  let dismissedUri = $state<string | null>(null);
  let resuming = $state(false);

  $effect(() => {
    try {
      dismissedUri = sessionStorage.getItem(DISMISS_KEY);
    } catch {
      /* private mode — banner just isn't dismissible across reloads */
    }
  });

  // Re-probe whenever the playback situation shifts: sampling stopped, a
  // pending play resolved, or the (foreign) track changed.
  $effect(() => {
    const sampling = store.isSampling;
    const pending = store.pendingPlay;
    void store.state.track?.uri; // dep: foreign track changes re-probe
    if (sampling || pending) {
      info = null;
      return;
    }
    let alive = true;
    void store.getResumeInfo().then((i) => {
      if (alive) info = i;
    });
    return () => {
      alive = false;
    };
  });

  // Banner shows the track the session left off on; hydrate its title.
  $effect(() => {
    const uri = variant === 'banner' ? info?.currentUri : null;
    if (!uri) {
      nextMeta = null;
      return;
    }
    let alive = true;
    void fetch(`/api/tracks?uris=${encodeURIComponent(uri)}`)
      .then((r) => (r.ok ? r.json() : { tracks: [] }))
      .then((j: { tracks?: { title: string | null; artists: string[] }[] }) => {
        if (alive) nextMeta = j.tracks?.[0] ?? null;
      })
      .catch(() => {
        /* banner falls back to count-only copy */
      });
    return () => {
      alive = false;
    };
  });

  const visible = $derived(
    info != null &&
      !store.isSampling &&
      store.pendingPlay == null &&
      (variant === 'chip'
        ? store.state.track == null
        : store.state.track != null && dismissedUri !== info.currentUri),
  );

  $effect(() => {
    offered = visible;
  });

  async function resume() {
    if (resuming) return;
    resuming = true;
    try {
      await store.startSampler(); // no reset → picks the timeline back up
    } finally {
      resuming = false;
    }
  }

  function dismiss() {
    if (!info) return;
    dismissedUri = info.currentUri;
    try {
      sessionStorage.setItem(DISMISS_KEY, info.currentUri);
    } catch {
      /* in-memory dismissal still applies */
    }
  }
</script>

{#if visible && info}
  {#if variant === 'chip'}
    <button
      type="button"
      data-testid="resume-shuffle-chip"
      disabled={resuming}
      onclick={() => void resume()}
      class="inline-flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-4 py-2 text-sm transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
    >
      <RotateCcw class="size-4" />
      <span>{resuming ? 'Resuming…' : 'Resume shuffle'}</span>
      <span class="text-xs text-white/50">· {info.remaining} left</span>
    </button>
  {:else}
    <div
      data-testid="resume-shuffle-banner"
      class="flex w-full max-w-md items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3"
    >
      <RotateCcw class="size-4 shrink-0 text-emerald-300" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-medium text-emerald-200">
          Shuffle paused — {info.remaining} tracks left
        </p>
        <p class="truncate text-[11px] text-white/50">
          {#if nextMeta?.title}
            Next: {nextMeta.title}{nextMeta.artists.length ? ` · ${nextMeta.artists.join(', ')}` : ''}
          {:else}
            Resume to pick up where you left off
          {/if}
        </p>
      </div>
      <button
        type="button"
        data-testid="resume-shuffle-banner-resume"
        disabled={resuming}
        onclick={() => void resume()}
        class="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-50"
      >
        <Play class="size-3 fill-black" />
        {resuming ? '…' : 'Resume'}
      </button>
      <button
        type="button"
        data-testid="resume-shuffle-banner-dismiss"
        aria-label="Dismiss"
        onclick={dismiss}
        class="rounded-full p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
      >
        <X class="size-4" />
      </button>
    </div>
  {/if}
{/if}
