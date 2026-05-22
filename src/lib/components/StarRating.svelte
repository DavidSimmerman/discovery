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

  let trackEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);
  let dragValue = $state(0);
  let moved = false;

  // While dragging, the stars preview the value under the pointer.
  const displayValue = $derived(dragging ? dragValue : value);

  function fillFor(i: number): 'empty' | 'half' | 'full' {
    if (displayValue >= i * 2) return 'full';
    if (displayValue === i * 2 - 1) return 'half';
    return 'empty';
  }

  function clamp(n: number): number {
    return Math.max(0, Math.min(10, n));
  }

  // Map a pointer x-coordinate to a half-step (1-10). Left half of a star = half,
  // right half = full. Clamped to the stars' bounds.
  function halfStepFromX(clientX: number): number {
    if (!trackEl) return value;
    const rect = trackEl.getBoundingClientRect();
    const starW = rect.width / 5;
    const idx = Math.max(0, Math.min(4, Math.floor((clientX - rect.left) / starW)));
    const within = (clientX - rect.left - idx * starW) / starW;
    return clamp(idx * 2 + (within < 0.5 ? 1 : 2));
  }

  function onpointerdown(e: PointerEvent) {
    if (!onchange) return;
    e.preventDefault();
    trackEl?.setPointerCapture(e.pointerId);
    dragging = true;
    moved = false;
    dragValue = halfStepFromX(e.clientX);
  }

  function onpointermove(e: PointerEvent) {
    if (!dragging) return;
    const next = halfStepFromX(e.clientX);
    if (next !== dragValue) moved = true;
    dragValue = next;
  }

  function onpointerup(e: PointerEvent) {
    if (!dragging || !onchange) return;
    trackEl?.releasePointerCapture(e.pointerId);
    dragging = false;
    const target = dragValue;
    // A stationary tap on the already-set value clears the rating; a drag never clears.
    onchange(!moved && target === value ? 0 : target);
  }

  function onpointercancel() {
    dragging = false;
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
  <!-- Press anywhere on the stars and drag to set the rating; release to commit. -->
  <div
    bind:this={trackEl}
    role="slider"
    tabindex="0"
    aria-label="Rating"
    aria-valuemin={0}
    aria-valuemax={10}
    aria-valuenow={value}
    class="inline-flex cursor-pointer touch-none"
    {onkeydown}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onpointercancel}
  >
    {#each stars as i (i)}
      <Star fill={fillFor(i)} {size} />
    {/each}
  </div>
{:else}
  <div class="inline-flex" aria-hidden="true">
    {#each stars as i (i)}
      <Star fill={fillFor(i)} {size} />
    {/each}
  </div>
{/if}
