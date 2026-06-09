<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { ChevronRight } from '@lucide/svelte';

  type Props = {
    artists: string[];
    open: boolean;
    onpick: (name: string) => void;
    onclose: () => void;
  };

  let { artists, open, onpick, onclose }: Props = $props();

  /** Move the node to <body> so it escapes any ancestor stacking context (e.g. the
   *  now-playing <main> uses `isolate`, which would otherwise trap us under BottomNav). */
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
  <!-- Backdrop -->
  <div
    use:portal
    class="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
    transition:fade={{ duration: 150 }}
    onclick={onclose}
    aria-hidden="true"
  ></div>

  <!-- Sheet -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Choose an artist"
    data-testid="artist-picker-sheet"
    use:portal
    transition:fly={{ y: 240, duration: 220 }}
    class="fixed inset-x-0 bottom-0 z-[70] mx-auto w-full max-w-md rounded-t-2xl border-t border-white/10 bg-neutral-900/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl shadow-black/80 backdrop-blur"
  >
    <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20"></div>
    <p class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-white/40">Go to artist</p>
    <ul class="flex flex-col gap-1">
      {#each artists as name (name)}
        <li>
          <button
            type="button"
            data-testid="artist-picker-option"
            onclick={() => onpick(name)}
            class="flex w-full items-center gap-3 rounded-xl bg-white/[0.04] p-2.5 text-left transition-colors hover:bg-white/[0.08]"
          >
            <div class="grid size-9 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-xs font-bold uppercase text-white/70">
              {name.charAt(0)}
            </div>
            <span class="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
            <ChevronRight class="size-4 flex-shrink-0 text-white/30" />
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
