<script lang="ts">
  import { goto } from '$app/navigation';
  import { Heart, X } from '@lucide/svelte';
  import { likedUnrated } from '$lib/liked/badge.svelte';
  import { shuffleUnratedLiked } from '$lib/liked/shuffle';
  import { getPlaybackStore } from '$lib/playback/player.svelte';

  const playback = getPlaybackStore();

  // Dismissal sticks for the session; the card returns next app open if
  // unrated liked songs still exist.
  const DISMISS_KEY = 'disccovery_liked_alert_dismissed';
  let dismissed = $state(
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1',
  );
  let starting = $state(false);

  const visible = $derived(!dismissed && likedUnrated.loaded && likedUnrated.count > 0);

  function dismiss() {
    dismissed = true;
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private-mode storage failure — in-memory dismissal still applies.
    }
  }

  async function shuffleThem() {
    if (starting) return;
    starting = true;
    try {
      if (await shuffleUnratedLiked(playback)) await goto('/now-playing');
    } finally {
      starting = false;
    }
  }
</script>

{#if visible}
  <div
    data-testid="liked-alert"
    class="rounded-2xl border border-pink-400/25 bg-gradient-to-br from-pink-500/15 to-violet-500/10 p-4"
  >
    <div class="flex items-start gap-3">
      <div
        class="grid size-10 flex-shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-300"
      >
        <Heart class="size-4.5 fill-white text-white" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-bold">
          {likedUnrated.count} liked {likedUnrated.count === 1 ? 'song isn’t' : 'songs aren’t'} rated yet
        </div>
        <div class="mt-0.5 text-xs text-white/50">
          Rate them so they count toward your taste profile.
        </div>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={() => goto('/liked')}
            class="rounded-full bg-white/90 px-4 py-1.5 text-xs font-bold text-black"
          >
            Review
          </button>
          <button
            type="button"
            onclick={shuffleThem}
            disabled={starting}
            class="rounded-full border border-white/20 px-4 py-1.5 text-xs font-semibold text-white/80 disabled:opacity-50"
          >
            {starting ? 'Starting…' : 'Shuffle them'}
          </button>
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onclick={dismiss} class="text-white/30">
        <X class="size-4" />
      </button>
    </div>
  </div>
{/if}
