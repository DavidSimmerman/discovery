# disccovery — design

A mobile-first PWA that lets a user rate (½-star precision) and label songs from
their Spotify listening, and play music through the app itself with a custom
"★★★★ Song Name" title surfaced on the lock screen.

The pun is on `disc` — the wordmark renders "discovery" with the **o** drawn as
a small CD glyph (inner edge sized to the lowercase x-height; bottom on the
baseline, top at x-height of the surrounding type). The `disc` half is Spotify
green (`#1DB954`); `very` stays white. The CD-o can slow-spin while a track is
playing.

## Why this exists

The user wants persistent, structured opinions about songs that survive across
listening sessions: a ½-star rating they actually trust, and labels they
arrange themselves. Spotify itself only supports binary "like / hide" and
opaque algorithmic playlists. disccovery is the personal index Spotify won't
build.

## What is in MVP

1. Spotify OAuth login (Authorization Code with PKCE).
2. Currently-playing detection — surface whatever the user is listening to.
3. ½-star rating UI (1–5 in 0.5 increments, clearable).
4. Custom text labels per track; most-recently-used label first.
5. In-app playback via the Spotify Web Playback SDK (Premium required).
6. Two playback modes:
    - **Take over a Spotify context**: transfer the currently-playing playlist /
      album / artist context to disccovery's SDK device, continue from where
      Spotify was.
    - **Own shuffle**: disccovery curates a queue from the user's rated tracks.
7. Lock-screen / OS media-control title shows `★★★★ Song Name` while
   disccovery is the audio source, via `navigator.mediaSession.metadata`.
8. Library / history screen: browse, search, filter by rating or label.
9. Installable as a PWA (manifest + service worker for offline shell only —
   not for caching Spotify audio).

## What is explicitly NOT in MVP

- Social features (sharing ratings, following users, feeds, profiles other
  than your own). Confirmed as "eventually" by the user.
- "Listen more" / "listen less" algorithmic preference signals. Future
  feature; behavior (track-level toggle vs queue-algorithm nudge) is
  deliberately unsettled.
- Monetization — Spotify's Developer Policy forbids commercial use of
  Streaming SDAs. Open-source distribution + a separate donations page is
  the only path. Building under that assumption.
- Comments, replies, social discovery, recommendations.
- Native iOS / Android wrappers. PWA is the deployment target. WKWebView
  wrappers add reliability problems (background-audio entitlement doesn't
  cleanly cover WKWebView) and Apple-review overhead with no functional gain.
- Audio-features / recommendations endpoints — Spotify deprecated these for
  new apps in late 2024. Anything that needed them is out.

## Hard constraints (verified against current docs)

- **Spotify Premium required** for the Web Playback SDK. Mobile-only Premium
  plans are excluded. Free users see a "Premium required to play in
  disccovery" state but can still rate / label tracks they play in their
  own Spotify app (currently-playing polling works for free users).
- **iOS Safari supports the SDK** as of current docs, with one caveat:
  autoplay restrictions require `activateElement()` to be called inside a
  user-gesture handler before any playback. Without it, first-play won't
  start.
- **Track metadata is immutable.** disccovery can't rename Spotify tracks.
  The custom title only appears (a) inside disccovery's own UI, and (b) on
  the OS lock screen _while disccovery is the audio source_. When
  disccovery is just remote-controlling Spotify, the lock screen shows
  Spotify's real title.
- **Spotify Developer mode caps at 25 users** until a Quota Extension
  Request is granted. Not a build blocker — flag for distribution time.
- **Streaming SDA classification** binds the whole app. The Player API
  (`play`, `pause`, `next`, `seek`, `transfer`) is "streaming" per Spotify's
  definition. No carve-out for monetization is possible while disccovery
  controls playback.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Browser (PWA, mobile-first)                              │
│                                                           │
│  Svelte 5 UI ── Web Playback SDK ── mediaSession API      │
│      │                  │                                 │
│      │                  └─→ audio out + lock-screen meta  │
│      │                                                    │
│      ▼                                                    │
│  fetch() to SvelteKit endpoints                           │
└──────────────┬────────────────────────────────────────────┘
               │ HTTPS (cookies, same-origin)
               ▼
┌───────────────────────────────────────────────────────────┐
│  SvelteKit server (Node)                                  │
│                                                           │
│  /api/spotify/exchange   ← OAuth code → tokens            │
│  /api/spotify/refresh    ← refresh access token           │
│  /api/spotify/me         ← passthrough w/ stored token    │
│  /api/ratings            ← CRUD on user's ratings         │
│  /api/labels             ← CRUD on user's labels          │
│  /api/library            ← filtered queries               │
└──────────────┬────────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────┐
│  Postgres (Drizzle ORM)                                   │
│  users, spotify_tokens, ratings, labels, track_labels     │
└───────────────────────────────────────────────────────────┘
```

Stack: **SvelteKit + TypeScript + Tailwind + shadcn-svelte + Postgres
(Drizzle) + Playwright** for tests. Matches the user's default greenfield
stack.

### Why this shape

- **SvelteKit server** holds the Spotify client secret and the long-lived
  refresh tokens. Never expose either to the browser. Client gets a
  short-lived access token via server-mediated refresh.
- **Web Playback SDK runs only in the browser.** SvelteKit doesn't touch
  audio.
- **PWA install** is the iOS/Android distribution path. Add to Home Screen
  from Safari / Chrome. Service worker caches the app shell; Spotify audio
  is never cached (DRM-protected and ToS-forbidden).
- **Postgres** chosen over SQLite because the user's stack default is
  Postgres and because the library queries (filter by rating + label
    - text search) are easier with full-text search and array operators.

## Authentication & token lifecycle

OAuth 2.0 Authorization Code with PKCE (Spotify's recommended flow for
public clients). SvelteKit server handles the secret-bearing half.

1. User taps "Log in with Spotify".
2. Client generates PKCE verifier + challenge, redirects to Spotify with
   scopes: `streaming user-read-email user-read-playback-state
user-modify-playback-state user-read-currently-playing
user-read-recently-played user-library-read`.
3. Spotify redirects back to `/auth/callback?code=…`.
4. Server posts to Spotify's `/api/token` with the code + PKCE verifier
    - client secret. Receives `access_token` + `refresh_token`.
5. Server stores the refresh token in `spotify_tokens` (encrypted at rest).
6. Server sets an HttpOnly session cookie. Client never sees the refresh
   token.
7. Client requests `/api/spotify/access-token` whenever it needs to
   initialize the SDK or call the Web API; server checks expiry, refreshes
   if needed, returns a short-lived access token (held in JS memory, never
   persisted client-side).

Scopes are the minimum needed for: SDK playback (`streaming`),
currently-playing detection, transport control, library reads.

## Currently-playing detection

Two paths depending on whether disccovery is the audio source:

- **disccovery is playing** → subscribe to the SDK's `player_state_changed`
  event. Instant, no polling.
- **Spotify elsewhere is playing** → poll `GET /me/player/currently-playing`
  every 5 seconds while the app is foregrounded. Stop polling when
  backgrounded (Page Visibility API). Resume on visibility change.

Rate-limit awareness: Spotify's player endpoints have generous limits but
not unlimited. 5-second polling at 12 polls/minute is well under any
practical cap for a single user.

## Playback

### Initializing the SDK device

On first play interaction (user tap — required to satisfy iOS Safari
autoplay rules), the client:

1. Calls `activateElement()` to satisfy the iOS gesture requirement.
2. Loads the Spotify Web Playback SDK script.
3. Instantiates `new Spotify.Player({ name: 'disccovery', getOAuthToken: cb
=> cb(latestToken) })`.
4. On `ready` event, gets the device_id.
5. Calls `PUT /me/player` with `{ device_ids: [device_id], play: false }`
   to register disccovery as the active device.

### Take over a Spotify context

If the user is already playing a Spotify playlist / album / artist:

1. Read `/me/player` to get the current `context.uri` and `progress_ms`.
2. Call `PUT /me/player/play` with `{ context_uri, offset: { uri:
current_track_uri }, position_ms: progress_ms }`, targeting disccovery's
   device.
3. Continue normally; the SDK now owns playback.

### Own shuffle

User selects "Shuffle from disccovery" (with optional rating-floor or
label filter). The client:

1. Queries `/api/library?min_rating=4&label=workout` (or whatever the
   filter is) → returns N track URIs.
2. Shuffles client-side (Fisher-Yates).
3. Calls `PUT /me/player/play` with `{ uris: [...] }`, targeting
   disccovery's device.
4. As tracks change, the SDK fires `player_state_changed`; client appends
   more tracks if the queue is running low (re-query with the same filter,
   pop already-played).

## Lock-screen / OS media-control title

While disccovery is the audio source, the page sets:

```ts
navigator.mediaSession.metadata = new MediaMetadata({
	title: `${stars(rating)} ${track.name}`,
	artist: track.artists.map(a => a.name).join(', '),
	album: track.album.name,
	artwork: track.album.images.map(i => ({ src: i.url, sizes: `${i.width}x${i.height}` }))
});
```

`stars(rating)` renders the rating as Unicode (e.g. `★★★★½`). When rating
is null/0, no prefix. When disccovery is _not_ the audio source (Spotify
is, via remote-control), this code path is dormant and Spotify's normal
title shows on the lock screen — by design, since we can't override it.

## Rating UI

- 5 stars, ½-star granularity → 10 possible positive values + 0
  (unrated / cleared).
- Tap interaction: each star is split into a left tap-zone (½) and a
  right tap-zone (full). Tapping a star at the current rating clears it.
- Visual: filled star = `#1DB954`; empty star = stroke `#444`; half star =
  empty outline + filled path clipped to left 50%. Same SVG component
  scales from 14px (library list rows) to 42px (now-playing).
- Optimistic update: PATCH the rating immediately on tap; revert + toast
  on server error.

## Labels

- Free-text per user. Stored as `labels(id, user_id, name, last_used_at)`.
- Many-to-many with tracks: `track_labels(spotify_track_uri, label_id,
applied_at)`.
- Most-recently-used surfacing: query labels for the user ordered by
  `last_used_at DESC`, top N shown as chips on the now-playing screen.
  An "+ add" chip opens a free-text input that fuzzy-matches existing
  labels and offers "create new" if no match.
- Applying a label updates `track_labels` and bumps the label's
  `last_used_at`.
- Labels surface in the library as filter chips and in the rating-row
  subtitle.

## Library / history screen

- **Tabs**: All / Rating / Labels / Flagged (Flagged is a future hook for
  the more/less feature; in MVP it's empty or hidden).
- **Search**: fuzzy over title, artist, label name. Postgres `pg_trgm`
  works fine at the expected scale (single-user library, low thousands).
- **Filter chips**: Recent, star buckets, top labels, "+ filter" composer.
- **Row format**: art thumb + title + artist · top-2 labels + (future)
  more/less badge + star rating right-aligned.
- **Tap row** → that track's detail / "play this" sheet.

## Data model

```sql
users (
  id            uuid primary key,
  spotify_id    text unique not null,
  display_name  text,
  created_at    timestamptz default now()
)

spotify_tokens (
  user_id           uuid primary key references users(id),
  refresh_token_enc bytea not null,    -- AES-256-GCM, key from env (TOKEN_ENC_KEY)
  access_token      text,              -- cached, short-lived
  expires_at        timestamptz,
  updated_at        timestamptz default now()
)

ratings (
  user_id              uuid not null references users(id),
  spotify_track_uri    text not null,            -- e.g. "spotify:track:4iV5..."
  isrc                 text,                     -- for future portability
  rating_half_steps    smallint not null check (rating_half_steps between 1 and 10),
  rated_at             timestamptz default now(),
  primary key (user_id, spotify_track_uri)
)

-- Track metadata cache (populated lazily as tracks are encountered)
tracks (
  spotify_track_uri  text primary key,
  isrc               text,
  title              text not null,
  artists            text[] not null,
  album              text,
  album_art_url      text,
  duration_ms        integer,
  fetched_at         timestamptz default now()
)

labels (
  id            uuid primary key,
  user_id       uuid not null references users(id),
  name          text not null,
  last_used_at  timestamptz default now(),
  created_at    timestamptz default now(),
  unique (user_id, name)
)

track_labels (
  user_id            uuid not null references users(id),
  spotify_track_uri  text not null,
  label_id           uuid not null references labels(id),
  applied_at         timestamptz default now(),
  primary key (user_id, spotify_track_uri, label_id)
)
```

Ratings stored as `smallint` half-steps (1–10) rather than `numeric`
2.5 / 3.0 to dodge any float comparison weirdness. `1` = ½ star, `10` =
5 stars, `null` row absent = unrated.

ISRC stored on ratings + tracks for future portability — if disccovery
ever ports to Apple Music or other services, ISRC is the canonical
cross-service identifier.

## Branding

- Wordmark: green `disc` + white `overy`, with the `o` drawn as a
  CD glyph (black center, green ring, inner edge sized to x-height of
  surrounding type, bottom on the baseline).
- Primary color: Spotify green `#1DB954`.
- Surfaces: black base (`#000`, `#0a0a0a` for elevated, `#1a1a1a` for
  controls).
- The structural mockups in this doc are deliberately flat. Real visual
  polish (gradients, motion, micro-interactions, depth) will be applied
  during implementation via the `frontend-design`, `polish`, and
  `delight` skills — not over-determined here.
- The CD-`o` slow-spins while a track is playing (subtle, ~1 rotation
  per ~6 seconds).

## Testing

- **Playwright** for the rating + label flows: log in (test account),
  rate a song, verify it persists, verify it surfaces in the library,
  remove the rating, verify it's gone.
- **Playwright** for the now-playing screen: half-star tap zones, label
  chip add / pick / dedupe, MRU ordering on relog.
- **Integration test for token refresh**: stub a 401 from Spotify, verify
  the server refreshes and retries cleanly.
- **No live SDK testing in CI** — Web Playback SDK requires real Premium
  and a real browser audio context. Manual smoke test on a real device
  before each release.

## Hosting

- App: deploy to **Fly.io** or **Vercel** (SvelteKit Node adapter on Fly
  preferred — long-lived process is friendlier to the token-refresh
  pattern and avoids cold-start latency on `/api/spotify/access-token`).
- DB: **Neon** or **Supabase** Postgres free tier (single-user scale).
- Spotify app: register at `developer.spotify.com`. Redirect URI must
  match deployment URL exactly. Start in Development Mode (25-user
  cap) — request quota extension only if/when distribution becomes
  relevant.
- Secrets: client secret + DB credentials + token-encryption key live in
  the host's env-var store, never in the repo.

## Open items deferred to implementation

- Exact PWA manifest icons + maskable variants.
- Service worker cache strategy for the app shell.
- Color tuning beyond the structural palette.
- Animation timing for the CD-`o` spin, star-tap feedback, chip-toggle
  feedback.
- Error / empty states (no Premium, no current track, Spotify down).

## Future features (post-MVP)

- **"Listen more" / "listen less" signals** in the now-playing transport
  bar. Semantics deliberately unsettled — could be track-level toggle,
  algorithmic queue nudge, or both. Decide at the time, based on how the
  rating + label data feels in practice.
- **Social layer**: profiles, follow, activity feed, "your friends'
  highest-rated this week", per-rating comments. Stays a Streaming SDA
  (still unmonetizable); design accordingly.
- **Cross-service portability** via ISRC: read ratings against Apple
  Music or other catalogs.
- **Per-rating notes** (free-text annotation on a rating, surfaced in
  library detail view).
- **Stats / wrapped-style summaries**: top artists by ½-star, label
  clouds, listening-over-time charts.

## Decisions made in brainstorming

| Decision           | Choice                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Stack              | SvelteKit + TS + Tailwind + shadcn-svelte + Postgres/Drizzle + Playwright (user's default)                  |
| Distribution       | PWA only. No App Store wrapper.                                                                             |
| Audio source       | Web Playback SDK in-browser (own audio, custom lock-screen title)                                           |
| Auth               | Spotify OAuth PKCE, server-mediated refresh, HttpOnly cookies                                               |
| Rating granularity | Half-steps, stored as smallint 1–10                                                                         |
| Labels             | Per-user free-text, MRU-sorted                                                                              |
| Monetization       | None. Accept Streaming-SDA constraint. Open-source + separate donations page if at all.                     |
| Social             | Out of MVP. Eventually.                                                                                     |
| more/less          | Out of MVP. Future feature; semantics TBD.                                                                  |
| Lock-screen title  | Set via `mediaSession.metadata` while SDK is audio source. Cannot override when remote-controlling Spotify. |
