<script lang="ts">
  import { onDestroy, untrack } from 'svelte';

  type Props = {
    positionMs: number;
    durationMs: number;
    paused: boolean;
    onseek: (positionMs: number) => void | Promise<void>;
  };

  let { positionMs, durationMs, paused, onseek }: Props = $props();

  // Local "smooth" position. The authoritative position arrives in bursts (SDK
  // state-changes, or 5s polls). We tick locally between bursts so the bar
  // doesn't freeze. Re-anchor whenever the upstream value changes.
  let anchorPos = $state(positionMs);
  let anchorAt = $state(performance.now());
  let now = $state(performance.now());
  let dragging = $state(false);
  let dragValue = $state(0);

  // A poll's reported position often lags the value we've already extrapolated
  // to. Snapping straight to it makes the bar jump backward. So for small
  // discrepancies we re-anchor *forward-only*; only a large delta (a real seek
  // or a track change, which resets position toward 0) snaps to the new value.
  const REANCHOR_THRESHOLD_MS = 2500;

  // Re-anchor when upstream position or play-state changes. anchor reads/writes
  // are untracked so the effect depends only on positionMs/paused, not itself.
  $effect(() => {
    const incoming = positionMs;
    const isPaused = paused;
    untrack(() => {
      const t = performance.now();
      if (isPaused) {
        anchorPos = incoming;
        anchorAt = t;
        return;
      }
      const extrapolated = anchorPos + (t - anchorAt);
      anchorPos =
        Math.abs(incoming - extrapolated) > REANCHOR_THRESHOLD_MS
          ? incoming // seek or track change — honor it (forward or back)
          : Math.max(incoming, extrapolated); // minor poll drift — never rewind
      anchorAt = t;
    });
  });

  let raf: number | null = null;
  function tick() {
    now = performance.now();
    raf = requestAnimationFrame(tick);
  }
  $effect(() => {
    if (paused || dragging) {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      return;
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } };
  });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });

  const liveMs = $derived(
    paused
      ? anchorPos
      : Math.min(durationMs || anchorPos, anchorPos + (now - anchorAt)),
  );
  const displayMs = $derived(dragging ? dragValue : liveMs);
  const pct = $derived(
    durationMs > 0 ? Math.max(0, Math.min(100, (displayMs / durationMs) * 100)) : 0,
  );

  function fmt(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function onInput(e: Event) {
    dragging = true;
    dragValue = Number((e.currentTarget as HTMLInputElement).value);
  }
  function onChange(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    dragging = false;
    // Hard-anchor to the seek target so the forward-only re-anchor logic
    // doesn't swallow a small backward seek as if it were poll drift.
    anchorPos = v;
    anchorAt = performance.now();
    void onseek(v);
  }
</script>

<div class="flex w-full max-w-xs flex-col gap-1">
  <input
    type="range"
    min="0"
    max={Math.max(1, durationMs)}
    step="1000"
    value={Math.floor(displayMs)}
    disabled={durationMs <= 0}
    oninput={onInput}
    onchange={onChange}
    aria-label="Seek"
    data-testid="scrubber"
    class="scrubber-range w-full"
    style="--pct: {pct}%"
  />
  <div class="flex justify-between text-[11px] tabular-nums text-white/60">
    <span>{fmt(displayMs)}</span>
    <span>{fmt(durationMs)}</span>
  </div>
</div>

<style>
  .scrubber-range {
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
  .scrubber-range:disabled { cursor: default; opacity: 0.5; }
  .scrubber-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
  }
  .scrubber-range::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
  }
</style>
