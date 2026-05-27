<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { createPlaybackStore, setPlaybackStore } from '$lib/playback/player.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import BottomNav from '$lib/components/BottomNav.svelte';

  let { children, data } = $props();

  const playback = createPlaybackStore();
  setPlaybackStore(playback);

  // Daily refresh of the user's Spotify top artists/tracks. Endpoint is
  // idempotent + checks staleness server-side, so calling on every mount is
  // cheap; if the data is fresh it no-ops.
  onMount(() => {
    if (!data.user) return;
    void fetch('/api/me/top-lists/refresh', { method: 'POST' }).catch(() => {});
  });

  // Show the persistent nav only on the in-app screens, and only when authed.
  const showNav = $derived(
    !!data.user &&
      (page.url.pathname === '/now-playing' ||
        page.url.pathname.startsWith('/now-playing/') ||
        page.url.pathname === '/library' ||
        page.url.pathname.startsWith('/library/')),
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
