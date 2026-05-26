<script lang="ts">
  import { Music, Library } from '@lucide/svelte';

  let { currentRoute }: { currentRoute: string } = $props();

  const items = [
    { href: '/now-playing', label: 'Now Playing', icon: Music, match: '/now-playing' },
    { href: '/library', label: 'Library', icon: Library, match: '/library' },
  ];

  function isActive(match: string): boolean {
    return currentRoute === match || currentRoute.startsWith(`${match}/`);
  }
</script>

<nav
  aria-label="Primary"
  class="fixed inset-x-6 bottom-4 z-50 flex h-12 rounded-full border border-white/15 bg-white/[0.08] p-1 shadow-2xl shadow-black/60 backdrop-blur-xl"
>
  {#each items as item (item.href)}
    {@const active = isActive(item.match)}
    <a
      href={item.href}
      aria-current={active ? 'page' : undefined}
      class="flex flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors {active
        ? 'bg-gradient-to-b from-spotify-green to-[#0e9243] text-black font-bold shadow shadow-spotify-green/30'
        : 'text-white/70 hover:text-white'}"
    >
      <item.icon class="size-4" />
      {item.label}
    </a>
  {/each}
</nav>
