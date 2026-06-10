<script lang="ts">
  import { Music, Library, History, Settings } from '@lucide/svelte';
  import { historyBadge } from '$lib/history/badge.svelte';

  let { currentRoute }: { currentRoute: string } = $props();

  const items = [
    { href: '/now-playing', label: 'Now Playing', icon: Music, match: '/now-playing' },
    { href: '/library', label: 'Library', icon: Library, match: '/library' },
    { href: '/history', label: 'History', icon: History, match: '/history' },
  ];

  function isActive(match: string): boolean {
    return currentRoute === match || currentRoute.startsWith(`${match}/`);
  }

  // Unrated-history count badge. Capped at "99+" so it never blows out the pill.
  const badgeText = $derived(historyBadge.count > 99 ? '99+' : String(historyBadge.count));
</script>

<nav
  aria-label="Primary"
  class="fixed inset-x-6 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex h-12 transform-gpu rounded-full border border-white/15 bg-white/[0.08] p-1 shadow-2xl shadow-black/60 backdrop-blur-xl [backface-visibility:hidden]"
>
  {#each items as item (item.href)}
    {@const active = isActive(item.match)}
    <a
      href={item.href}
      aria-current={active ? 'page' : undefined}
      class="relative flex flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors {active
        ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] text-black font-bold shadow shadow-spotify-green/30'
        : 'text-white/70 hover:text-white'}"
    >
      <item.icon class="size-4" />
      {item.label}
      {#if item.href === '/history' && historyBadge.count > 0}
        <span
          aria-label={`${historyBadge.count} unrated`}
          class="absolute -right-0.5 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white shadow"
        >
          {badgeText}
        </span>
      {/if}
    </a>
  {/each}
  <a
    href="/settings"
    aria-label="Settings"
    aria-current={isActive('/settings') ? 'page' : undefined}
    class="flex w-11 flex-none items-center justify-center rounded-full transition-colors {isActive('/settings')
      ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] text-black shadow shadow-spotify-green/30'
      : 'text-white/70 hover:text-white'}"
  >
    <Settings class="size-4" />
  </a>
</nav>
