<script lang="ts">
  // App settings — primarily the account actions the PWA otherwise can't
  // reach (no browser chrome → no way to clear cookies or re-run OAuth).
  import { page } from '$app/state';
  import { LogOut, RefreshCw, User, SlidersHorizontal, ChevronRight } from '@lucide/svelte';

  const user = $derived(page.data.user ?? null);
</script>

<svelte:head><title>Settings · disccovery</title></svelte:head>

<main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-32">
  <h1 class="text-xl font-bold">Settings</h1>

  {#if user}
    <!-- account -->
    <section class="flex flex-col gap-2">
      <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">Account</p>
      <div class="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-white/10">
          <User class="size-5 text-white/70" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{user.displayName ?? user.spotifyId}</p>
          <p class="truncate text-xs text-white/50">{user.spotifyId}</p>
        </div>
        {#if user.product === 'premium'}
          <span class="rounded-full bg-spotify-green/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-spotify-green">Premium</span>
        {/if}
      </div>
    </section>

    <!-- spotify connection -->
    <section class="flex flex-col gap-2">
      <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">Spotify connection</p>
      <div class="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
        <a
          href="/auth/login"
          data-sveltekit-reload
          data-testid="reconnect-spotify"
          class="flex items-center gap-3 p-4 transition-colors hover:bg-white/[0.06]"
        >
          <RefreshCw class="size-4 shrink-0 text-white/60" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">Reconnect Spotify</p>
            <p class="text-xs text-white/50">
              Re-runs the Spotify login — needed once after the app gains new
              permissions (e.g. saving rated songs to Liked Songs).
            </p>
          </div>
          <ChevronRight class="size-4 shrink-0 text-white/30" />
        </a>
        <div class="mx-4 border-t border-white/[0.06]"></div>
        <a href="/shuffle-settings" class="flex items-center gap-3 p-4 transition-colors hover:bg-white/[0.06]">
          <SlidersHorizontal class="size-4 shrink-0 text-white/60" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">Shuffle settings</p>
            <p class="text-xs text-white/50">Sources, filters, weighting, discovery</p>
          </div>
          <ChevronRight class="size-4 shrink-0 text-white/30" />
        </a>
      </div>
    </section>

    <!-- session -->
    <section class="flex flex-col gap-2">
      <p class="px-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">Session</p>
      <form method="POST" action="/auth/logout">
        <button
          type="submit"
          data-testid="logout-button"
          class="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20"
        >
          <LogOut class="size-4" />
          Log out
        </button>
      </form>
    </section>
  {:else}
    <div class="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
      <p class="text-sm text-white/70">You're not logged in.</p>
      <a
        href="/auth/login"
        data-sveltekit-reload
        class="rounded-full bg-spotify-green px-5 py-2 text-sm font-semibold text-black transition hover:brightness-110"
      >
        Log in with Spotify
      </a>
    </div>
  {/if}
</main>
