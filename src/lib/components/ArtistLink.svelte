<script lang="ts">
  import { goto } from '$app/navigation';
  import ArtistPickerSheet from '$lib/components/ArtistPickerSheet.svelte';

  type Props = {
    artists: string[];
    /** Tailwind classes for the artist text line (size/colour to match the host view). */
    class?: string;
  };

  let { artists, class: className = '' }: Props = $props();

  let sheetOpen = $state(false);

  function goToArtist(name: string) {
    sheetOpen = false;
    void goto(`/library/artist/${encodeURIComponent(name)}`);
  }

  function onLineClick() {
    if (artists.length === 0) return;
    if (artists.length === 1) {
      goToArtist(artists[0]);
    } else {
      sheetOpen = true;
    }
  }

  const label = $derived(
    artists.length === 1
      ? `Go to artist ${artists[0]}`
      : 'Choose an artist to view in your library',
  );
</script>

{#if artists.length > 0}
  <button
    type="button"
    data-testid="artist-link"
    onclick={onLineClick}
    aria-label={label}
    aria-haspopup={artists.length > 1 ? 'dialog' : undefined}
    class="{className} max-w-full cursor-pointer rounded underline-offset-2 transition-colors hover:text-white hover:underline focus-visible:underline focus-visible:outline-none"
  >
    {artists.join(', ')}
  </button>

  <ArtistPickerSheet
    {artists}
    open={sheetOpen}
    onpick={goToArtist}
    onclose={() => (sheetOpen = false)}
  />
{/if}
