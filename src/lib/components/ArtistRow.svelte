<script lang="ts">
  type Row = {
    name: string;
    count: number;
    avg: number;
    score: number;
  };

  let {
    row,
    rank,
    onclick,
  }: { row: Row; rank: number; onclick?: (name: string) => void } = $props();

  const scoreText = $derived(Math.round(row.score).toString());
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
  <div class="w-6 flex-shrink-0 text-center text-sm font-semibold tabular-nums text-white/40">
    {rank}
  </div>

  <div class="grid size-12 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-sm font-bold uppercase text-white/70 shadow-lg shadow-black/40">
    {row.name.charAt(0)}
  </div>

  <div class="min-w-0 flex-1">
    <div class="truncate text-sm font-semibold">{row.name}</div>
    <div class="truncate text-xs text-white/50">{countText}</div>
  </div>

  <div class="flex flex-shrink-0 items-center gap-1 text-spotify-green">
    <span class="text-sm font-bold tabular-nums">{scoreText}</span>
  </div>
</div>
