# disccovery — Plan 4: Library + History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/library` screen lists every track the user has rated or labeled, newest first, each row showing album art + title + artist + its top labels + its star rating. The user can search (title / artist / label) and filter by rating bucket or label. End state: `/library` route with a search box, filter chips, and rows; backed by a filtered query endpoint; Playwright coverage over search + filter.

**Architecture:**
- The "library" is the set of tracks the user has interacted with: `DISTINCT spotify_track_uri` from `ratings` ∪ `track_labels`, joined to the `tracks` metadata cache, with the rating (nullable) and the track's labels aggregated.
- One endpoint, `GET /api/library`, takes optional `search`, `minRating`, and `label` query params and returns the filtered rows. A second lightweight call (or the same endpoint's payload) provides the facet data for filter chips (the user's top labels + total count).
- **Search is case-insensitive `ILIKE` substring** over title, artist, and label name — no `pg_trgm` extension (deliberate simplicity; single-user scale). Upgradeable to trigram ranking later.
- Rows are **read-only** in this plan (display rating + labels). Editing already exists on now-playing; inline edit-from-library is out of scope here.
- Reuses the existing `StarRating` component (non-interactive, small size) for the row rating, and renders labels as small static chips.

**Tech Stack:** Same as Plans 1–3. No new dependencies. No schema migration expected (all tables exist).

**Pre-flight:** Plan 3 complete and tagged (`plan-3-labels`). The `tracks` cache is populated for any track the user has seen on now-playing; rows for tracks with a rating/label but no cached metadata must degrade gracefully (see Task 2).

---

## File structure (additions / changes)

```
discovery/
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   └── library.ts              # NEW — listLibrary(userId, filters) + libraryFacets(userId)
│   │   └── components/
│   │       ├── LibraryRow.svelte       # NEW — art + title/artist + labels + rating
│   │       └── LibraryFilters.svelte   # NEW — search box + rating-bucket + label chips (optional split; see T4)
│   └── routes/
│       ├── library/
│       │   ├── +page.svelte            # NEW — search + filters + rows
│       │   └── +page.server.ts         # NEW — auth guard
│       └── api/
│           └── library/+server.ts      # NEW — GET filtered rows + facets
├── tests/
│   ├── unit/
│   │   └── library.test.ts             # NEW — endpoint param validation + helper-call wiring
│   └── e2e/
│       └── library.spec.ts             # NEW
```

Also a small nav touch: a link to `/library` from `/now-playing` and a link back (Task 4, Step 6).

---

## Task 1: Library query helper

**Files:**
- Create: `src/lib/server/library.ts`

Define a row type and two functions.

- [ ] **Step 1:** `LibraryRow` type: `{ uri: string; title: string | null; artists: string[]; albumArtUrl: string | null; rating: number | null; labels: string[] }`. (title/art nullable because a track may be rated/labeled before its metadata was cached — degrade gracefully; the UI shows a fallback.)
- [ ] **Step 2:** `listLibrary(userId, opts: { search?: string; minRating?: number; label?: string }): Promise<LibraryRow[]>`:
  - Base set: the distinct `spotify_track_uri`s for this user that appear in `ratings` OR `track_labels`. Build this with a `UNION` subquery (or a CTE) on `spotify_track_uri` filtered by `user_id`.
  - LEFT JOIN `tracks` for metadata, LEFT JOIN `ratings` (same user) for `ratingHalfSteps`, and aggregate the user's labels for each uri (e.g. `array_agg` over `track_labels` → `labels` joined by name; use a correlated subquery or a grouped join — whichever is cleanest with Drizzle; raw `sql` is acceptable here and likely clearest for the aggregation).
  - **Filters:**
    - `minRating` (1–10 half-steps): keep only rows where `ratingHalfSteps >= minRating`. (Tracks with no rating are excluded when `minRating` is set.)
    - `label` (a label NAME): keep only rows that have that label applied (exists in `track_labels` joined to `labels.name = label` for this user).
    - `search`: keep rows where title `ILIKE %search%` OR any artist `ILIKE %search%` OR any applied label name `ILIKE %search%`. (For the artist array, use `EXISTS (SELECT 1 FROM unnest(artists) a WHERE a ILIKE ...)` or `array_to_string(artists,' ') ILIKE ...` — pick one and comment it.)
  - **Order:** most-recent first. Use `GREATEST(ratings.rated_at, latest track_labels.applied_at)` as the recency key, or simpler: order by `ratings.rated_at DESC NULLS LAST` then by the max `applied_at`. Keep it sensible; document the choice. Cap the result (e.g. `LIMIT 500`) — single-user scale, but don't return unbounded.
  - Parameterize ALL user input (Drizzle/`sql` placeholders) — never string-concat `search` into SQL.
- [ ] **Step 3:** `libraryFacets(userId): Promise<{ total: number; topLabels: { name: string; count: number }[] }>`:
  - `total`: count of distinct library tracks (the same base set).
  - `topLabels`: the user's labels by usage on tracks, e.g. `SELECT name, COUNT(*) FROM track_labels JOIN labels ... GROUP BY name ORDER BY count DESC LIMIT 8`. These drive the filter chips.
- [ ] **Step 4:** Verify the SQL runs against the live dev DB with a quick manual probe (psql or a throwaway script) using the existing seeded/your own data — confirm shape. `pnpm exec svelte-check` 0 errors.
- [ ] **Step 5:** Commit: `db: library query helpers (list + facets)`.

---

## Task 2: `GET /api/library` endpoint

**Files:**
- Create: `src/routes/api/library/+server.ts`

- [ ] **Step 1:** GET handler. Require `locals.user` → `error(401)`.
- [ ] **Step 2:** Parse + validate query params from `url.searchParams`:
  - `search`: optional string; trim; ignore if empty; cap length (e.g. ≤ 100) → 400 if longer.
  - `minRating`: optional; must parse to an integer 1–10 → 400 otherwise. (Map UI "★★★★ and up" buckets to half-steps client-side; the API speaks half-steps.)
  - `label`: optional string; trim; cap length (≤ 50) → 400 if longer.
- [ ] **Step 3:** Call `listLibrary(user.id, { search, minRating, label })` and `libraryFacets(user.id)`. Return `json({ rows, facets }, { headers: { 'cache-control': 'no-store' } })`.
- [ ] **Step 4:** Match the auth + validation + `error()`/`json()` style of `src/routes/api/ratings/+server.ts` and `src/routes/api/labels/+server.ts`.
- [ ] **Step 5:** Commit: `api: GET /api/library with search + filters`.

---

## Task 3: Endpoint unit tests

**Files:**
- Create: `tests/unit/library.test.ts`

- [ ] **Step 1:** Mock `$lib/server/library` (copy the mock structure from `tests/unit/labels.test.ts`). Import the `GET` handler.
- [ ] **Step 2:** Cover:
  - no `locals.user` → 401
  - no params → 200, calls `listLibrary(userId, {})` (empty opts) + `libraryFacets(userId)`; body `{ rows, facets }`
  - `?search=foo` → `listLibrary` called with `{ search: 'foo' }`
  - `?search=` (empty) → treated as absent (not passed / undefined)
  - over-long `search` (101 chars) → 400; assert `listLibrary` NOT called
  - `?minRating=8` → called with `{ minRating: 8 }`
  - `?minRating=0`, `?minRating=11`, `?minRating=abc` → 400 each
  - `?label=workout` → called with `{ label: 'workout' }`; over-long label → 400
- [ ] **Step 3:** `pnpm exec vitest run` green; `pnpm exec svelte-check` 0 errors.
- [ ] **Step 4:** Commit: `test: library endpoint validation`.

---

## Task 4: Library UI + nav

**Files:**
- Create: `src/routes/library/+page.svelte`, `src/routes/library/+page.server.ts`, `src/lib/components/LibraryRow.svelte`
- Edit: `src/routes/now-playing/+page.svelte` (nav link)

- [ ] **Step 1:** `+page.server.ts`: if `!locals.user` → `redirect(303, '/')`; else return `{}` (client does its own fetch). Mirror `now-playing/+page.server.ts`.
- [ ] **Step 2:** `LibraryRow.svelte` props (`$props()`): `row: LibraryRow` (the shape from `library.ts`). Render a horizontal row: small album art thumb (~44px, rounded; fallback box when `albumArtUrl` null), a middle column with title (bold, truncate with ellipsis, single line) + a subline of `artists.join(', ')` and the top ~2 labels (muted, truncate), and a right-aligned `<StarRating value={row.rating ?? 0} size={14} />` (NON-interactive). Use `min-w-0` + `truncate` so long titles don't push the rating off-screen (the earlier mockup explicitly wanted no awkward wrapping). If `title` is null, show the uri's id or "Unknown track" as fallback.
- [ ] **Step 3:** `+page.svelte`:
  - On mount, fetch `GET /api/library`. Hold `rows` + `facets` in `$state`. Loading + empty states ("No rated or labeled tracks yet — go rate something on now-playing").
  - **Search box:** a text input bound to a `search` `$state`. Debounce (~250ms) re-fetching `GET /api/library?search=…` as the user types (don't fire a request per keystroke). Combine with the active filters.
  - **Filter chips:** a horizontal, wrapping (or horizontally-scrollable, no awkward wrap) row of chips: rating buckets (e.g. "★★★★★", "★★★★+") → set `minRating` (10, 8); the `facets.topLabels` as label chips → set `label`. Chips are toggle: tapping the active one clears it. Only one rating bucket and one label active at a time is fine for MVP. Re-fetch on change.
  - Render the list of `<LibraryRow>` for each row. Update silently on filter/search changes (don't flash the skeleton once data exists).
- [ ] **Step 4:** Keep all fetching client-side and resilient (revert/empty on error; a small inline error message, no toast lib). Reuse the patterns from `now-playing/+page.svelte`.
- [ ] **Step 5:** A11y: search input has an accessible name; filter chips are real `<button>`s with `aria-pressed` reflecting active state; the list is navigable.
- [ ] **Step 6:** Nav: add a link to `/library` from `/now-playing` (e.g. a small "Library" link in a header), and a link back to "Now playing" from `/library`. Keep it minimal — a full bottom-nav bar is a Plan 6 design-pass concern. Also add a `/library` link to the logged-in landing page (`src/routes/+page.svelte`) next to the now-playing CTA.
- [ ] **Step 7:** `pnpm exec svelte-check` 0 errors. Smoke on `127.0.0.1` if possible (the authed/data path needs the maintainer; report what you could verify).
- [ ] **Step 8:** Commit: `ui: library screen (search, filters, rows) + nav`.

---

## Task 5: Playwright e2e for the library

**Files:**
- Create: `tests/e2e/library.spec.ts`
- Edit: `tests/e2e/fixtures/seed.ts` — add helpers to seed several tracks + ratings + labels for the test user.

- [ ] **Step 1:** Reuse the harness (per-worker seeded user, injected session cookie). Add a seed helper that inserts N tracks into `tracks` (metadata), ratings rows, and label + track_label rows for the worker's user — enough to exercise search + both filters (e.g. 3–4 tracks with distinct titles/artists, varied ratings, a couple of shared labels). Insert directly via the existing `postgres` connection in `seed.ts` (these tables aren't otherwise reachable without the now-playing flow). Ensure teardown removes them — `tracks` is NOT user-scoped/cascaded, so explicitly delete the seeded `tracks` rows (or use track URIs namespaced per worker and delete them in teardown). Ratings/labels/track_labels cascade from the user; `tracks` does not — handle it.
- [ ] **Step 2:** Tests (against the real `/api/library`, no Spotify mock needed — the library doesn't call Spotify):
  - **List:** navigate to `/library` → all seeded tracks render as rows with their titles + ratings.
  - **Search by title:** type a substring matching one track → only matching rows remain. Clear → all return.
  - **Search by label:** type a label name → tracks carrying that label show.
  - **Filter by rating bucket:** activate "★★★★+" (minRating 8) → only tracks rated ≥ 8 remain; tracks with no/low rating drop.
  - **Filter by label chip:** tap a top-label chip → only tracks with that label remain; tapping again clears.
- [ ] **Step 3:** `pnpm exec playwright test` — all green (existing 11 + new). Run twice for stability. No leaked `tracks` rows after (verify the explicit tracks teardown works).
- [ ] **Step 4:** Commit: `e2e: library search + filters`.

---

## Task 6: Final integration pass + tag

- [ ] **Step 1:** `pnpm exec vitest run` green.
- [ ] **Step 2:** `pnpm exec svelte-check` 0 errors/0 warnings.
- [ ] **Step 3:** `pnpm exec playwright test` green.
- [ ] **Step 4:** Final cross-layer review: search/filter params flow UI ↔ endpoint ↔ SQL with no injection and correct user-scoping (no other user's tracks/ratings/labels leak); the rated∪labeled base set is correct; rows degrade gracefully when metadata is missing.
- [ ] **Step 5:** Maintainer live smoke: log in, open `/library`, confirm your rated/labeled tracks list, search, and filter. Then tag `plan-4-library`.

---

## Out of scope (later plans)

- **Tab bar** (All / Rating / Labels / Flagged) and "Flagged" — visual refinement deferred to the Plan 6 design pass; MVP uses search + filter chips.
- **Inline edit from a library row** (re-rate / add-remove labels without leaving the library) — editing lives on now-playing for now.
- **`pg_trgm` fuzzy ranking** — using `ILIKE` substring for MVP.
- **"Play this" / row → playback** — needs the Web Playback SDK (Plan 5).
- **Full bottom-navigation bar** — Plan 6.
- "Listen more / less" / Flagged signals — punted earlier by the user.
