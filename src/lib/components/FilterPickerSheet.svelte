<script module lang="ts">
  export type FilterOption = { id: string; name: string; count: number };
  export type FilterChipState = 'include' | 'exclude' | null;
</script>

<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { Check, Ban } from '@lucide/svelte';

  type Props = {
    title: string;
    options: FilterOption[];
    open: boolean;
    loading: boolean;
    stateOf: (id: string) => FilterChipState;
    // Cycle: neutral → include → exclude → neutral
    oncycle: (option: FilterOption) => void;
    onclose: () => void;
    // Tap-behavior caption; override when oncycle isn't the 3-way cycle.
    hint?: string;
  };

  let {
    title,
    options,
    open,
    loading,
    stateOf,
    oncycle,
    onclose,
    hint = 'tap: include → exclude → off',
  }: Props = $props();

  let search = $state('');

  const visible = $derived(
    options.filter((o) => o.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  /** Portal to <body> to escape ancestor stacking contexts (same trick as
   *  ArtistPickerSheet). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

{#if open}
  <div
    use:portal
    class="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
    transition:fade={{ duration: 150 }}
    onclick={onclose}
    aria-hidden="true"
  ></div>

  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    data-testid="filter-picker-sheet"
    use:portal
    transition:fly={{ y: 240, duration: 220 }}
    class="fixed inset-x-0 bottom-0 z-[70] mx-auto flex max-h-[75dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-white/10 bg-neutral-900/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl shadow-black/80 backdrop-blur"
  >
    <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20"></div>
    <div class="mb-2 flex items-baseline justify-between px-1">
      <p class="text-xs font-medium uppercase tracking-wide text-white/40">{title}</p>
      <p class="text-[10px] text-white/30">{hint}</p>
    </div>

    <input
      type="search"
      placeholder="Search…"
      bind:value={search}
      class="mb-2 w-full rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 text-sm placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
    />

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading}
        <p class="p-4 text-center text-sm text-white/40">Loading…</p>
      {:else if visible.length === 0}
        <p class="p-4 text-center text-sm text-white/40">Nothing found.</p>
      {:else}
        <ul class="flex flex-col gap-1.5">
          {#each visible as o (o.id)}
            {@const st = stateOf(o.id)}
            <li>
              <button
                type="button"
                data-testid="filter-picker-option"
                onclick={() => oncycle(o)}
                class="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors {st === 'include'
                  ? 'border border-purple-400/30 bg-purple-500/10'
                  : st === 'exclude'
                    ? 'border border-red-400/30 bg-red-500/10'
                    : 'bg-white/[0.04] hover:bg-white/[0.08]'}"
              >
                <div class="min-w-0 flex-1">
                  <span class="truncate text-sm font-semibold">{o.name}</span>
                  <span class="ml-2 text-xs text-white/35">{o.count}</span>
                </div>
                <div
                  class="grid size-5 flex-shrink-0 place-items-center rounded-md {st === 'include'
                    ? 'bg-purple-500 text-white'
                    : st === 'exclude'
                      ? 'bg-red-500/80 text-white'
                      : 'border border-white/25'}"
                >
                  {#if st === 'include'}<Check class="size-3.5" strokeWidth={3} />{/if}
                  {#if st === 'exclude'}<Ban class="size-3" strokeWidth={3} />{/if}
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <button
      type="button"
      onclick={onclose}
      class="mt-3 w-full rounded-full bg-gradient-to-b from-purple-500 to-purple-700 py-3 text-sm font-bold text-white"
    >
      Done
    </button>
  </div>
{/if}
