<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { createPlaybackStore, setPlaybackStore } from '$lib/playback/player.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import BottomNav from '$lib/components/BottomNav.svelte';
  import { historyBadge } from '$lib/history/badge.svelte';
  import { likedUnrated } from '$lib/liked/badge.svelte';

  let { children, data } = $props();

  const playback = createPlaybackStore();
  setPlaybackStore(playback);

  // Daily refresh of the user's Spotify top artists/tracks. Endpoint is
  // idempotent + checks staleness server-side, so calling on every mount is
  // cheap; if the data is fresh it no-ops.
  // Start polling Spotify Connect state as soon as the layout mounts for an
  // authed user — the MiniPlayer needs live state on every in-app screen.
  onMount(() => {
    if (!data.user) return;
    playback.init();
    void fetch('/api/me/top-lists/refresh', { method: 'POST' }).catch(() => {});
    // Populate the History nav badge (unrated recent plays) once on app load.
    void historyBadge.refresh();
    // And the unrated-liked count (now-playing alert card + Library callout).
    void likedUnrated.refresh();
    return () => playback.destroy();
  });

  // Show the persistent nav only on the in-app screens, and only when authed.
  const showNav = $derived(
    !!data.user &&
      (page.url.pathname === '/now-playing' ||
        page.url.pathname.startsWith('/now-playing/') ||
        page.url.pathname === '/library' ||
        page.url.pathname.startsWith('/library/') ||
        page.url.pathname === '/history' ||
        page.url.pathname.startsWith('/history/')),
  );
</script>

<svelte:head>
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="theme-color" content="#000000" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="disccovery" />
</svelte:head>

{@render children()}

<MiniPlayer store={playback} currentRoute={page.url.pathname} navVisible={showNav} />

{#if showNav}
  <BottomNav currentRoute={page.url.pathname} />
{/if}
