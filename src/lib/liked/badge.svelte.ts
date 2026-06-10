// Shared reactive count of unrated Liked Songs. Drives the now-playing alert
// card and the Library callout row. Populated once on app mount (layout); the
// /liked review page decrements it as songs get rated so every surface stays
// in sync without a refetch. Same pattern as history/badge.svelte.ts.

let count = $state(0);
let total = $state(0);
let loaded = $state(false);

export const likedUnrated = {
  get count() {
    return count;
  },
  get total() {
    return total;
  },
  get loaded() {
    return loaded;
  },
  set(unrated: number, totalLiked: number) {
    count = Math.max(0, Math.floor(unrated));
    total = Math.max(0, Math.floor(totalLiked));
    loaded = true;
  },
  decrement(by = 1) {
    count = Math.max(0, count - by);
  },
  increment(by = 1) {
    count += by;
  },
  // Fetch the current counts from the server (count-only mode — no track list).
  async refresh() {
    try {
      const res = await fetch('/api/liked/unrated?count=1');
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.unrated === 'number') {
        count = Math.max(0, data.unrated);
        total = Math.max(0, data.total ?? 0);
        loaded = true;
      }
    } catch {
      // Network hiccup — leave the last known count in place.
    }
  },
};
