<script lang="ts">
  import { tick } from 'svelte';
  import { Plus } from '@lucide/svelte';

  type Label = { id: string; name: string; applied: boolean };

  type Props = {
    trackUri: string;
  };

  let { trackUri }: Props = $props();

  let labels = $state<Label[]>([]);
  let error = $state<string | null>(null);
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  let adding = $state(false);
  let query = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  const applied = $derived(labels.filter((l) => l.applied));
  const suggestions = $derived(labels.filter((l) => !l.applied));

  const trimmedQuery = $derived(query.trim());
  // Case-insensitive substring filter over ALL labels.
  const filtered = $derived(
    trimmedQuery === ''
      ? labels
      : labels.filter((l) => l.name.toLowerCase().includes(trimmedQuery.toLowerCase())),
  );
  const exactMatch = $derived(
    trimmedQuery !== '' &&
      labels.some((l) => l.name.toLowerCase() === trimmedQuery.toLowerCase()),
  );
  const showCreate = $derived(trimmedQuery !== '' && !exactMatch);

  function setError(msg: string) {
    error = msg;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      error = null;
      errorTimer = null;
    }, 4000);
  }

  function clearError() {
    error = null;
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  async function fetchLabels(uri: string) {
    try {
      const res = await fetch(`/api/labels?trackUri=${encodeURIComponent(uri)}`);
      if (!res.ok) return;
      const data = await res.json();
      // Ignore a stale response if the track changed while in flight.
      if (uri !== trackUri) return;
      labels = data.labels ?? [];
    } catch {
      // Transient blip — keep showing what we have.
    }
  }

  // Re-fetch whenever the track changes; stale chips clear immediately.
  $effect(() => {
    const uri = trackUri;
    labels = [];
    if (!uri) return;
    void fetchLabels(uri);
  });

  async function applyLabel(name: string) {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const uri = trackUri;
    const prev = labels;

    // Optimistic: mark existing label applied, or add a temporary chip.
    const existing = labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    const tempId = `tmp:${trimmed}`;
    if (existing) {
      labels = labels.map((l) => (l.id === existing.id ? { ...l, applied: true } : l));
    } else {
      labels = [...labels, { id: tempId, name: trimmed, applied: true }];
    }

    try {
      const res = await fetch('/api/track-labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spotifyTrackUri: uri, name: trimmed }),
      });
      if (!res.ok) {
        labels = prev;
        setError("Couldn't add that label. Try again.");
        return;
      }
      const data = await res.json();
      // Swap the temporary id for the real one so the chip is removable
      // even before the MRU refetch lands.
      if (data?.label?.id && uri === trackUri) {
        labels = labels.map((l) =>
          l.id === tempId ? { id: data.label.id, name: data.label.name, applied: true } : l,
        );
      }
      clearError();
      // Re-fetch to get MRU ordering (and ids for any other temp chips).
      if (uri === trackUri) await fetchLabels(uri);
    } catch {
      labels = prev;
      setError("Couldn't add that label. Check your connection.");
    }
  }

  async function removeLabel(label: Label) {
    // A temp chip has no real id yet (its POST is still in flight); just drop
    // it locally rather than sending an invalid id to DELETE.
    if (label.id.startsWith('tmp:')) {
      labels = labels.filter((l) => l.id !== label.id);
      return;
    }
    const uri = trackUri;
    const prev = labels;

    // Optimistic.
    labels = labels.map((l) => (l.id === label.id ? { ...l, applied: false } : l));

    try {
      const res = await fetch('/api/track-labels', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spotifyTrackUri: uri, labelId: label.id }),
      });
      if (!res.ok) {
        labels = prev;
        setError("Couldn't remove that label. Try again.");
        return;
      }
      clearError();
    } catch {
      labels = prev;
      setError("Couldn't remove that label. Check your connection.");
    }
  }

  async function openAdd() {
    adding = true;
    query = '';
    await tick();
    inputEl?.focus();
  }

  function collapseAdd() {
    adding = false;
    query = '';
  }

  async function applyAndCollapse(name: string) {
    collapseAdd();
    await applyLabel(name);
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      collapseAdd();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const top = filtered[0];
      if (top) {
        void applyAndCollapse(top.name);
      } else if (trimmedQuery !== '') {
        void applyAndCollapse(trimmedQuery);
      }
    }
  }
</script>

<div class="flex w-full max-w-md flex-col items-center gap-3">
  <div class="flex flex-wrap items-center justify-center gap-2">
    {#each applied as label (label.id)}
      <button
        type="button"
        class="inline-flex min-h-8 items-center gap-1 rounded-full bg-spotify-green/25 px-3 py-1 text-xs font-medium text-spotify-green backdrop-blur transition-colors hover:bg-spotify-green/35"
        aria-label={`Remove label ${label.name}`}
        onclick={() => removeLabel(label)}
      >
        <span>{label.name}</span>
        <span aria-hidden="true" class="text-base leading-none">×</span>
      </button>
    {/each}

    {#each suggestions as label (label.id)}
      <button
        type="button"
        class="inline-flex min-h-8 items-center rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur transition-colors hover:bg-white/20"
        aria-label={`Add label ${label.name}`}
        onclick={() => applyLabel(label.name)}
      >
        {label.name}
      </button>
    {/each}

    {#if !adding}
      <button
        type="button"
        aria-label="+ add"
        class="inline-flex min-h-8 items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur transition-colors hover:bg-white/20"
        onclick={openAdd}
      >
        <Plus class="size-3" />label
      </button>
    {/if}
  </div>

  {#if adding}
    <div class="flex w-full flex-col items-center gap-2">
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        maxlength="50"
        aria-label="Add a label"
        placeholder="Type a label…"
        class="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-spotify-green focus:outline-none"
        onkeydown={onInputKeydown}
        onblur={() => {
          // Collapse if nothing typed; keep open while choosing options.
          if (trimmedQuery === '') collapseAdd();
        }}
      />

      {#if adding}
        <div class="flex flex-wrap items-center justify-center gap-2">
          {#each filtered as label (label.id)}
            <button
              type="button"
              class="inline-flex min-h-8 items-center rounded-full px-3 py-1 text-sm transition-colors {label.applied
                ? 'bg-spotify-green text-black'
                : 'bg-white/10 text-white/70 hover:bg-white/20'}"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => applyAndCollapse(label.name)}
            >
              {label.name}
            </button>
          {/each}

          {#if showCreate}
            <button
              type="button"
              class="inline-flex min-h-8 items-center rounded-full border border-spotify-green/60 px-3 py-1 text-sm text-spotify-green transition-colors hover:bg-spotify-green/10"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => applyAndCollapse(trimmedQuery)}
            >
              Create "{trimmedQuery}"
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
  </div>
</div>
