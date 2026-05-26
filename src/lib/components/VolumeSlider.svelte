<script lang="ts">
  import { Volume2, VolumeX, Volume1 } from '@lucide/svelte';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let { store }: { store: PlaybackStore } = $props();

  // Last non-zero volume so the speaker icon can restore it from "mute".
  // Initialised lazily from the store via $effect.pre so the prop read doesn't
  // warn about state_referenced_locally.
  let preMute = $state(0.5);
  $effect.pre(() => {
    if (store.volume > 0) preMute = store.volume;
  });

  // Pick a glyph by current loudness — gives the slider some visual feedback.
  const Glyph = $derived(
    store.volume === 0 ? VolumeX : store.volume < 0.5 ? Volume1 : Volume2,
  );

  function onInput(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value) / 100;
    void store.setVolume(v);
  }

  function toggleMute() {
    if (store.volume > 0) {
      void store.setVolume(0);
    } else {
      void store.setVolume(preMute || 0.5);
    }
  }
</script>

<div class="flex w-full max-w-xs items-center gap-3">
  <button
    type="button"
    aria-label={store.volume === 0 ? 'Unmute' : 'Mute'}
    class="text-white/70 transition-colors hover:text-white"
    onclick={toggleMute}
  >
    <Glyph class="size-5" />
  </button>
  <input
    type="range"
    min="0"
    max="100"
    step="1"
    value={Math.round(store.volume * 100)}
    oninput={onInput}
    aria-label="Volume"
    data-testid="volume-slider"
    class="volume-range flex-1"
    style="--pct: {Math.round(store.volume * 100)}%"
  />
</div>

<style>
  /* Custom range styling so the filled portion lights up green and the thumb
     matches the glass aesthetic. Kept self-contained so the slider can be
     reused outside now-playing later. */
  .volume-range {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 9999px;
    background: linear-gradient(
      to right,
      #1db954 0%,
      #1db954 var(--pct, 0%),
      rgba(255, 255, 255, 0.15) var(--pct, 0%),
      rgba(255, 255, 255, 0.15) 100%
    );
    outline: none;
    cursor: pointer;
  }
  .volume-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 9999px;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
  }
  .volume-range::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 9999px;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
  }
</style>
