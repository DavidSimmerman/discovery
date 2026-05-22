<script lang="ts">
  import Star from './Star.svelte';

  type Props = {
    value: number; // 0-10 half-steps; 0 = unrated
    size?: number;
    interactive?: boolean;
    onchange?: (next: number) => void;
  };

  let { value, size = 32, interactive = false, onchange }: Props = $props();

  const stars = [1, 2, 3, 4, 5];

  function fillFor(i: number): 'empty' | 'half' | 'full' {
    if (value >= i * 2) return 'full';
    if (value === i * 2 - 1) return 'half';
    return 'empty';
  }

  function clamp(n: number): number {
    return Math.max(0, Math.min(10, n));
  }

  // Tapping the zone whose value is already set clears the rating.
  function tap(target: number) {
    if (!onchange) return;
    onchange(value === target ? 0 : target);
  }

  function onkeydown(e: KeyboardEvent) {
    if (!onchange) return;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = clamp(value + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = clamp(value - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 10;
        break;
    }
    if (next !== null) {
      e.preventDefault();
      onchange(next);
    }
  }
</script>

{#if interactive}
  <div
    role="slider"
    tabindex="0"
    aria-label="Rating"
    aria-valuemin={0}
    aria-valuemax={10}
    aria-valuenow={value}
    class="inline-flex"
    {onkeydown}
  >
    {#each stars as i (i)}
      <div class="relative inline-block" style="width:{size}px; height:{size}px;">
        <Star fill={fillFor(i)} {size} />
        <!-- Left tap zone → half star (i*2 - 1). -->
        <button
          type="button"
          class="absolute inset-y-0 left-0 w-1/2 cursor-pointer bg-transparent p-0"
          aria-label={`${i * 2 - 1} half-steps`}
          onclick={() => tap(i * 2 - 1)}
        ></button>
        <!-- Right tap zone → full star (i*2). -->
        <button
          type="button"
          class="absolute inset-y-0 right-0 w-1/2 cursor-pointer bg-transparent p-0"
          aria-label={`${i * 2} half-steps`}
          onclick={() => tap(i * 2)}
        ></button>
      </div>
    {/each}
  </div>
{:else}
  <div class="inline-flex" aria-hidden="true">
    {#each stars as i (i)}
      <Star fill={fillFor(i)} {size} />
    {/each}
  </div>
{/if}
