<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import favicon from '$lib/assets/favicon.svg';
  import { createPlaybackStore, setPlaybackStore } from '$lib/playback/player.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import BottomNav from '$lib/components/BottomNav.svelte';

  let { children, data } = $props();

  const playback = createPlaybackStore();
  setPlaybackStore(playback);

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
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<MiniPlayer store={playback} currentRoute={page.url.pathname} navVisible={showNav} />

{#if showNav}
  <BottomNav currentRoute={page.url.pathname} />
{/if}
