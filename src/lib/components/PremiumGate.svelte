<script lang="ts">
  import type { Snippet } from 'svelte';
  type Product = 'premium' | 'free' | 'open';
  let { product, children }: { product: Product; children?: Snippet } = $props();
  const gated = $derived(product !== 'premium');
</script>

{#if gated}
  <div class="inline-flex flex-col items-center gap-1 opacity-50">
    <div class="pointer-events-none" aria-disabled="true">
      {#if children}{@render children()}{/if}
    </div>
    <p class="text-xs text-white/60">Premium required to play in disccovery</p>
  </div>
{:else}
  {#if children}{@render children()}{/if}
{/if}
