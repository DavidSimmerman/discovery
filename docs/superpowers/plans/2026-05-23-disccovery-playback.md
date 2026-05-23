# disccovery Plan 5 — In-app playback (Web Playback SDK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship in-app Spotify playback in disccovery: click-to-play and shuffle from the library, take-over of an existing Spotify context, persistent transport UI, and OS lock-screen integration with `★★★★ Track Name` titles.

**Architecture:** A client-side `PlaybackStore` (Svelte 5 runes singleton) owns the Spotify Web Playback SDK player instance, exposes high-level methods (`playTrack`, `shuffle`, `takeover`, `togglePlay`, …), and fans state out via runes. Thin SvelteKit endpoints proxy Spotify's `PUT /me/player/play` and `PUT /me/player` (transfer) with a stable error shape. The existing `/api/spotify/access-token` endpoint feeds the SDK's `getOAuthToken` callback. UI is a mix of a new persistent `<MiniPlayer />` in the root layout, transport controls injected into `/now-playing` when disccovery is the audio source, and click-to-play wiring on `/library`. Tests split into vitest unit (pure helpers + endpoints + components), mocked-SDK Playwright (CI), and an opt-in real-Spotify `live` Playwright project (local).

**Tech Stack:** SvelteKit 2, Svelte 5 (runes), TypeScript, Tailwind, Drizzle + Postgres, vitest, @testing-library/svelte, @playwright/test, Spotify Web Playback SDK.

**Spec:** `docs/superpowers/specs/2026-05-23-disccovery-playback-design.md`

---

## File map (locked in before tasks)

**New (lib):**
- `src/lib/playback/stars.ts` — `stars(rating)` glyph helper.
- `src/lib/playback/queue.ts` — `shuffleFisherYates`, `buildQueueFromClick`.
- `src/lib/playback/media-session.ts` — `setMediaMetadata`, `setMediaActionHandlers`.
- `src/lib/playback/sdk-loader.ts` — Idempotent SDK script loader.
- `src/lib/playback/spotify-sdk.d.ts` — Ambient types for `window.Spotify`.
- `src/lib/playback/player.svelte.ts` — `PlaybackStore` singleton + factory.
- `src/lib/playback/errors.ts` — `mapSpotifyPlayError(status, body)` → stable shape.

**New (components):**
- `src/lib/components/PremiumGate.svelte`
- `src/lib/components/Transport.svelte`
- `src/lib/components/MiniPlayer.svelte`
- `src/lib/components/ContinueHereButton.svelte`
- `src/lib/components/ShuffleButton.svelte`

**New (routes / API):**
- `src/routes/api/spotify/player/play/+server.ts`
- `src/routes/api/spotify/player/transfer/+server.ts`

**Modified:**
- `src/lib/server/db/schema.ts` — Add `users.product`.
- `drizzle/0003_add_users_product.sql` — Migration.
- `src/routes/auth/callback/+server.ts` — Persist `product` from `/me`.
- `src/hooks.server.ts` — Include `product` in `event.locals.user`.
- `src/app.d.ts` — Extend `Locals.user` with `product`; add ambient SDK types reference.
- `src/routes/+layout.server.ts` (create if absent) — Surface `user.product` to client.
- `src/routes/+layout.svelte` — Mount `<MiniPlayer />` + initialize store context.
- `src/routes/now-playing/+page.svelte` — Stop polling when disccovery is source; render `<Transport />` + `<ContinueHereButton />` + "Shuffle my library" button; wrap play CTAs in `<PremiumGate />`.
- `src/routes/library/+page.svelte` — Click-to-play on rows; `<ShuffleButton />` in toolbar.
- `src/lib/components/LibraryRow.svelte` — Clickable row + playing indicator.
- `tests/e2e/fixtures/seed.ts` — Add `product` to seeded user.
- `playwright.config.ts` — Add `live` project (excluded from default).

**New (tests):**
- `tests/unit/stars.test.ts`
- `tests/unit/queue.test.ts`
- `tests/unit/media-session.test.ts`
- `tests/unit/playback-errors.test.ts`
- `tests/unit/player-play-endpoint.test.ts`
- `tests/unit/player-transfer-endpoint.test.ts`
- `tests/unit/components/PremiumGate.test.ts`
- `tests/unit/components/Transport.test.ts`
- `tests/unit/components/MiniPlayer.test.ts`
- `tests/unit/components/ContinueHereButton.test.ts`
- `tests/e2e/mocks/spotify-sdk.ts` — `mockSpotifySdk(page)` fixture.
- `tests/e2e/playback-click.spec.ts`
- `tests/e2e/playback-shuffle.spec.ts`
- `tests/e2e/playback-takeover.spec.ts`
- `tests/e2e/playback-premium-gate.spec.ts`
- `tests/e2e/playback-errors.spec.ts`
- `tests/e2e/mediasession.spec.ts`
- `tests/live/live.config.ts`, `tests/live/auth.setup.ts`, `tests/live/live-click.spec.ts`, `tests/live/live-shuffle.spec.ts`, `tests/live/live-mediasession.spec.ts`, `tests/live/live-takeover.spec.ts`.

---

# Phase A — Schema & auth (the `product` column)

## Task A1: `users.product` migration

**Files:**
- Modify: `src/lib/server/db/schema.ts`
- Create: `drizzle/0003_add_users_product.sql`

- [ ] **Step 1: Add column to schema**

Edit `src/lib/server/db/schema.ts`, replace the `users` table definition with:

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  spotifyId: text('spotify_id').notNull().unique(),
  displayName: text('display_name'),
  product: text('product').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file appears under `drizzle/` (likely `0003_*.sql`). If Drizzle picks a name other than `0003_add_users_product.sql`, **leave its name as-is** — record the actual filename in the commit message.

- [ ] **Step 3: Verify SQL contents**

Open the new migration file. It should contain a single `ALTER TABLE "users" ADD COLUMN "product" text DEFAULT 'open' NOT NULL;` (Drizzle may format it slightly differently). If it includes anything else (drops, renames), STOP and investigate.

- [ ] **Step 4: Apply locally**

Run: `pnpm db:migrate`
Expected: migration applied, no errors. Then `psql $DATABASE_URL -c "\d users"` should show `product | text | not null default 'open'`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/db/schema.ts drizzle/
git commit -m "db: add users.product (premium | free | open)"
```

## Task A2: Locals + hook + callback wiring

**Files:**
- Modify: `src/app.d.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/routes/auth/callback/+server.ts`
- Modify: `src/lib/server/spotify.ts` (extend `fetchSpotifyMe` return type)

- [ ] **Step 1: Update `fetchSpotifyMe` return type**

In `src/lib/server/spotify.ts`, replace the `fetchSpotifyMe` signature so the response carries `product`:

```ts
export async function fetchSpotifyMe(
  accessToken: string,
): Promise<{ id: string; display_name: string | null; email?: string; product: 'premium' | 'free' | 'open' }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify /me failed: ${res.status}`);
  return res.json();
}
```

(Spotify's `/me` already returns `product` for users with `user-read-private`; the scope `user-read-email` we already request also returns `product`.)

- [ ] **Step 2: Persist `product` on login**

Edit `src/routes/auth/callback/+server.ts`. In the upsert block, set `product` on both insert and update:

```ts
if (existing[0]) {
  userId = existing[0].id;
  await db.update(users)
    .set({ displayName: me.display_name, product: me.product })
    .where(eq(users.id, userId));
} else {
  const inserted = await db.insert(users)
    .values({ spotifyId: me.id, displayName: me.display_name, product: me.product })
    .returning({ id: users.id });
  userId = inserted[0].id;
}
```

- [ ] **Step 3: Expose `product` on `event.locals.user`**

Edit `src/app.d.ts`:

```ts
declare global {
  namespace App {
    interface Locals {
      user: {
        id: string;
        spotifyId: string;
        displayName: string | null;
        product: 'premium' | 'free' | 'open';
      } | null;
    }
  }
}

export {};
```

Edit `src/hooks.server.ts` so the locals user includes `product`:

```ts
event.locals.user = row[0]
  ? {
      id: row[0].id,
      spotifyId: row[0].spotifyId,
      displayName: row[0].displayName,
      product: row[0].product as 'premium' | 'free' | 'open',
    }
  : null;
```

- [ ] **Step 4: Surface `product` to the client via the root layout**

Create `src/routes/+layout.server.ts` if absent, or modify if present:

```ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    user: locals.user
      ? {
          id: locals.user.id,
          spotifyId: locals.user.spotifyId,
          displayName: locals.user.displayName,
          product: locals.user.product,
        }
      : null,
  };
};
```

If a `+page.server.ts` at root already returns `user` (it does — `src/routes/+page.server.ts`), keep both. The layout load is for global access (`$page.data.user`) including `product`.

- [ ] **Step 5: Run check**

Run: `pnpm check`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app.d.ts src/hooks.server.ts src/lib/server/spotify.ts src/routes/auth/callback/+server.ts src/routes/+layout.server.ts
git commit -m "auth: persist + surface spotify product (premium/free/open)"
```

---

# Phase B — Pure helpers (unit-tested)

## Task B1: `stars()` glyph

**Files:**
- Create: `src/lib/playback/stars.ts`
- Test: `tests/unit/stars.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/stars.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stars } from '$lib/playback/stars';

describe('stars()', () => {
  it('returns empty string for null/0', () => {
    expect(stars(null)).toBe('');
    expect(stars(0)).toBe('');
  });
  it('renders half stars', () => {
    expect(stars(1)).toBe('★');            // 1 half-step = ½
    // We use 0–10 half-steps. 1 = ½, 2 = ★, 3 = ★½, …, 10 = ★★★★★.
    // (rating-half-steps is the persisted unit; see schema.)
  });
  it('renders integer ratings', () => {
    expect(stars(2)).toBe('★');
    expect(stars(4)).toBe('★★');
    expect(stars(10)).toBe('★★★★★');
  });
  it('renders mixed half ratings', () => {
    expect(stars(3)).toBe('★½');
    expect(stars(5)).toBe('★★½');
    expect(stars(9)).toBe('★★★★½');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/stars.test.ts`
Expected: FAIL (`Cannot find module '$lib/playback/stars'`).

- [ ] **Step 3: Implement**

`src/lib/playback/stars.ts`:

```ts
/**
 * Render a rating (in half-step units, 0–10) as Unicode stars.
 * 0 / null → "". 1 → "★" (½), 2 → "★", 3 → "★½", … 10 → "★★★★★".
 */
export function stars(halfSteps: number | null): string {
  if (halfSteps == null || halfSteps <= 0) return '';
  const full = Math.floor(halfSteps / 2);
  const half = halfSteps % 2 === 1;
  return '★'.repeat(full) + (half ? '½' : '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/stars.test.ts`
Expected: PASS, all four cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback/stars.ts tests/unit/stars.test.ts
git commit -m "playback: stars() glyph helper"
```

## Task B2: Queue helpers (Fisher-Yates + click-anchored)

**Files:**
- Create: `src/lib/playback/queue.ts`
- Test: `tests/unit/queue.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shuffleFisherYates, buildQueueFromClick } from '$lib/playback/queue';

function seededRng(seed: number): () => number {
  // Mulberry32 — deterministic for tests.
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('shuffleFisherYates', () => {
  it('returns a permutation', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffleFisherYates(input, seededRng(1));
    expect(out).toHaveLength(5);
    expect([...out].sort()).toEqual([...input].sort());
  });
  it('does not mutate input', () => {
    const input = ['a', 'b', 'c'];
    shuffleFisherYates(input, seededRng(1));
    expect(input).toEqual(['a', 'b', 'c']);
  });
  it('handles empty / single element', () => {
    expect(shuffleFisherYates([], seededRng(1))).toEqual([]);
    expect(shuffleFisherYates(['x'], seededRng(1))).toEqual(['x']);
  });
  it('is deterministic for a seeded RNG', () => {
    const a = shuffleFisherYates(['1','2','3','4','5'], seededRng(42));
    const b = shuffleFisherYates(['1','2','3','4','5'], seededRng(42));
    expect(a).toEqual(b);
  });
});

describe('buildQueueFromClick', () => {
  it('puts clicked URI first', () => {
    const out = buildQueueFromClick('c', ['a','b','c','d','e'], seededRng(1));
    expect(out[0]).toBe('c');
  });
  it('rest is a permutation of the others', () => {
    const out = buildQueueFromClick('c', ['a','b','c','d','e'], seededRng(1));
    expect(out.slice(1).sort()).toEqual(['a','b','d','e']);
  });
  it('handles clicked URI not in list (still ends up first)', () => {
    const out = buildQueueFromClick('z', ['a','b','c'], seededRng(1));
    expect(out[0]).toBe('z');
    expect(out.slice(1).sort()).toEqual(['a','b','c']);
  });
  it('handles single-element list', () => {
    expect(buildQueueFromClick('a', ['a'], seededRng(1))).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/playback/queue.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/queue.test.ts`
Expected: PASS, all eight assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback/queue.ts tests/unit/queue.test.ts
git commit -m "playback: queue helpers (shuffle, build-from-click)"
```

## Task B3: `mapSpotifyPlayError` (stable error shape)

**Files:**
- Create: `src/lib/playback/errors.ts`
- Test: `tests/unit/playback-errors.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/playback-errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapSpotifyPlayError } from '$lib/playback/errors';

describe('mapSpotifyPlayError', () => {
  it('404 NO_ACTIVE_DEVICE → no_active_device', () => {
    expect(
      mapSpotifyPlayError(404, { error: { reason: 'NO_ACTIVE_DEVICE' } }),
    ).toEqual({ error: 'no_active_device' });
  });
  it('403 PREMIUM_REQUIRED → premium_required', () => {
    expect(
      mapSpotifyPlayError(403, { error: { reason: 'PREMIUM_REQUIRED' } }),
    ).toEqual({ error: 'premium_required' });
  });
  it('429 → rate_limited with retry_after seconds', () => {
    expect(mapSpotifyPlayError(429, {}, '7')).toEqual({
      error: 'rate_limited',
      retry_after: 7,
    });
  });
  it('429 with missing header → rate_limited, retry_after undefined', () => {
    expect(mapSpotifyPlayError(429, {})).toEqual({ error: 'rate_limited' });
  });
  it('5xx → transient', () => {
    expect(mapSpotifyPlayError(502, {})).toEqual({ error: 'transient' });
    expect(mapSpotifyPlayError(503, {})).toEqual({ error: 'transient' });
  });
  it('unknown 4xx → transient', () => {
    expect(mapSpotifyPlayError(418, {})).toEqual({ error: 'transient' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/playback-errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/playback/errors.ts`:

```ts
export type PlayErrorShape =
  | { error: 'no_active_device' }
  | { error: 'premium_required' }
  | { error: 'rate_limited'; retry_after?: number }
  | { error: 'transient' };

export function mapSpotifyPlayError(
  status: number,
  body: { error?: { reason?: string; message?: string } } | unknown,
  retryAfterHeader?: string | null,
): PlayErrorShape {
  const reason =
    body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'reason' in body.error
      ? (body.error as { reason?: string }).reason
      : undefined;

  if (status === 404 && reason === 'NO_ACTIVE_DEVICE') return { error: 'no_active_device' };
  if (status === 403 && reason === 'PREMIUM_REQUIRED') return { error: 'premium_required' };
  if (status === 429) {
    const n = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    return Number.isFinite(n) ? { error: 'rate_limited', retry_after: n } : { error: 'rate_limited' };
  }
  return { error: 'transient' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/playback-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback/errors.ts tests/unit/playback-errors.test.ts
git commit -m "playback: stable error shape for Spotify Player API"
```

## Task B4: `setMediaMetadata` / `setMediaActionHandlers`

**Files:**
- Create: `src/lib/playback/media-session.ts`
- Test: `tests/unit/media-session.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/media-session.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setMediaMetadata, setMediaActionHandlers } from '$lib/playback/media-session';

type MM = {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string }[];
};

class FakeMediaMetadata implements MM {
  title = '';
  artist = '';
  album = '';
  artwork: { src: string; sizes: string }[] = [];
  constructor(init: Partial<MM>) { Object.assign(this, init); }
}

beforeEach(() => {
  // Reset navigator.mediaSession to a fresh fake each test.
  const handlers = new Map<string, ((d: unknown) => void) | null>();
  (globalThis as unknown as { navigator: { mediaSession: unknown } }).navigator = {
    mediaSession: {
      metadata: null,
      setActionHandler: (action: string, h: ((d: unknown) => void) | null) => handlers.set(action, h),
      __handlers: handlers,
    },
  };
  (globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = FakeMediaMetadata;
});

describe('setMediaMetadata', () => {
  it('formats title as "★★★★ Track" when rated', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: 'XL', images: [] } },
      8,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.title).toBe('★★★★ Hello');
    expect(m.artist).toBe('Adele');
    expect(m.album).toBe('XL');
  });
  it('omits star prefix when rating is null/0', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: 'XL', images: [] } },
      null,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.title).toBe('Hello');
  });
  it('joins multiple artists with ", "', () => {
    setMediaMetadata(
      { uri: 'spotify:track:x', name: 'Hello', artists: [{ name: 'A' }, { name: 'B' }], album: { name: '', images: [] } },
      null,
    );
    const m = navigator.mediaSession.metadata as unknown as MM;
    expect(m.artist).toBe('A, B');
  });
  it('is a no-op when mediaSession is absent', () => {
    (globalThis as unknown as { navigator: { mediaSession?: unknown } }).navigator = {};
    expect(() =>
      setMediaMetadata(
        { uri: 'x', name: 'n', artists: [], album: { name: '', images: [] } },
        null,
      ),
    ).not.toThrow();
  });
});

describe('setMediaActionHandlers', () => {
  it('registers play, pause, previoustrack, nexttrack, seekto', () => {
    const store = { togglePlay: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
    setMediaActionHandlers(store);
    const h = (navigator.mediaSession as unknown as { __handlers: Map<string, unknown> }).__handlers;
    expect(h.has('play')).toBe(true);
    expect(h.has('pause')).toBe(true);
    expect(h.has('previoustrack')).toBe(true);
    expect(h.has('nexttrack')).toBe(true);
    expect(h.has('seekto')).toBe(true);
  });
  it('seekto handler forwards seekTime', () => {
    const store = { togglePlay: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
    setMediaActionHandlers(store);
    const h = (navigator.mediaSession as unknown as { __handlers: Map<string, (d: unknown) => void> }).__handlers;
    h.get('seekto')!({ seekTime: 42.5 });
    expect(store.seek).toHaveBeenCalledWith(42500); // ms
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/media-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/playback/media-session.ts`:

```ts
import { stars } from './stars';

export interface TrackForMeta {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string; width?: number; height?: number }[] };
}

export interface MediaActions {
  togglePlay(): void | Promise<void>;
  next(): void | Promise<void>;
  prev(): void | Promise<void>;
  seek(positionMs: number): void | Promise<void>;
}

function ms(): MediaSession | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator).mediaSession ?? null;
}

export function setMediaMetadata(track: TrackForMeta, ratingHalfSteps: number | null): void {
  const s = ms();
  if (!s) return;
  const prefix = stars(ratingHalfSteps);
  const title = prefix ? `${prefix} ${track.name}` : track.name;
  s.metadata = new MediaMetadata({
    title,
    artist: track.artists.map((a) => a.name).join(', '),
    album: track.album.name,
    artwork: track.album.images.map((i) => ({
      src: i.url,
      sizes: i.width && i.height ? `${i.width}x${i.height}` : undefined,
    })) as MediaImage[],
  });
}

export function setMediaActionHandlers(store: MediaActions): void {
  const s = ms();
  if (!s) return;
  const safe = (name: MediaSessionAction, fn: (details: MediaSessionActionDetails) => void) => {
    try {
      s.setActionHandler(name, fn);
    } catch {
      // Some platforms throw NotSupportedError for unsupported actions; ignore.
    }
  };
  safe('play', () => void store.togglePlay());
  safe('pause', () => void store.togglePlay());
  safe('previoustrack', () => void store.prev());
  safe('nexttrack', () => void store.next());
  safe('seekto', (d) => {
    if (typeof d.seekTime === 'number') store.seek(Math.round(d.seekTime * 1000));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/media-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback/media-session.ts tests/unit/media-session.test.ts
git commit -m "playback: mediaSession metadata + action handlers"
```

## Task B5: SDK loader + ambient types

**Files:**
- Create: `src/lib/playback/sdk-loader.ts`
- Create: `src/lib/playback/spotify-sdk.d.ts`

- [ ] **Step 1: Ambient types**

`src/lib/playback/spotify-sdk.d.ts` — minimal subset we actually use:

```ts
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }

  namespace Spotify {
    type ErrorTypes =
      | 'initialization_error'
      | 'authentication_error'
      | 'account_error'
      | 'playback_error';

    interface Error { message: string }

    interface Track {
      uri: string;
      id: string | null;
      name: string;
      duration_ms: number;
      artists: { uri: string; name: string }[];
      album: {
        uri: string;
        name: string;
        images: { url: string; width?: number; height?: number }[];
      };
    }

    interface PlaybackState {
      paused: boolean;
      position: number;
      duration: number;
      context: { uri: string | null; metadata?: unknown };
      track_window: {
        current_track: Track;
        previous_tracks: Track[];
        next_tracks: Track[];
      };
    }

    interface PlayerInit {
      name: string;
      getOAuthToken: (cb: (token: string) => void) => void;
      volume?: number;
    }

    class Player {
      constructor(init: PlayerInit);
      connect(): Promise<boolean>;
      disconnect(): void;
      addListener(event: 'ready' | 'not_ready', cb: (d: { device_id: string }) => void): boolean;
      addListener(event: 'player_state_changed', cb: (d: PlaybackState | null) => void): boolean;
      addListener(event: ErrorTypes, cb: (d: Error) => void): boolean;
      getCurrentState(): Promise<PlaybackState | null>;
      togglePlay(): Promise<void>;
      previousTrack(): Promise<void>;
      nextTrack(): Promise<void>;
      seek(positionMs: number): Promise<void>;
      activateElement(): Promise<void>;
    }
  }
}

export {};
```

- [ ] **Step 2: SDK loader**

`src/lib/playback/sdk-loader.ts`:

```ts
// Lazily inject the Spotify Web Playback SDK script. Idempotent: repeated calls
// return the same promise. Resolves with the `Spotify` global once the SDK has
// fired `onSpotifyWebPlaybackSDKReady`.

import type {} from './spotify-sdk';

let inflight: Promise<typeof Spotify> | null = null;

export function loadSpotifySdk(): Promise<typeof Spotify> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Spotify SDK only loads in the browser'));
  }
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (inflight) return inflight;

  inflight = new Promise<typeof Spotify>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (window.Spotify) resolve(window.Spotify);
      else reject(new Error('Spotify SDK ready event fired but window.Spotify is undefined'));
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.onerror = () => reject(new Error('Failed to load spotify-player.js'));
    document.head.appendChild(script);
  });

  return inflight;
}

// Test-only escape hatch: lets the mocked-SDK Playwright fixture short-circuit
// the loader by pre-populating window.Spotify before the page mounts.
export function __resetSdkLoaderForTests(): void {
  inflight = null;
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/playback/spotify-sdk.d.ts src/lib/playback/sdk-loader.ts
git commit -m "playback: SDK loader + ambient types"
```

---

# Phase C — Server endpoints

## Task C1: `PUT /api/spotify/player/play`

**Files:**
- Create: `src/routes/api/spotify/player/play/+server.ts`
- Test: `tests/unit/player-play-endpoint.test.ts`

- [ ] **Step 1: Write failing test**

Look at how existing endpoint tests (`tests/unit/ratings.test.ts`, `tests/unit/labels.test.ts`) are structured — they import the handler from `+server.ts` and call it with a mock event. Mirror that.

`tests/unit/player-play-endpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock token + fetch before importing the handler.
vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { PUT } from '../../src/routes/api/spotify/player/play/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('PUT /api/spotify/player/play', () => {
  it('rejects when not logged in', async () => {
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }, null));
    expect(res.status).toBe(401);
  });

  it('rejects when body has neither uris nor context_uri', async () => {
    const res = await PUT(makeEvent({ device_id: 'd' }));
    expect(res.status).toBe(400);
  });

  it('forwards { uris } payload to Spotify with device_id query', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await PUT(
      makeEvent({ uris: ['spotify:track:1', 'spotify:track:2'], device_id: 'dev1' }),
    );
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      uris: ['spotify:track:1', 'spotify:track:2'],
    });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tkn');
  });

  it('forwards { context_uri, offset, position_ms } payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await PUT(
      makeEvent({
        context_uri: 'spotify:playlist:abc',
        offset: { uri: 'spotify:track:1' },
        position_ms: 42000,
        device_id: 'dev1',
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      context_uri: 'spotify:playlist:abc',
      offset: { uri: 'spotify:track:1' },
      position_ms: 42000,
    });
  });

  it('maps 404 NO_ACTIVE_DEVICE', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { reason: 'NO_ACTIVE_DEVICE' } }), { status: 404 }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_active_device' });
  });

  it('maps 403 PREMIUM_REQUIRED', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { reason: 'PREMIUM_REQUIRED' } }), { status: 403 }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'premium_required' });
  });

  it('maps 429 with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '3' } }),
    );
    const res = await PUT(makeEvent({ uris: ['spotify:track:1'], device_id: 'd' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited', retry_after: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/player-play-endpoint.test.ts`
Expected: FAIL — handler module not found.

- [ ] **Step 3: Implement**

`src/routes/api/spotify/player/play/+server.ts`:

```ts
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError } from '$lib/playback/errors';

interface UrisBody { uris: string[]; device_id: string }
interface ContextBody {
  context_uri: string;
  offset?: { uri: string } | { position: number };
  position_ms?: number;
  device_id: string;
}

type Body = Partial<UrisBody> & Partial<ContextBody>;

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json()) as Body;
  const hasUris = Array.isArray(body.uris);
  const hasContext = typeof body.context_uri === 'string';
  if (!body.device_id || (!hasUris && !hasContext)) {
    throw error(400, 'device_id and one of { uris, context_uri } are required');
  }

  const { access_token } = await getValidAccessToken(locals.user.id);

  const payload: Record<string, unknown> = {};
  if (hasUris) payload.uris = body.uris;
  if (hasContext) {
    payload.context_uri = body.context_uri;
    if (body.offset) payload.offset = body.offset;
    if (typeof body.position_ms === 'number') payload.position_ms = body.position_ms;
  }

  const res = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(body.device_id!)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (res.ok) return new Response(null, { status: 204 });

  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* leave as {} */ }
  const mapped = mapSpotifyPlayError(res.status, parsed, res.headers.get('retry-after'));
  // Translate to HTTP status the client can switch on.
  const clientStatus =
    mapped.error === 'no_active_device' ? 409 :
    mapped.error === 'premium_required' ? 402 :
    mapped.error === 'rate_limited' ? 429 :
    502;
  return json(mapped, { status: clientStatus });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/player-play-endpoint.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/spotify/player/play/+server.ts tests/unit/player-play-endpoint.test.ts
git commit -m "api: PUT /api/spotify/player/play (uris or context_uri, mapped errors)"
```

## Task C2: `PUT /api/spotify/player/transfer`

**Files:**
- Create: `src/routes/api/spotify/player/transfer/+server.ts`
- Test: `tests/unit/player-transfer-endpoint.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/player-transfer-endpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { PUT } from '../../src/routes/api/spotify/player/transfer/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/transfer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => fetchMock.mockReset());

describe('PUT /api/spotify/player/transfer', () => {
  it('rejects when not logged in', async () => {
    const res = await PUT(makeEvent({ device_id: 'd' }, null));
    expect(res.status).toBe(401);
  });
  it('requires device_id', async () => {
    const res = await PUT(makeEvent({}));
    expect(res.status).toBe(400);
  });
  it('forwards device_ids + play to Spotify', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await PUT(makeEvent({ device_id: 'dev1', play: false }));
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player');
    expect(JSON.parse(init.body as string)).toEqual({ device_ids: ['dev1'], play: false });
  });
  it('defaults play to false when omitted', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await PUT(makeEvent({ device_id: 'dev1' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ device_ids: ['dev1'], play: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/player-transfer-endpoint.test.ts`
Expected: FAIL — handler module not found.

- [ ] **Step 3: Implement**

`src/routes/api/spotify/player/transfer/+server.ts`:

```ts
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError } from '$lib/playback/errors';

interface Body { device_id: string; play?: boolean }

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json()) as Body;
  if (!body.device_id) throw error(400, 'device_id required');

  const { access_token } = await getValidAccessToken(locals.user.id);

  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [body.device_id], play: body.play ?? false }),
  });

  if (res.ok) return new Response(null, { status: 204 });

  let parsed: unknown = {};
  try { parsed = await res.json(); } catch { /* keep {} */ }
  const mapped = mapSpotifyPlayError(res.status, parsed, res.headers.get('retry-after'));
  const clientStatus =
    mapped.error === 'no_active_device' ? 409 :
    mapped.error === 'premium_required' ? 402 :
    mapped.error === 'rate_limited' ? 429 :
    502;
  return json(mapped, { status: clientStatus });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/player-transfer-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/spotify/player/transfer/+server.ts tests/unit/player-transfer-endpoint.test.ts
git commit -m "api: PUT /api/spotify/player/transfer"
```

---

# Phase D — `PlaybackStore`

## Task D1: Store skeleton + `init()` + token plumbing

**Files:**
- Create: `src/lib/playback/player.svelte.ts`

- [ ] **Step 1: Implement (no test yet — exercised end-to-end via e2e in Phase F)**

`src/lib/playback/player.svelte.ts`:

```ts
// Client-only Svelte 5 rune-based singleton owning the Spotify Web Playback SDK
// player instance. Components consume via getPlaybackStore() (set in root
// layout). Mutations happen only inside methods on the store; reactivity is via
// $state proxies on `state`, `mode`, `error`, `isReady`, `deviceId`.

import { getContext, setContext } from 'svelte';
import { loadSpotifySdk } from './sdk-loader';
import { setMediaActionHandlers, setMediaMetadata, type TrackForMeta } from './media-session';
import { buildQueueFromClick, shuffleFisherYates } from './queue';
import type {} from './spotify-sdk';

const KEY = Symbol('playback');

export type PlaybackError =
  | null
  | 'unsupported'
  | 'auth'
  | 'premium'
  | 'transient'
  | 'disconnected';

export type PlaybackMode = 'idle' | 'shuffle' | 'takeover';

export interface PlaybackState {
  paused: boolean;
  position_ms: number;
  duration_ms: number;
  track: TrackForMeta | null;
  context_uri: string | null;
}

const EMPTY_STATE: PlaybackState = {
  paused: true,
  position_ms: 0,
  duration_ms: 0,
  track: null,
  context_uri: null,
};

export interface PlaybackStore {
  // Reactive (read-only externally)
  readonly state: PlaybackState;
  readonly mode: PlaybackMode;
  readonly error: PlaybackError;
  readonly isReady: boolean;
  readonly deviceId: string | null;
  readonly isActive: boolean;

  // Lifecycle
  init(): Promise<void>;
  destroy(): void;

  // Playback control
  playTrack(uri: string, allUris: readonly string[]): Promise<void>;
  shuffle(uris: readonly string[]): Promise<void>;
  takeover(contextUri: string, trackUri: string, positionMs: number): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;

  // Rating bridge (set by the page that knows the current rating)
  setCurrentRating(uri: string, ratingHalfSteps: number | null): void;
}

export function createPlaybackStore(): PlaybackStore {
  let state = $state<PlaybackState>({ ...EMPTY_STATE });
  let mode = $state<PlaybackMode>('idle');
  let err = $state<PlaybackError>(null);
  let isReady = $state(false);
  let deviceId = $state<string | null>(null);

  // Player handle, set on init.
  let player: Spotify.Player | null = null;
  let initPromise: Promise<void> | null = null;

  // In-memory access-token cache for the SDK callback.
  let cachedToken: { value: string; expires_at: number } | null = null;
  let tokenInflight: Promise<string> | null = null;

  // Last-known per-URI rating, used to render the lock-screen title.
  const ratingByUri = new Map<string, number | null>();

  // Queue maintenance state.
  let lastShuffleFilterUris: string[] | null = null;
  let played: Set<string> = new Set();

  async function fetchAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expires_at - now > 30_000) return cachedToken.value;
    if (tokenInflight) return tokenInflight;
    tokenInflight = (async () => {
      const res = await fetch('/api/spotify/access-token');
      if (!res.ok) throw new Error(`access-token ${res.status}`);
      const j = (await res.json()) as { access_token: string; expires_at: number };
      cachedToken = { value: j.access_token, expires_at: j.expires_at };
      return j.access_token;
    })().finally(() => { tokenInflight = null; });
    return tokenInflight;
  }

  async function callTransfer(): Promise<void> {
    if (!deviceId) return;
    await fetch('/api/spotify/player/transfer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, play: false }),
    });
  }

  async function callPlay(payload: Record<string, unknown>): Promise<Response> {
    return fetch('/api/spotify/player/play', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, device_id: deviceId }),
    });
  }

  function handleStateChanged(s: Spotify.PlaybackState | null): void {
    if (!s) return;
    const t = s.track_window.current_track;
    state = {
      paused: s.paused,
      position_ms: s.position,
      duration_ms: s.duration,
      track: t
        ? {
            uri: t.uri,
            name: t.name,
            artists: t.artists,
            album: { name: t.album.name, images: t.album.images },
          }
        : null,
      context_uri: s.context?.uri ?? null,
    };
    if (t) {
      played.add(t.uri);
      setMediaMetadata(state.track!, ratingByUri.get(t.uri) ?? null);
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const Sdk = await loadSpotifySdk();
        player = new Sdk.Player({
          name: 'disccovery',
          getOAuthToken: (cb) => {
            fetchAccessToken().then(cb).catch(() => {
              err = 'auth';
              cb('');
            });
          },
          volume: 1,
        });

        player.addListener('initialization_error', () => { err = 'unsupported'; });
        player.addListener('authentication_error', () => { err = 'auth'; });
        player.addListener('account_error', () => { err = 'premium'; });
        player.addListener('playback_error', () => { /* per-track toast handled by callers */ });
        player.addListener('ready', ({ device_id }) => {
          deviceId = device_id;
          isReady = true;
          void callTransfer();
        });
        player.addListener('not_ready', () => { isReady = false; });
        player.addListener('player_state_changed', handleStateChanged);

        // iOS Safari autoplay gate must be inside the user gesture that called init().
        try { await player.activateElement(); } catch { /* not iOS, no-op */ }

        const ok = await player.connect();
        if (!ok) err = 'unsupported';

        setMediaActionHandlers({
          togglePlay: () => void player?.togglePlay(),
          next: () => void player?.nextTrack(),
          prev: () => void player?.previousTrack(),
          seek: (ms) => void player?.seek(ms),
        });
      } catch {
        err = 'unsupported';
      }
    })();
    return initPromise;
  }

  function destroy(): void {
    player?.disconnect();
    player = null;
    initPromise = null;
    isReady = false;
    deviceId = null;
  }

  async function playTrack(uri: string, allUris: readonly string[]): Promise<void> {
    await init();
    if (!deviceId) return;
    const queue = buildQueueFromClick(uri, allUris);
    lastShuffleFilterUris = [...allUris];
    played = new Set();
    mode = 'shuffle';
    const res = await callPlay({ uris: queue.slice(0, 100) });
    handlePlayErrorMaybe(res);
  }

  async function shuffle(uris: readonly string[]): Promise<void> {
    await init();
    if (!deviceId) return;
    const ordered = shuffleFisherYates(uris);
    lastShuffleFilterUris = [...uris];
    played = new Set();
    mode = 'shuffle';
    const res = await callPlay({ uris: ordered.slice(0, 100) });
    handlePlayErrorMaybe(res);
  }

  async function takeover(contextUri: string, trackUri: string, positionMs: number): Promise<void> {
    await init();
    if (!deviceId) return;
    mode = 'takeover';
    lastShuffleFilterUris = null;
    const res = await callPlay({
      context_uri: contextUri,
      offset: { uri: trackUri },
      position_ms: positionMs,
    });
    handlePlayErrorMaybe(res);
  }

  async function handlePlayErrorMaybe(res: Response): Promise<void> {
    if (res.ok) { err = null; return; }
    try {
      const body = await res.json();
      if (body?.error === 'premium_required') err = 'premium';
      else if (body?.error === 'no_active_device') {
        await callTransfer();
        // Caller can re-issue play once if they choose; we don't retry implicitly.
        err = 'transient';
      } else if (body?.error === 'rate_limited') err = 'transient';
      else err = 'transient';
    } catch {
      err = 'transient';
    }
  }

  async function togglePlay(): Promise<void> { await player?.togglePlay(); }
  async function next(): Promise<void> { await player?.nextTrack(); }
  async function prev(): Promise<void> { await player?.previousTrack(); }
  async function seek(positionMs: number): Promise<void> { await player?.seek(positionMs); }

  function setCurrentRating(uri: string, ratingHalfSteps: number | null): void {
    ratingByUri.set(uri, ratingHalfSteps);
    if (state.track?.uri === uri) setMediaMetadata(state.track, ratingHalfSteps);
  }

  return {
    get state() { return state; },
    get mode() { return mode; },
    get error() { return err; },
    get isReady() { return isReady; },
    get deviceId() { return deviceId; },
    get isActive() { return isReady && state.track != null; },
    init, destroy,
    playTrack, shuffle, takeover,
    togglePlay, next, prev, seek,
    setCurrentRating,
  };
}

export function setPlaybackStore(store: PlaybackStore): void {
  setContext(KEY, store);
}
export function getPlaybackStore(): PlaybackStore {
  const s = getContext<PlaybackStore | undefined>(KEY);
  if (!s) throw new Error('PlaybackStore not provided; mount setPlaybackStore() in the root layout');
  return s;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors. If `pnpm check` complains about Svelte 5 rune usage in a `.svelte.ts` file, confirm `svelte` is ≥ 5.0; the file name (`.svelte.ts`) opts into rune compilation.

- [ ] **Step 3: Commit**

```bash
git add src/lib/playback/player.svelte.ts
git commit -m "playback: PlaybackStore (SDK lifecycle, modes, queue, rating bridge)"
```

---

# Phase E — UI components

## Task E1: `<PremiumGate />`

**Files:**
- Create: `src/lib/components/PremiumGate.svelte`
- Test: `tests/unit/components/PremiumGate.test.ts`

- [ ] **Step 1: Confirm @testing-library/svelte is installed**

Run: `pnpm list @testing-library/svelte`
If missing, run: `pnpm add -D @testing-library/svelte jsdom`
Then ensure `vitest.config.ts` (or `vite.config.ts` test block) uses `environment: 'jsdom'` for the `tests/unit/components/*` paths. If `vitest.config.ts` does not exist, create it:

```ts
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.{test,spec}.ts'],
  },
});
```

Commit this configuration alone before continuing:

```bash
git add package.json pnpm-lock.yaml vitest.config.ts 2>/dev/null || true
git commit -m "test: enable jsdom environment for component tests" || true
```

(Skip this commit if @testing-library/svelte was already installed.)

- [ ] **Step 2: Write failing test**

`tests/unit/components/PremiumGate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import PremiumGate from '$lib/components/PremiumGate.svelte';

// Test the visible-note behavior only. Snippet children are awkward to mock
// from a unit test; e2e covers the children pass-through via real usage on
// /library and /now-playing.

describe('<PremiumGate />', () => {
  it('does not render the Premium-required note when premium', () => {
    render(PremiumGate, { props: { product: 'premium' } });
    expect(screen.queryByText(/Premium required/i)).toBeNull();
  });
  it('renders the Premium-required note when free', () => {
    render(PremiumGate, { props: { product: 'free' } });
    expect(screen.getByText(/Premium required/i)).toBeTruthy();
  });
  it('renders the Premium-required note for "open" (no Spotify product)', () => {
    render(PremiumGate, { props: { product: 'open' } });
    expect(screen.getByText(/Premium required/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/components/PremiumGate.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 4: Implement**

`src/lib/components/PremiumGate.svelte`:

```svelte
<script lang="ts">
  import type { Snippet } from 'svelte';
  type Product = 'premium' | 'free' | 'open';
  let { product, children }: { product: Product; children?: Snippet } = $props();
  const gated = product !== 'premium';
</script>

{#if gated}
  <div class="inline-flex flex-col items-center gap-1 opacity-50">
    <div class="pointer-events-none" aria-disabled="true">
      {#if children}{@render children()}{/if}
    </div>
    <p class="text-xs text-white/60">Premium required to play in disccovery</p>
  </div>
{:else}
  {#if children}{@render children()}{/if}
{/if}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/unit/components/PremiumGate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/PremiumGate.svelte tests/unit/components/PremiumGate.test.ts
git commit -m "ui: PremiumGate (disable play controls + note when not premium)"
```

## Task E2: `<Transport />`

**Files:**
- Create: `src/lib/components/Transport.svelte`
- Test: `tests/unit/components/Transport.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/components/Transport.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Transport from '$lib/components/Transport.svelte';

function makeStore() {
  return {
    state: { paused: true, position_ms: 0, duration_ms: 100_000, track: null, context_uri: null },
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
  };
}

describe('<Transport />', () => {
  it('renders Play icon when paused, calls togglePlay on click', async () => {
    const store = makeStore();
    const { getByLabelText } = render(Transport, { props: { store } });
    const btn = getByLabelText(/play/i);
    await fireEvent.click(btn);
    expect(store.togglePlay).toHaveBeenCalled();
  });
  it('next/prev buttons call store methods', async () => {
    const store = makeStore();
    const { getByLabelText } = render(Transport, { props: { store } });
    await fireEvent.click(getByLabelText(/next/i));
    await fireEvent.click(getByLabelText(/previous/i));
    expect(store.next).toHaveBeenCalled();
    expect(store.prev).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/components/Transport.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

`src/lib/components/Transport.svelte`:

```svelte
<script lang="ts">
  import type { PlaybackStore } from '$lib/playback/player.svelte';
  let { store }: { store: PlaybackStore } = $props();
</script>

<div class="flex items-center gap-4">
  <button
    aria-label="Previous track"
    class="text-2xl text-white/80 hover:text-white"
    onclick={() => store.prev()}
  >⏮</button>

  <button
    aria-label={store.state.paused ? 'Play' : 'Pause'}
    class="rounded-full bg-spotify-green px-4 py-2 text-2xl text-black hover:opacity-90"
    onclick={() => store.togglePlay()}
  >{store.state.paused ? '▶' : '⏸'}</button>

  <button
    aria-label="Next track"
    class="text-2xl text-white/80 hover:text-white"
    onclick={() => store.next()}
  >⏭</button>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/components/Transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Transport.svelte tests/unit/components/Transport.test.ts
git commit -m "ui: Transport (prev / play-pause / next)"
```

## Task E3: `<MiniPlayer />`

**Files:**
- Create: `src/lib/components/MiniPlayer.svelte`
- Test: `tests/unit/components/MiniPlayer.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/components/MiniPlayer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import MiniPlayer from '$lib/components/MiniPlayer.svelte';

function makeStore(active: boolean) {
  return {
    isActive: active,
    state: {
      paused: false,
      position_ms: 0,
      duration_ms: 0,
      track: active
        ? { uri: 'spotify:track:1', name: 'T', artists: [{ name: 'A' }], album: { name: '', images: [] } }
        : null,
      context_uri: null,
    },
    togglePlay: vi.fn(),
  };
}

describe('<MiniPlayer />', () => {
  it('renders nothing when not active', () => {
    const { container } = render(MiniPlayer, {
      props: { store: makeStore(false), currentRoute: '/library' },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders nothing on /now-playing even when active', () => {
    const { container } = render(MiniPlayer, {
      props: { store: makeStore(true), currentRoute: '/now-playing' },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders track name when active on other routes', () => {
    const { getByText } = render(MiniPlayer, {
      props: { store: makeStore(true), currentRoute: '/library' },
    });
    expect(getByText('T')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/components/MiniPlayer.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

`src/lib/components/MiniPlayer.svelte`:

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let { store, currentRoute }: { store: PlaybackStore; currentRoute: string } = $props();
  const shown = $derived(store.isActive && currentRoute !== '/now-playing');
</script>

{#if shown && store.state.track}
  <button
    type="button"
    class="fixed inset-x-2 bottom-2 z-40 flex items-center gap-3 rounded-lg border border-spotify-green/40 bg-black/80 px-3 py-2 text-left backdrop-blur"
    onclick={() => goto('/now-playing')}
    aria-label="Open now playing"
  >
    <span class="block h-8 w-8 shrink-0 rounded bg-spotify-green/60"></span>
    <span class="flex min-w-0 flex-col">
      <span class="truncate text-sm font-semibold text-white">{store.state.track.name}</span>
      <span class="truncate text-xs text-white/60">
        {store.state.track.artists.map((a) => a.name).join(', ')}
      </span>
    </span>
    <span
      class="ml-auto text-xl text-spotify-green"
      onclick={(e) => { e.stopPropagation(); store.togglePlay(); }}
      role="button"
      tabindex="0"
      aria-label={store.state.paused ? 'Play' : 'Pause'}
    >{store.state.paused ? '▶' : '⏸'}</span>
  </button>
{/if}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/components/MiniPlayer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/MiniPlayer.svelte tests/unit/components/MiniPlayer.test.ts
git commit -m "ui: MiniPlayer (persistent strip when disccovery is source)"
```

## Task E4: `<ContinueHereButton />`

**Files:**
- Create: `src/lib/components/ContinueHereButton.svelte`
- Test: `tests/unit/components/ContinueHereButton.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/components/ContinueHereButton.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ContinueHereButton from '$lib/components/ContinueHereButton.svelte';

function makeStore(active: boolean, takeover = vi.fn()) {
  return {
    isActive: active,
    takeover,
  };
}

describe('<ContinueHereButton />', () => {
  it('renders nothing when no Spotify-elsewhere context', () => {
    const { container } = render(ContinueHereButton, {
      props: { store: makeStore(false), contextUri: null, trackUri: 'x', positionMs: 0 },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders nothing when disccovery is already the source', () => {
    const { container } = render(ContinueHereButton, {
      props: {
        store: makeStore(true),
        contextUri: 'spotify:playlist:p',
        trackUri: 'spotify:track:t',
        positionMs: 123,
      },
    });
    expect(container.textContent?.trim()).toBe('');
  });
  it('renders + calls takeover with args when clicked', async () => {
    const takeover = vi.fn();
    const { getByRole } = render(ContinueHereButton, {
      props: {
        store: makeStore(false, takeover),
        contextUri: 'spotify:playlist:p',
        trackUri: 'spotify:track:t',
        positionMs: 123,
      },
    });
    await fireEvent.click(getByRole('button'));
    expect(takeover).toHaveBeenCalledWith('spotify:playlist:p', 'spotify:track:t', 123);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/components/ContinueHereButton.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

`src/lib/components/ContinueHereButton.svelte`:

```svelte
<script lang="ts">
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    contextUri,
    trackUri,
    positionMs,
  }: {
    store: PlaybackStore;
    contextUri: string | null;
    trackUri: string;
    positionMs: number;
  } = $props();

  const shown = $derived(!store.isActive && contextUri !== null);
</script>

{#if shown && contextUri}
  <button
    type="button"
    class="rounded-full border border-spotify-green px-4 py-2 text-sm text-spotify-green hover:bg-spotify-green/10"
    onclick={() => store.takeover(contextUri, trackUri, positionMs)}
  >Continue in disccovery</button>
{/if}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/components/ContinueHereButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/ContinueHereButton.svelte tests/unit/components/ContinueHereButton.test.ts
git commit -m "ui: ContinueHereButton (take-over Spotify context)"
```

## Task E5: `<ShuffleButton />`

**Files:**
- Create: `src/lib/components/ShuffleButton.svelte`

(No unit test — exercised in e2e specs and the `<PremiumGate />` test pattern is already covered.)

- [ ] **Step 1: Implement**

`src/lib/components/ShuffleButton.svelte`:

```svelte
<script lang="ts">
  import type { PlaybackStore } from '$lib/playback/player.svelte';

  let {
    store,
    getUris,
    label = 'Shuffle',
  }: { store: PlaybackStore; getUris: () => Promise<readonly string[]>; label?: string } = $props();

  let loading = $state(false);

  async function onClick() {
    if (loading) return;
    loading = true;
    try {
      const uris = await getUris();
      if (uris.length > 0) await store.shuffle(uris);
    } finally {
      loading = false;
    }
  }
</script>

<button
  type="button"
  class="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
  disabled={loading}
  onclick={onClick}
  data-testid="shuffle-button"
>
  {loading ? 'Loading…' : `🔀 ${label}`}
</button>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/components/ShuffleButton.svelte
git commit -m "ui: ShuffleButton (shared, async URI provider)"
```

---

# Phase F — Wiring (layout, now-playing, library)

## Task F1: Root layout mounts store + MiniPlayer

**Files:**
- Modify: `src/routes/+layout.svelte`

- [ ] **Step 1: Replace contents**

`src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import favicon from '$lib/assets/favicon.svg';
  import { createPlaybackStore, setPlaybackStore } from '$lib/playback/player.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';

  let { children } = $props();

  const playback = createPlaybackStore();
  setPlaybackStore(playback);
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<MiniPlayer store={playback} currentRoute={page.url.pathname} />
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors. If `$app/state` import fails, fall back to `$app/stores` (`import { page } from '$app/stores'`) and use `$page.url.pathname` inside a `$derived`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/+layout.svelte
git commit -m "ui: mount PlaybackStore + MiniPlayer in root layout"
```

## Task F2: `/now-playing` integration

**Files:**
- Modify: `src/routes/now-playing/+page.svelte`

- [ ] **Step 1: Modify the script section**

Edit `src/routes/now-playing/+page.svelte`. Inside `<script lang="ts">`, add imports and wire the store. The complete script block should read:

```ts
import { onMount } from 'svelte';
import { page } from '$app/state';
import NowPlaying from '$lib/components/NowPlaying.svelte';
import LabelChips from '$lib/components/LabelChips.svelte';
import Transport from '$lib/components/Transport.svelte';
import ContinueHereButton from '$lib/components/ContinueHereButton.svelte';
import ShuffleButton from '$lib/components/ShuffleButton.svelte';
import PremiumGate from '$lib/components/PremiumGate.svelte';
import { getPlaybackStore } from '$lib/playback/player.svelte';

type Playing = {
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  albumArtUrl: string | null;
  durationMs: number;
  progressMs: number | null;
  isPlaying: boolean;
  isrc: string | null;
  contextUri?: string | null;
};

const POLL_MS = 5000;
const playback = getPlaybackStore();
const product = $derived(page.data.user?.product ?? 'open');

let loading = $state(true);
let playing = $state<Playing | null>(null);
let rating = $state<number | null>(null);
let error = $state<string | null>(null);

let interval: ReturnType<typeof setInterval> | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;

async function poll() {
  if (playback.isActive) return; // SDK is the source of truth
  try {
    const res = await fetch('/api/spotify/currently-playing');
    if (!res.ok) { loading = false; return; }
    const data = await res.json();
    if (data.playing == null) {
      playing = null;
      rating = null;
    } else {
      playing = data.playing;
      rating = data.rating ?? null;
    }
  } catch { /* keep last good */ }
  finally { loading = false; }
}

function startPolling() {
  if (interval !== null) return;
  interval = setInterval(poll, POLL_MS);
}
function stopPolling() {
  if (interval !== null) { clearInterval(interval); interval = null; }
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') stopPolling();
  else { poll(); startPolling(); }
}

function setError(msg: string) {
  error = msg;
  if (errorTimer !== null) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { error = null; errorTimer = null; }, 4000);
}
function clearError() {
  error = null;
  if (errorTimer !== null) { clearTimeout(errorTimer); errorTimer = null; }
}

async function handleRate(next: number) {
  // Resolve the URI from whichever source is authoritative.
  const uri = playback.isActive ? playback.state.track?.uri : playing?.uri;
  const isrc = playing?.isrc ?? undefined;
  if (!uri) return;
  const prev = rating;
  rating = next;
  try {
    const res =
      next === 0
        ? await fetch('/api/ratings', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ spotifyTrackUri: uri }),
          })
        : await fetch('/api/ratings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ spotifyTrackUri: uri, ratingHalfSteps: next, isrc }),
          });
    if (!res.ok) {
      rating = prev;
      setError("Couldn't save your rating. Try again.");
      return;
    }
    clearError();
    playback.setCurrentRating(uri, next === 0 ? null : next);
  } catch {
    rating = prev;
    setError("Couldn't save your rating. Check your connection.");
  }
}

async function shuffleEverything(): Promise<readonly string[]> {
  const res = await fetch('/api/library?limit=500');
  if (!res.ok) return [];
  const j = (await res.json()) as { rows: { spotifyTrackUri: string }[] };
  return j.rows.map((r) => r.spotifyTrackUri);
}

onMount(() => {
  poll();
  startPolling();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (errorTimer !== null) clearTimeout(errorTimer);
  };
});

// Keep the rating in sync with the SDK's current track when disccovery owns audio.
$effect(() => {
  if (!playback.isActive || !playback.state.track) return;
  const uri = playback.state.track.uri;
  // Best-effort: fetch the current rating for this URI.
  fetch(`/api/ratings?uri=${encodeURIComponent(uri)}`).then(async (r) => {
    if (!r.ok) return;
    const j = (await r.json()) as { ratingHalfSteps: number | null };
    rating = j.ratingHalfSteps;
    playback.setCurrentRating(uri, j.ratingHalfSteps);
  }).catch(() => {});
});
```

- [ ] **Step 2: Replace the template**

Below `</script>`, replace the template with:

```svelte
<main class="relative flex min-h-screen flex-col items-center justify-center gap-6 p-6">
  <a
    href="/library"
    class="absolute right-4 top-4 text-sm text-spotify-green hover:underline"
  >
    Library
  </a>

  {#if playback.isActive && playback.state.track}
    <!-- disccovery is the audio source: show SDK state + transport. -->
    <NowPlaying
      playing={{
        uri: playback.state.track.uri,
        name: playback.state.track.name,
        artists: playback.state.track.artists.map((a) => a.name),
        album: playback.state.track.album.name,
        albumArtUrl: playback.state.track.album.images[0]?.url ?? null,
        durationMs: playback.state.duration_ms,
        progressMs: playback.state.position_ms,
        isPlaying: !playback.state.paused,
        isrc: null,
      }}
      {rating}
      loading={false}
      onrate={handleRate}
    />
    <PremiumGate {product}>
      <Transport store={playback} />
    </PremiumGate>
    <LabelChips trackUri={playback.state.track.uri} />
  {:else}
    <!-- Spotify-elsewhere or nothing playing. -->
    <NowPlaying {playing} {rating} {loading} onrate={handleRate} />

    {#if playing}
      <PremiumGate {product}>
        <ContinueHereButton
          store={playback}
          contextUri={playing.contextUri ?? null}
          trackUri={playing.uri}
          positionMs={playing.progressMs ?? 0}
        />
      </PremiumGate>
      <LabelChips trackUri={playing.uri} />
    {/if}
  {/if}

  <PremiumGate {product}>
    <ShuffleButton
      store={playback}
      getUris={shuffleEverything}
      label="Shuffle my library"
    />
  </PremiumGate>

  <div aria-live="polite" class="min-h-5 text-sm text-red-400">
    {#if error}{error}{/if}
    {#if playback.error === 'premium'}Premium required to play in disccovery.{/if}
    {#if playback.error === 'unsupported'}Playback unavailable in this browser.{/if}
    {#if playback.error === 'transient'}Playback hiccup — try again.{/if}
  </div>
</main>
```

- [ ] **Step 3: Add `contextUri` to `/api/spotify/currently-playing`**

Open `src/routes/api/spotify/currently-playing/+server.ts` and verify the response includes `contextUri` in the `playing` object. If it does not, add a line like:

```ts
contextUri: data?.context?.uri ?? null,
```

inside the construction of the `playing` payload. If the file structure differs significantly, surface that as a finding and adapt minimally — the goal is one new field on the existing response.

- [ ] **Step 4: Add `GET /api/ratings?uri=…` if absent**

The `$effect` above fetches `/api/ratings?uri=...`. Check `src/routes/api/ratings/+server.ts` for an existing `GET`. If absent, add:

```ts
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = url.searchParams.get('uri');
  if (!uri) throw error(400, 'uri required');
  const row = await db
    .select({ ratingHalfSteps: ratings.ratingHalfSteps })
    .from(ratings)
    .where(and(eq(ratings.userId, locals.user.id), eq(ratings.spotifyTrackUri, uri)))
    .limit(1);
  return json({ ratingHalfSteps: row[0]?.ratingHalfSteps ?? null });
};
```

(With matching imports for `db`, `ratings`, `eq`, `and`, `error`, `json`.)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/now-playing/+page.svelte src/routes/api/spotify/currently-playing/+server.ts src/routes/api/ratings/+server.ts
git commit -m "ui: now-playing as expanded player + continue-here + shuffle"
```

## Task F3: `/library` integration

**Files:**
- Modify: `src/routes/library/+page.svelte`
- Modify: `src/lib/components/LibraryRow.svelte`

- [ ] **Step 1: Click-to-play on `LibraryRow`**

Edit `src/lib/components/LibraryRow.svelte`. Add an optional `onclick` prop and a "playing" indicator. Wrap the row body in a `<button>` (or add `role="button"` + `tabindex="0"` to the existing root, depending on current structure). Preserve existing markup; add:

```svelte
<!-- inside the row root element -->
<button
  type="button"
  class="..."
  data-testid="library-row"
  data-uri={row.spotifyTrackUri}
  data-playing={isPlaying ? 'true' : 'false'}
  onclick={() => onclick?.(row.spotifyTrackUri)}
>
  ...
</button>
```

Add to the `$props()` destructure: `onclick?: (uri: string) => void`, `isPlaying?: boolean`. If the row currently renders a green dot or similar, show it conditionally on `isPlaying`. If the file does not currently take an `onclick`, add it; do not restructure unrelated markup.

- [ ] **Step 2: Wire `/library/+page.svelte`**

Inside the script:

```ts
import { getPlaybackStore } from '$lib/playback/player.svelte';
import ShuffleButton from '$lib/components/ShuffleButton.svelte';
import PremiumGate from '$lib/components/PremiumGate.svelte';
import { page } from '$app/state';

const playback = getPlaybackStore();
const product = $derived(page.data.user?.product ?? 'open');

function onRowClick(uri: string) {
  const all = data.rows.map((r) => r.spotifyTrackUri);
  void playback.playTrack(uri, all);
}

async function getCurrentFilterUris(): Promise<readonly string[]> {
  // Re-query the same filter the page is showing so shuffle uses the live set,
  // including any not yet rendered. Read the URL search params for fidelity.
  const qs = new URLSearchParams(page.url.searchParams);
  qs.set('limit', '500');
  const res = await fetch(`/api/library?${qs.toString()}`);
  if (!res.ok) return data.rows.map((r) => r.spotifyTrackUri);
  const j = (await res.json()) as { rows: { spotifyTrackUri: string }[] };
  return j.rows.map((r) => r.spotifyTrackUri);
}
```

In the template, near the filter chips, insert:

```svelte
<PremiumGate {product}>
  <ShuffleButton store={playback} getUris={getCurrentFilterUris} label="Shuffle" />
</PremiumGate>
```

For each `<LibraryRow />`, pass `onclick={onRowClick}` and `isPlaying={playback.state.track?.uri === row.spotifyTrackUri}`.

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/library/+page.svelte src/lib/components/LibraryRow.svelte
git commit -m "ui: click-to-play + shuffle on /library"
```

---

# Phase G — Mocked Playwright e2e

## Task G1: `mockSpotifySdk` fixture

**Files:**
- Create: `tests/e2e/mocks/spotify-sdk.ts`

- [ ] **Step 1: Implement**

`tests/e2e/mocks/spotify-sdk.ts`:

```ts
import type { Page } from '@playwright/test';

// Injects a fake window.Spotify before any page script runs. Captures the
// listeners the PlaybackStore attaches, lets the test fire synthetic events via
// page.evaluate(window.__mockSpotify.emit, ...).

export async function mockSpotifySdk(page: Page, opts?: { deviceId?: string }): Promise<void> {
  const deviceId = opts?.deviceId ?? 'mock-device-1';
  await page.addInitScript(({ deviceId }) => {
    type Listener = (d: unknown) => void;
    const listeners = new Map<string, Listener[]>();
    function add(ev: string, cb: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(cb);
      return true;
    }
    function emit(ev: string, payload: unknown) {
      (listeners.get(ev) ?? []).forEach((cb) => cb(payload));
    }
    class FakePlayer {
      constructor(_init: { name: string; getOAuthToken: (cb: (t: string) => void) => void }) {
        // Drain the OAuth callback once so getOAuthToken errors surface in tests.
        try { _init.getOAuthToken(() => {}); } catch { /* ignore */ }
      }
      addListener(ev: string, cb: Listener) { return add(ev, cb); }
      async connect() {
        // Synthesize a `ready` event on the next microtask so init() observes it.
        queueMicrotask(() => emit('ready', { device_id: deviceId }));
        return true;
      }
      disconnect() {}
      async getCurrentState() { return null; }
      async togglePlay() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('togglePlay'); }
      async previousTrack() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('previousTrack'); }
      async nextTrack() { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push('nextTrack'); }
      async seek(_ms: number) { (window as unknown as { __mockSpotify: { calls: string[] } }).__mockSpotify.calls.push(`seek:${_ms}`); }
      async activateElement() {}
    }
    (window as unknown as { Spotify: unknown }).Spotify = { Player: FakePlayer };
    (window as unknown as {
      __mockSpotify: { emit: typeof emit; calls: string[] };
    }).__mockSpotify = { emit, calls: [] };
  }, { deviceId });
}

export async function emitSdkState(
  page: Page,
  partial: {
    paused?: boolean;
    position?: number;
    duration?: number;
    track: { uri: string; name: string; artists: { name: string }[]; album: { name: string; images: unknown[] } };
    contextUri?: string | null;
  },
): Promise<void> {
  await page.evaluate((p) => {
    const ms = (window as unknown as {
      __mockSpotify: { emit: (e: string, d: unknown) => void };
    }).__mockSpotify;
    ms.emit('player_state_changed', {
      paused: p.paused ?? false,
      position: p.position ?? 0,
      duration: p.duration ?? p.track.album ? 200_000 : 0,
      context: { uri: p.contextUri ?? null },
      track_window: { current_track: p.track, previous_tracks: [], next_tracks: [] },
    });
  }, partial);
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/mocks/spotify-sdk.ts
git commit -m "test: window.Spotify mock for Playwright"
```

## Task G2: Extend seed to populate `product`

**Files:**
- Modify: `tests/e2e/fixtures/seed.ts`

- [ ] **Step 1: Update `seedTestUser` signature**

Find `seedTestUser` in `tests/e2e/fixtures/seed.ts`. Add an optional `product` argument (default `'premium'`) and include it in the INSERT. Example signature:

```ts
export async function seedTestUser(
  userId: string,
  spotifyId: string,
  product: 'premium' | 'free' | 'open' = 'premium',
): Promise<void> {
  // existing insert, add product to values
}
```

Update its INSERT to include `product`. The existing default `'open'` from the schema makes this safe for older callers; explicit `'premium'` for playback tests is correct.

- [ ] **Step 2: Update existing callers**

Other specs (`labels.spec.ts`, `library.spec.ts`, etc.) currently call `seedTestUser(testUserId(...), testSpotifyId(...))` with two args. They keep working — third arg defaults to `'premium'`. No changes needed unless a spec specifically wants a non-premium user.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/fixtures/seed.ts
git commit -m "test: seedTestUser accepts product (default premium)"
```

## Task G3: `playback-click.spec.ts`

**Files:**
- Create: `tests/e2e/playback-click.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, seedLibrary, cleanupLibrary,
  closeSeedConnection, signSessionCookieValue, SESSION_COOKIE_NAME,
  testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk, emitSdkState } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});

test.afterAll(async () => { await closeSeedConnection(); });

test('clicking a library row plays that track first', async ({ page }) => {
  // Intercept the play call so we can inspect the body without hitting Spotify.
  let lastBody: unknown = null;
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/library');
  const row = page.getByTestId('library-row').first();
  const uri = await row.getAttribute('data-uri');
  expect(uri).toBeTruthy();
  await row.click();

  await expect.poll(() => lastBody, { timeout: 3000 }).not.toBeNull();
  const body = lastBody as { uris: string[]; device_id: string };
  expect(body.uris[0]).toBe(uri);
  expect(body.device_id).toBe('mock-device-1');

  // Synthesize an SDK state-change so the mini-player shows on /library.
  await emitSdkState(page, {
    track: { uri: uri!, name: 'Mock Track', artists: [{ name: 'X' }], album: { name: '', images: [] } },
  });
  await expect(page.getByLabel(/open now playing/i)).toBeVisible();
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/playback-click.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playback-click.spec.ts
git commit -m "e2e: click-to-play on /library"
```

## Task G4: `playback-shuffle.spec.ts`

**Files:**
- Create: `tests/e2e/playback-shuffle.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, seedLibrary, cleanupLibrary,
  closeSeedConnection, signSessionCookieValue, SESSION_COOKIE_NAME,
  testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});
test.afterAll(async () => { await closeSeedConnection(); });

test('shuffle on /library uses current filter', async ({ page }) => {
  let lastBody: { uris?: string[]; device_id?: string } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/library');
  await page.getByTestId('shuffle-button').first().click();
  await expect.poll(() => lastBody.uris?.length ?? 0, { timeout: 3000 }).toBeGreaterThan(0);
  expect(lastBody.device_id).toBe('mock-device-1');
});

test('shuffle on /now-playing fetches full library', async ({ page }) => {
  // Spotify-elsewhere fixture so the page is in "remote control" mode.
  await page.route('**/api/spotify/currently-playing', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ playing: null, rating: null }) }),
  );
  let libraryFetched = false;
  await page.route('**/api/library*', async (route) => {
    libraryFetched = true;
    await route.continue();
  });
  await page.route('**/api/spotify/player/play', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await page.getByTestId('shuffle-button').click();
  await expect.poll(() => libraryFetched, { timeout: 3000 }).toBe(true);
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/playback-shuffle.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playback-shuffle.spec.ts
git commit -m "e2e: shuffle on /library + /now-playing"
```

## Task G5: `playback-takeover.spec.ts`

**Files:**
- Create: `tests/e2e/playback-takeover.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, closeSeedConnection,
  signSessionCookieValue, SESSION_COOKIE_NAME, testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => { await teardownTestUser(testUserId(test.info().workerIndex)); });
test.afterAll(async () => { await closeSeedConnection(); });

test('Continue in disccovery sends context_uri + offset + position', async ({ page }) => {
  await page.route('**/api/spotify/currently-playing', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playing: {
          uri: 'spotify:track:t',
          name: 'X',
          artists: ['A'],
          album: null,
          albumArtUrl: null,
          durationMs: 100000,
          progressMs: 42000,
          isPlaying: true,
          isrc: null,
          contextUri: 'spotify:playlist:p',
        },
        rating: null,
      }),
    }),
  );
  let body: { context_uri?: string; offset?: { uri?: string }; position_ms?: number } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await page.getByRole('button', { name: /continue in disccovery/i }).click();

  await expect.poll(() => body.context_uri, { timeout: 3000 }).toBe('spotify:playlist:p');
  expect(body.offset?.uri).toBe('spotify:track:t');
  expect(body.position_ms).toBe(42000);
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/playback-takeover.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playback-takeover.spec.ts
git commit -m "e2e: take-over of Spotify context"
```

## Task G6: `playback-premium-gate.spec.ts`

**Files:**
- Create: `tests/e2e/playback-premium-gate.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, seedLibrary, cleanupLibrary,
  closeSeedConnection, signSessionCookieValue, SESSION_COOKIE_NAME,
  testUserId, testSpotifyId,
} from './fixtures/seed';

test.beforeEach(async ({ context }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'free');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
});
test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});
test.afterAll(async () => { await closeSeedConnection(); });

test('free account sees Premium required note + disabled controls on /library', async ({ page }) => {
  let playCalled = false;
  await page.route('**/api/spotify/player/play', async (route) => {
    playCalled = true;
    await route.fulfill({ status: 204 });
  });

  await page.goto('/library');
  await expect(page.getByText(/Premium required/i).first()).toBeVisible();

  // Clicking the shuffle button inside PremiumGate should be a no-op (pointer-events:none).
  const wrap = page.getByText(/Premium required/i).first().locator('..');
  await wrap.click({ force: true });
  // Give the page a moment; play must not have been called.
  await page.waitForTimeout(500);
  expect(playCalled).toBe(false);
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/playback-premium-gate.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playback-premium-gate.spec.ts
git commit -m "e2e: PremiumGate disables play controls for non-premium"
```

## Task G7: `playback-errors.spec.ts`

**Files:**
- Create: `tests/e2e/playback-errors.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, seedLibrary, cleanupLibrary,
  closeSeedConnection, signSessionCookieValue, SESSION_COOKIE_NAME,
  testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});
test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});
test.afterAll(async () => { await closeSeedConnection(); });

test('premium_required at play time swaps in PremiumGate state', async ({ page }) => {
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/spotify/player/play', (r) =>
    r.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'premium_required' }) }),
  );
  await page.goto('/now-playing');
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByText(/Premium required to play in disccovery/i).first()).toBeVisible();
});
```

(Per the spec, 404 retry + 429 retry-after behaviour is intentionally tested at the unit level (`mapSpotifyPlayError`) rather than wired through an end-to-end retry loop — the store treats these as a transient error and surfaces a toast; clients can re-tap. Avoid over-specifying the timing here.)

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/playback-errors.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playback-errors.spec.ts
git commit -m "e2e: premium_required at play time → PremiumGate state"
```

## Task G8: `mediasession.spec.ts`

**Files:**
- Create: `tests/e2e/mediasession.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, seedLibrary, cleanupLibrary,
  closeSeedConnection, signSessionCookieValue, SESSION_COOKIE_NAME,
  testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk, emitSdkState } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});
test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});
test.afterAll(async () => { await closeSeedConnection(); });

test('mediaSession title is "★★★★ Track Name" when rated 8 half-steps', async ({ page }) => {
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/spotify/player/play', (r) => r.fulfill({ status: 204 }));
  // Pre-stage the rating fetch the now-playing page does on track change.
  await page.route('**/api/ratings?uri=*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ratingHalfSteps: 8 }) }),
  );

  await page.goto('/now-playing');
  await page.getByTestId('shuffle-button').click();
  await emitSdkState(page, {
    track: {
      uri: 'spotify:track:mock1',
      name: 'My Track',
      artists: [{ name: 'A' }],
      album: { name: 'Alb', images: [] },
    },
  });

  const title = await page.evaluate(() => navigator.mediaSession.metadata?.title ?? '');
  expect(title).toBe('★★★★ My Track');
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e tests/e2e/mediasession.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/mediasession.spec.ts
git commit -m "e2e: mediaSession title formatted as ★★★★ Track"
```

---

# Phase H — Live Spotify suite (local-only)

## Task H1: `live` Playwright project + auth setup

**Files:**
- Create: `tests/live/auth.setup.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update Playwright config**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'pnpm exec vite dev --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live-setup',
      testDir: 'tests/live',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live',
      testDir: 'tests/live',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['live-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/spotify.json',
        launchOptions: { args: ['--mute-audio'] },
      },
    },
  ],
});
```

`pnpm e2e` continues to run only the `e2e` project by default; live runs require an explicit project.

- [ ] **Step 2: Auth setup spec**

`tests/live/auth.setup.ts`:

```ts
import { test as setup, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

const AUTH = '.auth/spotify.json';

setup('authenticate against real Spotify', async ({ page }) => {
  setup.setTimeout(180_000);
  if (existsSync(AUTH) && !process.env.FORCE_REAUTH) {
    setup.skip();
    return;
  }
  mkdirSync('.auth', { recursive: true });

  await page.goto('/');
  await page.getByRole('link', { name: /log in with spotify/i }).click();

  // Hand off to the user. Headed run; user completes OAuth manually.
  // We wait for redirect back to our app (the `/` route after callback).
  await page.waitForURL(/127\.0\.0\.1:5173\/$/, { timeout: 180_000 });
  await expect(page.getByText(/Hi,/i)).toBeVisible();

  await page.context().storageState({ path: AUTH });
});
```

- [ ] **Step 3: package.json scripts**

Add to `package.json` scripts:

```json
"e2e:auth": "playwright test --project=live-setup --headed",
"e2e:live": "playwright test --project=live --headed"
```

- [ ] **Step 4: `.gitignore`**

Append to `.gitignore`:

```
.auth/
```

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/live/auth.setup.ts package.json .gitignore
git commit -m "test: live Playwright project + real-Spotify auth setup"
```

## Task H2: Live specs

**Files:**
- Create: `tests/live/live-click.spec.ts`
- Create: `tests/live/live-shuffle.spec.ts`
- Create: `tests/live/live-mediasession.spec.ts`
- Create: `tests/live/live-takeover.spec.ts`

- [ ] **Step 1: live-click**

`tests/live/live-click.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('clicking a row plays it via real SDK', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/library');
  const row = page.getByTestId('library-row').first();
  await expect(row).toBeVisible();
  const uri = await row.getAttribute('data-uri');
  await row.click();
  // The mini-player appears once player_state_changed fires.
  await expect(page.getByLabel(/open now playing/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/open now playing/i).click();
  // /now-playing should show the same URI.
  await expect(page.locator(`[data-track-uri="${uri}"]`)).toBeVisible({ timeout: 5_000 });
});
```

Note: the `data-track-uri` attribute may need to be added in /now-playing's track render — if so, append a discreet `data-track-uri={track.uri}` to the NowPlaying component root or its parent in `/now-playing/+page.svelte`. Make that edit minimally, commit alongside.

- [ ] **Step 2: live-shuffle**

`tests/live/live-shuffle.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('shuffle on /now-playing plays then advances', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/now-playing');
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByLabel(/^pause$/i)).toBeVisible({ timeout: 20_000 });
  const firstTitle = await page.locator('[data-track-uri]').first().getAttribute('data-track-uri');
  await page.getByLabel(/next track/i).click();
  await expect.poll(async () => page.locator('[data-track-uri]').first().getAttribute('data-track-uri'), { timeout: 15_000 })
    .not.toBe(firstTitle);
});
```

- [ ] **Step 3: live-mediasession**

`tests/live/live-mediasession.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('mediaSession title reflects rating + track name', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/library');
  await page.getByTestId('library-row').first().click();
  await expect.poll(
    async () => await page.evaluate(() => navigator.mediaSession.metadata?.title ?? ''),
    { timeout: 20_000 },
  ).not.toBe('');
  // Star prefix is optional (depends on whether the first row is rated).
  // What we can verify: title is non-empty and ends with the track name.
  const title = await page.evaluate(() => navigator.mediaSession.metadata?.title ?? '');
  expect(title.length).toBeGreaterThan(0);
});
```

- [ ] **Step 4: live-takeover (env-gated)**

`tests/live/live-takeover.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.skip(!process.env.LIVE_TAKEOVER, 'Set LIVE_TAKEOVER=1 and start Spotify-elsewhere on a playlist first');

test('takes over the active Spotify context', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/now-playing');
  await expect(page.getByRole('button', { name: /continue in disccovery/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /continue in disccovery/i }).click();
  await expect(page.getByLabel(/^pause$/i)).toBeVisible({ timeout: 15_000 });
});
```

- [ ] **Step 5: Commit**

```bash
git add tests/live/live-click.spec.ts tests/live/live-shuffle.spec.ts tests/live/live-mediasession.spec.ts tests/live/live-takeover.spec.ts
git commit -m "test: live Spotify suite (click, shuffle, mediasession, takeover)"
```

---

# Phase I — Final gates

## Task I1: Full check + e2e

- [ ] **Step 1: vitest**

Run: `pnpm test`
Expected: every unit test in this plan + every existing unit test PASS.

- [ ] **Step 2: svelte-check**

Run: `pnpm check`
Expected: no errors. Address any new strict-mode complaints inline.

- [ ] **Step 3: mocked e2e**

Run: `pnpm e2e`
Expected: every spec (existing + Phase G) PASS.

- [ ] **Step 4: live e2e (local)**

Run: `pnpm e2e:auth` (one-time, headed; user completes OAuth)
Run: `pnpm e2e:live`
Expected: all live specs PASS except `live-takeover.spec.ts` (skipped without `LIVE_TAKEOVER=1`).

## Task I2: User live smoke

- [ ] **Step 1: Manual checklist (user)**

User exercises on a real iOS or Android device:

- Open the deployed/dev URL in mobile Chrome/Safari.
- Log in with Premium account.
- Open /library → tap a row → audio starts → mini-player appears on subsequent screens.
- Lock the device → lock-screen shows `★★★★ Song Name` (or just `Song Name` if unrated).
- Use lock-screen prev/next/play/pause buttons → SDK responds.
- From /now-playing with Spotify playing elsewhere → "Continue in disccovery" → audio transfers.
- "Shuffle my library" on /now-playing → playback starts.
- Free-account browser (separate session if available) → controls disabled with note.

## Task I3: Tag the plan

- [ ] **Step 1: Tag**

After user confirms the live smoke:

```bash
git tag -a plan-5-playback -m "Plan 5: in-app playback (Web Playback SDK)"
```

- [ ] **Step 2: Update roadmap memory**

(Handled by the parent session.)

---

## Notes for the implementer

- **DRY:** the play / transfer endpoints share their error-translation step but are intentionally not factored into a helper yet — the second usage site is enough, the third would justify extraction.
- **YAGNI:** queue replenishment (≤ 5 unplayed → POST queue refill) is described in the spec but **not yet implemented in this plan**. Live testing will reveal whether long shuffle sessions actually exhaust the first 100 URIs; if so, add it in a follow-up task. Keep the placeholder `lastShuffleFilterUris` + `played` set in the store so the follow-up is straightforward.
- **Page-hidden / disconnect recovery** (spec §4.6): also deferred. The SDK's `not_ready` listener flips `isReady` to false; the user re-taps a play control to re-init. The proactive `getCurrentState()` re-sync on `visibilitychange` is a quality-of-life refinement worth adding only if live smoke surfaces a problem.
- **TDD:** every task starts with a failing test, except component scaffolding for `<ShuffleButton />` (UI-only, covered in e2e) and the store itself (exercised entirely via the mocked-SDK e2e suite).
- **Commits:** one per task, descriptive, no Claude trailer.
- **If a step's assumed file structure doesn't match reality** (e.g., `/api/ratings` doesn't have a GET handler shape resembling the snippet), make the smallest adaptation that preserves the behaviour described, and call it out in the commit message.
