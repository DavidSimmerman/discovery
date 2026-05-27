<script lang="ts">
  import { Star } from '@lucide/svelte';

  type Row = {
    name: string;
    count: number;
    avg: number;
    weighted: number;
  };

  let { row, onclick }: { row: Row; onclick?: (name: string) => void } = $props();

  const weightedText = $derived(row.weighted.toFixed(1));
  const avgText = $derived(row.avg.toFixed(1));
  const countText = $derived(`${row.count} ${row.count === 1 ? 'song' : 'songs'}`);
</script>

<div
  role="button"
  tabindex="0"
  aria-label={row.name}
  data-testid="artist-row"
  onclick={() => onclick?.(row.name)}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick?.(row.name); } }}
  class="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-white/[0.04] p-2 text-left transition-colors hover:bg-white/[0.08]"
>
  <div class="grid size-12 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-sm font-bold uppercase text-white/70 shadow-lg shadow-black/40">
    {row.name.charAt(0)}
  </div>

  <div class="min-w-0 flex-1">
    <div class="truncate text-sm font-semibold">{row.name}</div>
    <div class="truncate text-xs text-white/50">{countText} · avg {avgText}</div>
  </div>

  <div class="flex flex-shrink-0 items-center gap-0.5 text-spotify-green">
    <Star class="size-3.5 fill-current" />
    <span class="text-sm font-bold tabular-nums">{weightedText}</span>
  </div>
</div>
