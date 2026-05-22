<script lang="ts">
  import { onMount } from 'svelte';
  import NowPlaying from '$lib/components/NowPlaying.svelte';

  type Playing = {
    uri: string;
    name: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    durationMs: number;
    progressMs: number | null;
    isPlaying: boolean;
    isrc: string | null;
  };

  const POLL_MS = 5000;

  let loading = $state(true);
  let playing = $state<Playing | null>(null);
  let rating = $state<number | null>(null);
  let error = $state<string | null>(null);

  let interval: ReturnType<typeof setInterval> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  async function poll() {
    try {
      const res = await fetch('/api/spotify/currently-playing');
      if (!res.ok) {
        loading = false;
        return;
      }
      const data = await res.json();
      if (data.playing == null) {
        playing = null;
        rating = null;
      } else {
        playing = data.playing;
        rating = data.rating ?? null;
      }
    } catch {
      // Transient network blip — keep showing last good state.
    } finally {
      loading = false;
    }
  }

  function startPolling() {
    if (interval !== null) return;
    interval = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else {
      poll();
      startPolling();
    }
  }

  function setError(msg: string) {
    error = msg;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      error = null;
      errorTimer = null;
    }, 4000);
  }

  function clearError() {
    error = null;
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  async function handleRate(next: number) {
    if (!playing) return;
    const prev = rating;
    const uri = playing.uri;
    const isrc = playing.isrc ?? undefined;

    // Optimistic update.
    rating = next;

    try {
      let res: Response;
      if (next === 0) {
        res = await fetch('/api/ratings', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spotifyTrackUri: uri }),
        });
      } else {
        res = await fetch('/api/ratings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spotifyTrackUri: uri, ratingHalfSteps: next, isrc }),
        });
      }
      if (!res.ok) {
        rating = prev;
        setError("Couldn't save your rating. Try again.");
        return;
      }
      clearError();
    } catch {
      rating = prev;
      setError("Couldn't save your rating. Check your connection.");
    }
  }

  onMount(() => {
    poll();
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (errorTimer !== null) clearTimeout(errorTimer);
    };
  });
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
  <NowPlaying {playing} {rating} {loading} onrate={handleRate} />

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>
</main>
