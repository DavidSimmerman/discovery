/** Fisher-Yates shuffle. Pure; takes RNG for testability. Returns a new array. */
export function shuffleFisherYates<T>(input: readonly T[], rng: () => number = Math.random): T[] {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a play-queue with the clicked URI at index 0 and the rest of `all`
 * shuffled after it. If the clicked URI is not in `all`, it's still placed
 * first and `all` is shuffled in full behind it.
 */
export function buildQueueFromClick(
  clickedUri: string,
  all: readonly string[],
  rng: () => number = Math.random,
): string[] {
  const rest = all.filter((u) => u !== clickedUri);
  return [clickedUri, ...shuffleFisherYates(rest, rng)];
}
