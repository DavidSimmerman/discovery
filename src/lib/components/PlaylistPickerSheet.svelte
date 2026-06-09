<script module lang="ts">
  export type PickerPlaylist = {
    id: string;
    name: string;
    imageUrl: string | null;
    total: number;
    // null while the per-playlist stats fetch is still in flight
    unrated: number | null;
  };
</script>

<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { Check } from '@lucide/svelte';

  type Props = {
    playlists: PickerPlaylist[];
    selectedIds: Set<string>;
    open: boolean;
    loading: boolean;
    // Token (re-)auth needed: the stored token predates the playlist scopes.
    missingScope: boolean;
    ontoggle: (id: string) => void;
    onclose: () => void;
  };

  let { playlists, selectedIds, open, loading, missingScope, ontoggle, onclose }: Props = $props();

  let search = $state('');

  // Sorted by unrated desc (unknown counts sink below known ones) — "what's
  // left to rate" is the headline signal of this picker.
  const visible = $derived(
    playlists
      .filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
      .toSorted((a, b) => (b.unrated ?? -1) - (a.unrated ?? -1)),
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
    aria-label="Pick playlists"
    data-testid="playlist-picker-sheet"
    use:portal
    transition:fly={{ y: 240, duration: 220 }}
    class="fixed inset-x-0 bottom-0 z-[70] mx-auto flex max-h-[75dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-white/10 bg-neutral-900/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl shadow-black/80 backdrop-blur"
  >
    <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20"></div>
    <div class="mb-2 flex items-baseline justify-between px-1">
      <p class="text-xs font-medium uppercase tracking-wide text-white/40">Your playlists</p>
      <p class="text-[10px] text-white/30">sorted by unrated</p>
    </div>

    <input
      type="search"
      placeholder="Search playlists…"
      bind:value={search}
      class="mb-2 w-full rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 text-sm placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-purple-400/50"
    />

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if missingScope}
        <p class="p-4 text-center text-sm text-white/60">
          discovery needs permission to read your playlists.
          <a href="/auth/login" class="font-semibold text-purple-300 underline">Log in again</a>
          to grant it.
        </p>
      {:else if loading}
        <p class="p-4 text-center text-sm text-white/40">Loading playlists…</p>
      {:else if visible.length === 0}
        <p class="p-4 text-center text-sm text-white/40">No playlists found.</p>
      {:else}
        <ul class="flex flex-col gap-1.5">
          {#each visible as p (p.id)}
            {@const selected = selectedIds.has(p.id)}
            <li>
              <button
                type="button"
                data-testid="playlist-picker-option"
                onclick={() => ontoggle(p.id)}
                class="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors {selected
                  ? 'border border-purple-400/30 bg-purple-500/10'
                  : 'bg-white/[0.04] hover:bg-white/[0.08]'}"
              >
                {#if p.imageUrl}
                  <img src={p.imageUrl} alt="" class="size-11 flex-shrink-0 rounded-lg object-cover" />
                {:else}
                  <div class="grid size-11 flex-shrink-0 place-items-center rounded-lg bg-gradient-to-br from-white/15 to-white/5 text-sm font-bold text-white/60">
                    {p.name.charAt(0)}
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-semibold">{p.name}</div>
                  <div class="text-xs {p.unrated ? 'font-medium text-purple-300' : 'text-white/45'}">
                    {#if p.unrated == null}
                      {p.total} songs
                    {:else}
                      {p.unrated} unrated · {p.total} total
                    {/if}
                  </div>
                </div>
                <div
                  class="grid size-5 flex-shrink-0 place-items-center rounded-md {selected
                    ? 'bg-purple-500 text-white'
                    : 'border border-white/25'}"
                >
                  {#if selected}<Check class="size-3.5" strokeWidth={3} />{/if}
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
