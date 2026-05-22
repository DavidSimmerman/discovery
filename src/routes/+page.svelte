<script lang="ts">
  import LoginButton from '$lib/components/LoginButton.svelte';
  let { data } = $props();
</script>

<main class="min-h-screen flex flex-col items-center justify-center gap-6 p-6 text-center">
  <h1 class="text-4xl font-black tracking-tight">
    <span class="text-spotify-green">disc</span>overy
  </h1>

  {#if data.user}
    <p class="text-lg">Hi, <strong>{data.user.displayName ?? data.user.spotifyId}</strong></p>
    <p class="text-sm opacity-60">Spotify id: {data.user.spotifyId}</p>
    <a
      href="/now-playing"
      class="inline-block rounded-full bg-spotify-green px-6 py-3 font-bold text-black hover:opacity-90"
    >
      Open now playing
    </a>
    <form method="POST" action="/auth/logout">
      <button class="rounded-full border border-white/20 px-5 py-2 hover:bg-white/10">
        Log out
      </button>
    </form>
  {:else}
    <p class="opacity-70 max-w-sm">Rate and label what you're listening to.</p>
    <LoginButton />
  {/if}
</main>
