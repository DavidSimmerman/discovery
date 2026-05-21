# disccovery — Plan 2: Currently-playing + Rating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logged-in user opens disccovery, sees the track they're currently playing in Spotify (anywhere — phone app, desktop app, web), and can rate it in ½-star increments. The rating persists to Postgres and surfaces back the next time they see the track. End state at the close of this plan: now-playing screen at `/now-playing`, polled refresh while foregrounded, half-star tap UI wired to ratings endpoints, Playwright covers the happy path against a mocked Spotify server.

**Architecture:**
- Currently-playing comes from `GET /me/player/currently-playing` (HTTP polling — 5s while foregrounded, paused while backgrounded via Page Visibility API). SDK-based detection is deferred to Plan 5.
- Ratings are upserts on a `(user_id, spotify_track_uri)` composite key, stored as half-steps 1–10. A `DELETE` clears.
- Track metadata is cached in a `tracks` table the first time disccovery encounters a track so the library screen later doesn't depend on Spotify being reachable.
- All Spotify API calls flow through a new `getValidAccessToken(userId)` server helper that handles refresh + concurrent-refresh protection. The old `/api/spotify/access-token` endpoint stays for the browser SDK in Plan 5; server-to-Spotify calls stop loopback-fetching it.

**Tech Stack:** Same as Plan 1. Adds MSW for mocking Spotify in tests.

**Pre-flight:** Plan 1 complete and smoke-tested (tag `plan-1-foundation` exists). A user row + a `spotify_tokens` row exist in the dev DB.

---

## File structure (additions / changes)

```
discovery/
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   └── schema.ts            # +ratings, +tracks
│   │   │   ├── spotify.ts               # +fetchCurrentlyPlaying, +fetchTrack
│   │   │   ├── tokens.ts                # NEW — getValidAccessToken(userId)
│   │   │   └── tracks.ts                # NEW — upsertTrack helper
│   │   └── components/
│   │       ├── Star.svelte              # NEW — half-star SVG, sized via prop
│   │       ├── StarRating.svelte        # NEW — 5 stars + tap zones
│   │       └── NowPlaying.svelte        # NEW — composes art + meta + rating
│   └── routes/
│       ├── now-playing/
│       │   ├── +page.svelte             # NEW — polls + renders NowPlaying
│       │   └── +page.server.ts          # NEW — requires auth
│       └── api/
│           ├── spotify/
│           │   ├── access-token/+server.ts   # refactored to use tokens.ts
│           │   ├── me/+server.ts             # refactored to use tokens.ts (no loopback)
│           │   └── currently-playing/+server.ts  # NEW
│           └── ratings/
│               └── +server.ts           # NEW — PUT/DELETE
├── drizzle/                             # +new migration for ratings + tracks
└── tests/
    ├── unit/
    │   ├── tokens.test.ts               # NEW
    │   └── ratings.test.ts              # NEW — endpoint logic with stubbed db
    └── e2e/
        ├── mocks/
        │   └── spotify.ts               # NEW — MSW handlers
        └── rating.spec.ts               # NEW
```

Existing files touched: `src/lib/server/db/schema.ts`, `src/lib/server/spotify.ts`, `src/routes/api/spotify/access-token/+server.ts`, `src/routes/api/spotify/me/+server.ts`, `src/routes/+page.svelte` (add "Go to now-playing" link when logged in).

---

## Task 1: Carve out `getValidAccessToken(userId)` server helper

**Why first:** every other task needs it. Eliminates the loopback `fetch('/api/spotify/access-token')` in `/api/spotify/me` and gives us one place to add concurrent-refresh protection.

**Files:**
- Create: `src/lib/server/tokens.ts`, `tests/unit/tokens.test.ts`
- Edit: `src/routes/api/spotify/access-token/+server.ts`, `src/routes/api/spotify/me/+server.ts`

- [ ] **Step 1:** Create `src/lib/server/tokens.ts` exporting `async function getValidAccessToken(userId: string): Promise<string>`. Logic: read `spotify_tokens` row, if `expiresAt - now > 60_000` return `access_token`, else decrypt `refresh_token_enc`, call `refreshAccessToken`, re-encrypt new refresh token (Spotify may rotate it), update the row, return new `access_token`.
- [ ] **Step 2:** Add concurrent-refresh protection. Two acceptable approaches — pick one and document it in a comment:
   - (A) Per-process `Map<userId, Promise<string>>` — first refresh wins, subsequent callers await the same promise.
   - (B) Postgres advisory lock keyed on `hashtext(user_id::text)` around the refresh path.
   Either is fine for a single-instance deployment. Pick (A) for simplicity; revisit if/when multi-instance.
- [ ] **Step 3:** Refactor `src/routes/api/spotify/access-token/+server.ts` to be a thin wrapper: read `locals.user`, call `getValidAccessToken`, return `{ access_token, expires_at }`. Delete the inline refresh logic.
- [ ] **Step 4:** Refactor `src/routes/api/spotify/me/+server.ts` to call `getValidAccessToken(locals.user.id)` directly (no internal `fetch`). Call `fetchSpotifyMe(token)`.
- [ ] **Step 5:** Write `tests/unit/tokens.test.ts`. Cover: (a) returns cached token when not expired, (b) refreshes when expired, (c) preserves old refresh token when Spotify omits one, (d) concurrent callers share a single in-flight refresh (assert `refreshAccessToken` called exactly once when two `getValidAccessToken` calls overlap). Mock the db client + the spotify module.
- [ ] **Step 6:** Run `pnpm exec vitest run` — green. Run existing Playwright suite — still green.
- [ ] **Step 7:** Commit: `refactor(tokens): single-flight getValidAccessToken; drop loopback fetch`.

---

## Task 2: Drizzle schema — ratings + tracks

**Files:**
- Edit: `src/lib/server/db/schema.ts`
- Generate: new migration under `drizzle/`

- [ ] **Step 1:** Add `tracks` table to schema:
  - `spotifyTrackUri` (text, PK)
  - `isrc` (text, nullable)
  - `title` (text, not null)
  - `artists` (text array, not null)
  - `album` (text, nullable)
  - `albumArtUrl` (text, nullable)
  - `durationMs` (integer, nullable)
  - `fetchedAt` (timestamptz, default now)
- [ ] **Step 2:** Add `ratings` table:
  - `userId` (uuid, FK users.id, CASCADE)
  - `spotifyTrackUri` (text, not null)
  - `isrc` (text, nullable)
  - `ratingHalfSteps` (smallint, not null, check between 1 and 10)
  - `ratedAt` (timestamptz, default now)
  - composite PK `(userId, spotifyTrackUri)`
- [ ] **Step 3:** Generate the migration: `pnpm drizzle-kit generate`. Inspect the SQL — confirm the check constraint made it in (Drizzle's check support varies by version; if it didn't, add a raw `sql\`` snippet in the schema or hand-edit the migration to include `CHECK (rating_half_steps BETWEEN 1 AND 10)`).
- [ ] **Step 4:** Run `pnpm drizzle-kit migrate` against the local DB. Verify tables exist via `\dt` in psql.
- [ ] **Step 5:** Commit: `db: ratings + tracks tables`.

---

## Task 3: Spotify client — currently-playing + track-fetch helpers

**Files:**
- Edit: `src/lib/server/spotify.ts`

- [ ] **Step 1:** Add `async function fetchCurrentlyPlaying(accessToken: string)`. GET `https://api.spotify.com/v1/me/player/currently-playing`. Spotify returns:
   - `204 No Content` when nothing is playing → return `null`.
   - `200` with `{ is_playing, item, progress_ms, ... }` → return the parsed body.
   - Anything else → throw with status code in the message.
- [ ] **Step 2:** Add `async function fetchTrack(accessToken: string, trackId: string)`. GET `https://api.spotify.com/v1/tracks/{id}`. Used later by the library cache; expose now so Plan 4 doesn't have to touch `spotify.ts`.
- [ ] **Step 3:** TypeScript: shape the return of `fetchCurrentlyPlaying` as a minimal local type (`uri`, `name`, `artists: { name }[]`, `album: { name, images: { url, width, height }[] }`, `duration_ms`, `external_ids?: { isrc }`, plus `progress_ms` and `is_playing` at the top level). Don't pull in `@spotify/web-api-ts-sdk` for this — overkill.
- [ ] **Step 4:** Commit: `spotify: currently-playing + track fetch helpers`.

---

## Task 4: Track-cache upsert helper

**Files:**
- Create: `src/lib/server/tracks.ts`

- [ ] **Step 1:** Export `async function upsertTrack(track: SpotifyTrack): Promise<void>`. Maps the Spotify track shape → `tracks` row, runs `db.insert(tracks).values(...).onConflictDoUpdate({ target: tracks.spotifyTrackUri, set: { ...same fields, fetchedAt: new Date() } })`. Pick the largest available album image for `albumArtUrl`. Pull ISRC from `external_ids?.isrc` if present.
- [ ] **Step 2:** Export the `SpotifyTrack` input type (subset of the Spotify API response — same shape we're calling out in Task 3 Step 3).
- [ ] **Step 3:** No new test file — this is a thin DB call; it'll be exercised end-to-end in the rating-flow test (Task 9).
- [ ] **Step 4:** Commit: `db: upsertTrack helper`.

---

## Task 5: `GET /api/spotify/currently-playing`

**Files:**
- Create: `src/routes/api/spotify/currently-playing/+server.ts`

- [ ] **Step 1:** GET handler. Require `locals.user` (401 otherwise). Call `getValidAccessToken(locals.user.id)`. Call `fetchCurrentlyPlaying(token)`. If `null`, return `{ playing: null }`. Otherwise:
  - Call `upsertTrack(body.item)` (fire-and-forget is fine here — `await` but don't fail the response if the upsert throws; just log).
  - Look up the user's existing rating for this `item.uri` (single SELECT).
  - Return `{ playing: { uri, name, artists, album, albumArtUrl, durationMs, progressMs, isPlaying, isrc }, rating: ratingHalfSteps | null }`.
- [ ] **Step 2:** Add `Cache-Control: no-store` on the response — this is per-user and time-sensitive.
- [ ] **Step 3:** Commit: `api: /api/spotify/currently-playing with rating lookup`.

---

## Task 6: `PUT /api/ratings` + `DELETE /api/ratings`

**Files:**
- Create: `src/routes/api/ratings/+server.ts`, `tests/unit/ratings.test.ts`

- [ ] **Step 1:** PUT handler. Body: `{ spotifyTrackUri: string, ratingHalfSteps: number, isrc?: string }`. Validate: `spotifyTrackUri` matches `/^spotify:track:[A-Za-z0-9]{22}$/`; `ratingHalfSteps` is an integer 1–10. Require `locals.user`. Upsert into `ratings` via `onConflictDoUpdate` on `(userId, spotifyTrackUri)`, setting `ratingHalfSteps`, `isrc`, and `ratedAt = now()`. Return `{ ok: true, ratingHalfSteps }`.
- [ ] **Step 2:** DELETE handler. Body: `{ spotifyTrackUri: string }`. Validate URI. Require `locals.user`. `db.delete(ratings).where(and(eq(ratings.userId, ...), eq(ratings.spotifyTrackUri, ...)))`. Return `{ ok: true }`.
- [ ] **Step 3:** Unit tests: stub the db client (e.g. `vi.mock('$lib/server/db')`). Cover (a) PUT with valid body succeeds, (b) PUT with `ratingHalfSteps=0` returns 400, (c) PUT with `ratingHalfSteps=11` returns 400, (d) PUT with malformed URI returns 400, (e) PUT without `locals.user` returns 401, (f) DELETE happy path, (g) DELETE without user returns 401.
- [ ] **Step 4:** Run vitest — green.
- [ ] **Step 5:** Commit: `api: PUT/DELETE /api/ratings with validation`.

---

## Task 7: Star + StarRating components

**Files:**
- Create: `src/lib/components/Star.svelte`, `src/lib/components/StarRating.svelte`

- [ ] **Step 1:** `Star.svelte` props: `fill: 'empty' | 'half' | 'full'`, `size: number` (px). Renders a single SVG star using a clipPath for the half-fill. Filled color `#1DB954`, empty stroke `#444`. No interaction logic here — pure presentation.
- [ ] **Step 2:** `StarRating.svelte` props: `value: number` (0–10 half-steps), `size: number` (default 32), `interactive: boolean` (default false), `onchange?: (next: number) => void`. Renders 5 `<Star>` components. Each star is wrapped in a container with two left/right tap zones (only when `interactive`). Left zone → half (n*2 - 1), right zone → full (n*2). Tapping the same value clears (sets to 0). Reads keyboard arrow events when focused for accessibility (Left/Right shifts by 1 half-step, Home/End for 0/10).
- [ ] **Step 3:** Don't fetch or persist in the component — just `onchange`. Persistence lives in the consumer (NowPlaying).
- [ ] **Step 4:** Visual sanity-check by mounting it in a throwaway test route or storybook — optional, but eyeball the half-fill before moving on.
- [ ] **Step 5:** Commit: `ui: Star + StarRating components (half-step, tap zones)`.

---

## Task 8: Now-playing screen wired end-to-end

**Files:**
- Create: `src/routes/now-playing/+page.svelte`, `src/routes/now-playing/+page.server.ts`, `src/lib/components/NowPlaying.svelte`
- Edit: `src/routes/+page.svelte` (add link for logged-in users)

- [ ] **Step 1:** `+page.server.ts`: if `locals.user` is null, throw `redirect(303, '/')`. Otherwise return `{}` (page does its own client-side fetch — keeps the server route off the polling path).
- [ ] **Step 2:** `+page.svelte`: on mount, start polling `/api/spotify/currently-playing` every 5s. Use `document.visibilityState`: pause polling while hidden, immediately fetch on visible. Clear the interval on destroy.
- [ ] **Step 3:** Compose `<NowPlaying>` with the response. Props: `playing`, `rating`. NowPlaying renders album art (square, rounded), title, artists, and `<StarRating interactive value={rating ?? 0} onchange={...} size=42>`.
- [ ] **Step 4:** `onchange` handler in NowPlaying: optimistic update local `rating`, fire `PUT /api/ratings` (or `DELETE` if next === 0). On error: revert + show a toast (re-use any existing toast util or add a minimal inline `aria-live` message — don't pull in a toast lib for this).
- [ ] **Step 5:** Empty state: when `playing === null`, show "Nothing playing in Spotify right now" + a subtle hint to open Spotify and press play. Keep polling.
- [ ] **Step 6:** Loading state: first poll in flight, no cached data → centered spinner or skeleton. Subsequent polls update silently.
- [ ] **Step 7:** Update `src/routes/+page.svelte`: when `data.user` is set, add a primary CTA linking to `/now-playing`.
- [ ] **Step 8:** Smoke in the browser — log in, play a song in Spotify on any device, open `/now-playing`, see the song, tap stars, refresh the page, rating still there.
- [ ] **Step 9:** Commit: `ui: now-playing screen with polling + rating`.

---

## Task 9: MSW-mocked Playwright e2e for the rating flow

**Files:**
- Create: `tests/e2e/mocks/spotify.ts`, `tests/e2e/rating.spec.ts`
- Edit: `playwright.config.ts` if test setup needs adjusting

- [ ] **Step 1:** Use Playwright's `page.route()` (not MSW — Playwright's built-in interception is simpler here and keeps deps minimal). Intercept outbound calls in `tests/e2e/mocks/spotify.ts`: helper that takes a `page` and registers routes for `https://api.spotify.com/v1/me/player/currently-playing` returning a fixture track, and `https://accounts.spotify.com/api/token` returning a fake access/refresh-token pair.
- [ ] **Step 2:** Pre-seed a test user + spotify_tokens row. Easiest: a `tests/e2e/fixtures/seed.ts` that connects via the same Drizzle client and inserts a known user with a known encrypted refresh token (encrypted with the test `TOKEN_ENC_KEY`). Tear down by deleting the user (cascade clears tokens/ratings).
- [ ] **Step 3:** Set a session cookie directly via `context.addCookies()` using the same HMAC-signing helper from `session.ts` — bypass the OAuth round trip entirely. The session cookie helper is internal, but the test can import it.
- [ ] **Step 4:** Test 1: nav to `/now-playing`, assert the fixture track title renders, tap the 4th star → expect a PUT to `/api/ratings` with `ratingHalfSteps: 8`. Reload page → expect 4 full stars rendered.
- [ ] **Step 5:** Test 2: clear the rating (tap the same star again) → expect DELETE → expect 0 stars on reload.
- [ ] **Step 6:** Test 3: Spotify returns 204 (mock the currently-playing route to reply 204) → expect the empty state copy.
- [ ] **Step 7:** Make sure Playwright tearDown deletes the seeded user. Run `pnpm exec playwright test` — all green.
- [ ] **Step 8:** Commit: `e2e: rating flow against mocked Spotify`.

---

## Task 10: Final integration pass

- [ ] **Step 1:** Run `pnpm exec vitest run` — all green.
- [ ] **Step 2:** Run `pnpm exec svelte-check` — 0 errors, 0 warnings.
- [ ] **Step 3:** Run `pnpm exec playwright test` — all green.
- [ ] **Step 4:** Smoke in the browser: log in → open `/now-playing` while Spotify is playing → rate → reload → rating persists → clear → reload → cleared.
- [ ] **Step 5:** Tag `plan-2-rating`.

---

## Out of scope (deferred to later plans)

- Labels (Plan 3).
- Library / history browse + search (Plan 4).
- In-app playback via Web Playback SDK + custom lock-screen title (Plan 5).
- PWA manifest + service worker + visual polish (Plan 6).
- SDK-based currently-playing (instant `player_state_changed` events) — Plan 5 will replace HTTP polling when disccovery is the audio source.
- "Listen more / less" badges in the now-playing UI — explicitly punted by the user during brainstorming.
