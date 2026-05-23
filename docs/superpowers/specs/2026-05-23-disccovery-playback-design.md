# Plan 5 — In-app playback (Web Playback SDK)

**Date:** 2026-05-23
**Status:** Design
**Builds on:** `2026-05-19-disccovery-design.md` (master design — playback section, lines 167–223), plan-1-foundation, plan-2-rating, plan-3-labels, plan-4-library.

This plan ships in-app playback for disccovery using the Spotify Web Playback SDK. The master design spec already locks in the high-level architecture (SDK runs only in the browser, Premium required, iOS `activateElement()` gesture rule, mediaSession lock-screen title). This document records the Plan 5-specific decisions: UI surface, entry points, queue semantics, error mapping, and testing strategy.

## 1. Scope

In:

- SDK device lifecycle (lazy load, gesture-gated init, register as active device).
- Click-to-play from /library: clicked track first, rest of current filter shuffled as the queue.
- Shuffle button on /library (current filter) and on /now-playing (full rated library).
- Take-over: "Continue in disccovery" button on /now-playing when Spotify-elsewhere has an active context.
- /now-playing as the expanded player when disccovery is the source — adds transport controls on top of the existing rating UI.
- Persistent mini-player on non-/now-playing routes while disccovery is the source; tap → /now-playing.
- Lock-screen / OS media-control title via `navigator.mediaSession.metadata` rendered as `★★★★ Track Name`; action handlers for play/pause/prev/next/seek.
- Premium gating: free accounts see disabled play/shuffle/continue controls with an inline "Premium required" note. Rating + labeling unaffected.
- Short-lived access-token endpoint for the SDK's `getOAuthToken` callback, reusing Plan 2's single-flight refresh.

Not in (deferred to Plan 6 or later):

- PWA manifest / service worker.
- Frontend-design polish pass.
- Tab bar / bottom navigation.
- Mobile-only Premium plan support (excluded by the master spec).

## 2. Components & files

### New

- `src/lib/playback/player.svelte.ts` — `PlaybackStore` (Svelte 5 rune-based singleton). Owns SDK `Player` instance, `deviceId`, `state` (`{ paused, position_ms, duration_ms, track, context_uri, queue }`), `mode` (`'idle' | 'takeover' | 'shuffle'`), `isReady`, `error`. Exposes `init()`, `playTrack(uri, queue)`, `shuffle(uris)`, `takeover()`, `togglePlay()`, `next()`, `prev()`, `seek(ms)`.
- `src/lib/playback/sdk-loader.ts` — Dynamic `<script>` loader for `https://sdk.scdn.co/spotify-player.js`. Returns a promise that resolves with `window.Spotify`. Idempotent.
- `src/lib/playback/media-session.ts` — `setMediaMetadata(track, rating)` + `setMediaActionHandlers(store)`. Side-effect functions on `navigator.mediaSession`, feature-detected.
- `src/lib/playback/stars.ts` — `stars(rating: number | null): string` → `"★★★★½"` etc.
- `src/lib/playback/queue.ts` — Pure helpers: `shuffleFisherYates(uris)`, `buildQueueFromClick(clickedUri, allUris)` (clicked first, rest shuffled).
- `src/lib/components/MiniPlayer.svelte` — Bottom strip when `store.isActive && route !== '/now-playing'`.
- `src/lib/components/Transport.svelte` — Prev / play-pause / next / seek-bar.
- `src/lib/components/ContinueHereButton.svelte` — "Continue in disccovery" on /now-playing.
- `src/lib/components/ShuffleButton.svelte` — Shared CTA. Props: `getUris: () => Promise<string[]>`, label.
- `src/lib/components/PremiumGate.svelte` — Wraps play controls; disabled + inline note when `user.product !== 'premium'`.
- `src/routes/api/spotify/access-token/+server.ts` — `GET` returns `{ access_token, expires_in }`, backed by `getValidAccessToken`.
- `src/routes/api/spotify/player/transfer/+server.ts` — `PUT` → Spotify `PUT /me/player`.
- `src/routes/api/spotify/player/play/+server.ts` — `PUT` → Spotify `PUT /me/player/play`. Accepts either `{ uris }` or `{ context_uri, offset, position_ms }`.

### Modified

- `src/routes/+layout.svelte` — Mount `<MiniPlayer />`; initialize `PlaybackStore` via context.
- `src/routes/now-playing/+page.svelte` — Conditionally render `<Transport />` (disccovery is source) and `<ContinueHereButton />` (Spotify-elsewhere has context). Wrap play CTAs in `<PremiumGate />`. Add "Shuffle my library" button.
- `src/routes/library/+page.svelte` — `<LibraryRow />` becomes clickable → `store.playTrack(uri, currentFilterUris)`. Add `<ShuffleButton />` near filter chips.
- `src/lib/components/LibraryRow.svelte` — `onclick` / `role="button"`; visual "playing" indicator when `store.state.track?.uri === row.uri`.
- `src/app.d.ts` — Ambient types for `window.Spotify`.
- `users` table — add `product` column (`'premium' | 'free' | 'open'`) if not already present; populated from `/me` at login.

### Boundaries

- `playback/*` knows nothing about routes or the DOM (except `media-session.ts`, which is explicitly side-effecting on `navigator`).
- Components read the store via `getContext` / runes; no component imports SDK types directly.
- API endpoints are thin passthroughs; all token / refresh logic stays in the existing server helper.

## 3. Data flow

### 3.1 SDK initialization (lazy, gesture-gated)

`PlaybackStore.init()` is called by the first user gesture (play / shuffle / continue). It is idempotent and returns the in-flight promise on re-entry.

1. `activateElement()` on a one-shot `<audio>` element (iOS Safari autoplay rule; no-op elsewhere).
2. `sdk-loader` resolves `window.Spotify`.
3. `new Spotify.Player({ name: 'disccovery', getOAuthToken, volume: 1 })`.
4. Attach listeners: `ready`, `not_ready`, `player_state_changed`, `initialization_error`, `authentication_error`, `account_error`, `playback_error`.
5. `await player.connect()`.
6. On `ready` → `store.deviceId = device_id`; `store.isReady = true`.
7. `PUT /api/spotify/player/transfer { device_ids: [deviceId], play: false }`.

`getOAuthToken(cb)` callback fetches `/api/spotify/access-token`, caches the token in store memory until ~30s before expiry, and invokes `cb(access_token)`. Single-flight on concurrent calls.

### 3.2 Click-to-play (from /library)

```
Click LibraryRow
  → page passes currentFilterUris (in memory from /api/library response)
  → store.playTrack(clickedUri, currentFilterUris)
  → init() if needed
  → queue = buildQueueFromClick = [clickedUri, ...shuffleFisherYates(rest)]
  → PUT /api/spotify/player/play { uris: queue.slice(0, 100), device_id }
  → store.mode = 'shuffle'; store.queue = queue
  → player_state_changed drives UI
```

Spotify's play endpoint accepts max 100 URIs. When the queue's remaining count ≤ 5, the store appends via `POST /me/player/queue?uri=…` for each unplayed tail entry (re-query the original filter if necessary to refill).

### 3.3 Shuffle button

- **/library** — `store.shuffle(currentFilterUris)`: Fisher-Yates the filter, play index 0 first.
- **/now-playing** — fetch `/api/library` (no filter) → all rated track URIs → `store.shuffle(allRatedUris)`. Button shows loading state while fetching.

Both paths converge in `store.shuffle(uris)` → init → `PUT /api/spotify/player/play { uris }`.

### 3.4 Take-over ("Continue in disccovery")

Button visible only when (a) currently-playing poll reports Spotify-elsewhere with a `context.uri`, and (b) `!store.isActive`.

```
Tap "Continue in disccovery"
  → init() if needed
  → read currentlyPlaying.context.uri + item.uri + progress_ms
  → PUT /api/spotify/player/play { context_uri, offset: { uri }, position_ms, device_id }
  → store.mode = 'takeover'
  → polling stops (per master spec line 157)
```

### 3.5 `player_state_changed` → UI + mediaSession

Single subscriber in the store:

```
on player_state_changed(s):
  store.state = { paused, position_ms, duration_ms,
                  track: s.track_window.current_track,
                  context_uri: s.context?.uri }
  setMediaMetadata(store.state.track, lookupRating(store.state.track.uri))
```

`lookupRating` reads from the rating store (Plan 2). When the user adjusts the rating in /now-playing, the rating store updates → metadata re-runs → lock-screen title updates live.

`setMediaActionHandlers(store)` is wired once at init and routes OS-level commands (play, pause, prev, next, seek) to the store.

### 3.6 Source-of-truth flag

```
store.isActive = store.isReady && store.state?.track != null
```

Drives:

- /now-playing: show `<Transport />` vs the existing Spotify-elsewhere read-only view.
- Layout: show `<MiniPlayer />` on non-/now-playing routes.
- Currently-playing polling: paused while `isActive` (master spec line 157).

## 4. Error handling

### 4.1 SDK errors

| Event | Cause | Handling |
|---|---|---|
| `initialization_error` | Browser unsupported, iframe blocked | `store.error = 'unsupported'`. Disable play UI; "Playback unavailable in this browser." No retry. |
| `authentication_error` | Token rejected | Force-refresh `/api/spotify/access-token`. On second failure → `store.error = 'auth'` → redirect to `/auth/login`. |
| `account_error` | Not Premium (downgrade mid-session, or gate slip) | `store.error = 'premium'` → swap controls to `<PremiumGate />` disabled state. |
| `playback_error` | Track unplayable (region, removed) | Toast "Couldn't play this track." In a queue → advance to next. In takeover → revert to non-source view. |

Premium pre-gate uses `users.product` (populated from `/me` at login). `account_error` is the runtime safety net.

### 4.2 Token / `getOAuthToken` failures

The callback wraps `fetchAccessToken` in try/catch. On failure it invokes `cb('')` (empty token → SDK fires `authentication_error`) and sets `store.error = 'auth'`. Concurrent SDK requests share a single in-flight token promise.

### 4.3 Play / transfer endpoint errors

`/api/spotify/player/play` and `/transfer` translate Spotify status codes into a stable shape: `{ error: 'no_active_device' | 'premium_required' | 'rate_limited' | 'transient', retry_after?: number }`.

- `404 NO_ACTIVE_DEVICE` → re-issue transfer, retry play once. Still failing → toast "Lost connection to player" + re-init.
- `403 PREMIUM_REQUIRED` → same as `account_error`.
- `429` → respect `Retry-After`; one retry. Refill failures during shuffle queue maintenance are dropped silently.
- `502 / 503 / network` → one retry with 500ms backoff. Persistent failure → `store.error = 'transient'`, controls re-enable on next successful action.

### 4.4 Queue exhaustion

When `store.queue` ≤ 5 unplayed URIs and `mode === 'shuffle'`:

- If the original filter is remembered, re-query `/api/library?<filter>` → drop already-played → push via `POST /me/player/queue`.
- If re-query yields 0 new tracks, let playback drain. On final `player_state_changed` (paused, position 0, no next track), set `mode = 'idle'`; `isActive` stays true until the user navigates away or starts something new.

Click-to-play uses the same replenishment (its output is a shuffle queue with a fixed first track).

### 4.5 `navigator.mediaSession` absent

Feature-detect: `setMediaMetadata` and `setMediaActionHandlers` are no-ops when undefined. Each `setActionHandler` is wrapped in try/catch (some platforms throw `NotSupportedError` for unsupported actions). Playback continues without lock-screen integration.

### 4.6 Page hidden / SDK disconnect

On visibility-change to visible, call `player.getCurrentState()` once. If it returns null and `isActive` was true, set `store.error = 'disconnected'` — user re-taps play to re-init. No automatic reconnect; the OS lock-screen controls are the user's mechanism while the tab is hidden.

### 4.7 Free-account drift

`/me` is cached at login. If the user downgrades mid-session, the `account_error` path (4.1) catches it the moment they try to play. `/me` is not re-polled proactively.

## 5. Testing

### 5.1 Unit (vitest)

Pure functions:

- `stars.ts` — exact glyphs for `0`, `0.5`, `3`, `4.5`, `5`, `null`.
- `queue.ts` — `shuffleFisherYates` (permutation property, seeded determinism); `buildQueueFromClick` (clicked at index 0; rest is a permutation of the input minus clicked; empty / single / not-in-list edge cases).
- `media-session.ts` — with `navigator.mediaSession` stubbed: metadata title `★★★★ Track`; null rating omits prefix; handlers wired; no-op when feature-detect fails.

### 5.2 Server endpoints (vitest, existing harness)

- `GET /api/spotify/access-token` — returns `{ access_token, expires_in }`; unauthed → 401; expired refresh → 401 with stable shape.
- `PUT /api/spotify/player/play` — both payload shapes forward correctly; error mapping verified per Spotify status code via fetch mock.
- `PUT /api/spotify/player/transfer` — payload forwarded; error mapping verified.

### 5.3 Component (vitest + @testing-library/svelte)

- `<PremiumGate />` — disabled + inline note when `product !== 'premium'`; passthrough when premium.
- `<Transport />` — buttons call store methods; loading / paused / playing icons.
- `<MiniPlayer />` — renders only when `isActive && route !== '/now-playing'`; tap navigates.
- `<ContinueHereButton />` — visible only when Spotify-elsewhere has context AND `!isActive`; click calls `takeover()`.

### 5.4 Mocked-SDK Playwright (CI, every push)

New fixture `mockSpotifySdk` injects a fake `window.Spotify` before page load: constructor captures listeners; `connect()` resolves true and synthesizes a `ready` event with a fixed `device_id`; `__mockSpotify.emit(event, payload)` from test code drives state.

Specs:

- `playback-click.spec.ts` — Library row click → assert play body has `uris` starting with clicked URI; emit state → assert Transport visible; navigate → assert mini-player.
- `playback-shuffle.spec.ts` — /library shuffle uses current filter; /now-playing shuffle fetches full rated set.
- `playback-takeover.spec.ts` — Mocked currently-playing with context → "Continue" appears → click → assert play body has `context_uri + offset + position_ms`; mode → `takeover`.
- `playback-premium-gate.spec.ts` — `product: 'free'` → all play controls disabled, inline note, click is a no-op.
- `playback-errors.spec.ts` — 404 → transfer retry + play retry; 403 → PremiumGate swap; 429 with `Retry-After: 1` → retry after delay.
- `mediasession.spec.ts` — Spy on `mediaSession.metadata` setter → emit state with rating 4 → title `★★★★ Track Name`; change rating → metadata re-set.

### 5.5 Live-Spotify Playwright (`pnpm e2e:live`, local-only)

Separate Playwright project `live`, excluded from the default run. Real SDK loads, real Premium account, real audio (muted via `--mute-audio`).

**One-shot auth setup:** `pnpm e2e:auth` opens a headed browser, user logs in via real Spotify OAuth; on redirect-back, Playwright saves `storageState` → `.auth/spotify.json`. `.auth/` is gitignored. The setup script also writes `.auth/test-uris.json` from a `/api/library` query so live specs have known-good track URIs.

Specs (sequential — single Spotify session):

- `live-click.spec.ts` — Click first library row; wait ≤3s for `player_state_changed`; assert Transport shows correct track. ~10s.
- `live-shuffle.spec.ts` — /now-playing shuffle; wait for `ready`; click next; assert track changes. ~15s.
- `live-takeover.spec.ts` — Skipped unless `LIVE_TAKEOVER=1` env (requires manual Spotify-elsewhere setup).
- `live-mediasession.spec.ts` — Evaluate `navigator.mediaSession.metadata.title` after click-to-play; assert star prefix.

`pnpm e2e:live` runs all four sequentially. Expired refresh token surfaces "Run `pnpm e2e:auth` to re-authenticate."

### 5.6 Gates for Plan 5 tag

1. vitest + svelte-check + Playwright (mocked) green in CI.
2. `pnpm e2e:live` green locally.
3. User live smoke: real device, real lock screen (mediaSession lock-screen title can't be asserted from Playwright; only the in-page metadata object can).
4. Annotated tag `plan-5-playback`.
