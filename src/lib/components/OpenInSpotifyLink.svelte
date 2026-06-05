<script lang="ts">
  // Icon-only "Open in Spotify" link for track rows. Opens the track page (no
  // playback). stopPropagation so tapping it inside a clickable row doesn't also
  // trigger the row's play/navigate handler. Renders nothing for non-track URIs.
  import { ExternalLink } from '@lucide/svelte';
  import { spotifyTrackUrl } from '$lib/spotifyLink';

  let { uri }: { uri: string | null | undefined } = $props();
  const url = $derived(spotifyTrackUrl(uri));
</script>

{#if url}
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Open in Spotify"
    title="Open in Spotify"
    data-testid="open-in-spotify"
    onclick={(e) => e.stopPropagation()}
    class="flex size-7 shrink-0 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/10 hover:text-spotify-green"
  >
    <ExternalLink class="size-4" />
  </a>
{/if}
