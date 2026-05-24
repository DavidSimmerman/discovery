<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import favicon from '$lib/assets/favicon.svg';
  import { createPlaybackStore, setPlaybackStore } from '$lib/playback/player.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';

  let { children } = $props();

  const playback = createPlaybackStore();
  setPlaybackStore(playback);
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<MiniPlayer store={playback} currentRoute={page.url.pathname} />
