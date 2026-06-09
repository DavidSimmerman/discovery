// Shared reactive count of unrated tracks in the recent-history window, shown as
// a badge on the History nav tab. Populated once on app mount (layout) and kept
// in sync by the History page as the user rates / unrates tracks, so the badge
// updates without a refetch.

let count = $state(0);
let loaded = $state(false);

export const historyBadge = {
  get count() {
    return count;
  },
  get loaded() {
    return loaded;
  },
  set(n: number) {
    count = Math.max(0, Math.floor(n));
    loaded = true;
  },
  decrement(by = 1) {
    count = Math.max(0, count - by);
  },
  increment(by = 1) {
    count += by;
  },
  // Fetch the current unrated count from the server (count-only mode).
  async refresh() {
    try {
      const res = await fetch('/api/history?count=1');
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.unratedCount === 'number') {
        count = Math.max(0, data.unratedCount);
        loaded = true;
      }
    } catch {
      // Network hiccup — leave the last known count in place.
    }
  },
};
