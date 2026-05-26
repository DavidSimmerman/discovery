<script lang="ts">
  type Props = {
    paused: boolean;
    disabled?: boolean;
    ontoggle: () => void | Promise<void>;
    onnext: () => void | Promise<void>;
    onprev: () => void | Promise<void>;
  };

  let { paused, disabled = false, ontoggle, onnext, onprev }: Props = $props();
</script>

<div class="flex items-center gap-6">
  <button
    aria-label="Previous track"
    class="text-white/80 transition-colors hover:text-white disabled:opacity-40"
    {disabled}
    onclick={() => void onprev()}
  >
    <svg viewBox="0 0 24 24" class="size-6 fill-current stroke-current" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="2.5" height="16" />
      <polygon points="21,4 21,20 7.5,12" />
    </svg>
  </button>

  <button
    aria-label={paused ? 'Play' : 'Pause'}
    class="flex size-14 items-center justify-center rounded-full bg-white text-black shadow-2xl shadow-black/40 transition-transform hover:scale-105 disabled:opacity-40"
    {disabled}
    onclick={() => void ontoggle()}
  >
    {#if paused}
      <svg viewBox="0 0 24 24" class="size-6 fill-current stroke-current" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">
        <polygon points="6,3 21,12 6,21" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" class="size-6 fill-current stroke-current" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="3" width="5" height="18" />
        <rect x="14" y="3" width="5" height="18" />
      </svg>
    {/if}
  </button>

  <button
    aria-label="Next track"
    class="text-white/80 transition-colors hover:text-white disabled:opacity-40"
    {disabled}
    onclick={() => void onnext()}
  >
    <svg viewBox="0 0 24 24" class="size-6 fill-current stroke-current" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true">
      <polygon points="3,4 3,20 16.5,12" />
      <rect x="17.5" y="4" width="2.5" height="16" />
    </svg>
  </button>
</div>
