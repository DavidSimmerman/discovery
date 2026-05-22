# disccovery — Plan 3: Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the now-playing screen, a user can attach free-text labels to the current track and remove them. Recently-used labels surface first as tappable chips; an "+ add" affordance lets them fuzzy-match an existing label or create a new one. Labels persist per-user and the most-recently-used ordering survives across sessions. End state: now-playing shows applied labels + MRU suggestions + an add-label input, all wired to endpoints, with Playwright coverage.

**Architecture:**
- Two tables: `labels` (per-user named label, `last_used_at` for MRU) and `track_labels` (many-to-many join of a user's track ↔ label).
- `GET /api/labels` returns the user's labels MRU-sorted; with `?trackUri=` it also flags which are applied to that track.
- `POST /api/track-labels` find-or-creates a label by `(user, name)`, applies it to a track, and bumps `last_used_at`. `DELETE /api/track-labels` removes the association (the label itself survives for reuse).
- Fuzzy matching is **client-side**: the UI filters the MRU list as the user types and offers "Create '<text>'" when there's no exact match. The server's apply endpoint is idempotent on `(user, name)`, so create-or-reuse is automatic.
- Scope is the now-playing screen only. Library filter-by-label and the rating-row label subtitle are Plan 4.

**Tech Stack:** Same as Plans 1–2.

**Pre-flight:** Plan 2 complete and tagged (`plan-2-rating`). Dev DB has the test user + a playing track via the existing mock path for e2e.

---

## File structure (additions / changes)

```
discovery/
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   └── schema.ts            # +labels, +track_labels
│   │   │   └── labels.ts               # NEW — query helpers (MRU list, applied set, apply, unapply)
│   │   └── components/
│   │       └── LabelChips.svelte       # NEW — applied chips + MRU suggestions + add-input
│   └── routes/
│       ├── now-playing/
│       │   └── +page.svelte            # wire LabelChips under the rating
│       └── api/
│           ├── labels/+server.ts       # NEW — GET (MRU, optional applied flags)
│           └── track-labels/+server.ts # NEW — POST apply, DELETE unapply
├── drizzle/                            # +migration for labels + track_labels
└── tests/
    ├── unit/
    │   └── labels.test.ts              # NEW — endpoint validation + apply/unapply logic
    └── e2e/
        └── labels.spec.ts              # NEW
```

---

## Task 1: Drizzle schema — labels + track_labels

**Files:**
- Edit: `src/lib/server/db/schema.ts`
- Generate: a new migration under `drizzle/`

- [ ] **Step 1:** Add `labels` table:
  - `id` uuid PK, default `gen_random_uuid()` (match how `users.id` is defined in this file — read it first).
  - `userId` uuid NOT NULL, FK `users.id` ON DELETE CASCADE (`user_id`)
  - `name` text NOT NULL
  - `lastUsedAt` timestamptz default now (`last_used_at`)
  - `createdAt` timestamptz default now (`created_at`)
  - UNIQUE `(userId, name)` — use a table-level `unique()` in the extra-config callback. This makes "find or create by name" race-safe via `onConflictDoUpdate`/`onConflictDoNothing`.
- [ ] **Step 2:** Add `track_labels` table:
  - `userId` uuid NOT NULL, FK `users.id` ON DELETE CASCADE (`user_id`)
  - `spotifyTrackUri` text NOT NULL (`spotify_track_uri`)
  - `labelId` uuid NOT NULL, FK `labels.id` ON DELETE CASCADE (`label_id`)
  - `appliedAt` timestamptz default now (`applied_at`)
  - composite PK `(userId, spotifyTrackUri, labelId)`
  - Note: `labelId` FK CASCADE means deleting a label cleans up its associations automatically (not exercised in MVP — labels are never deleted yet — but correct).
- [ ] **Step 3:** Generate: `pnpm drizzle-kit generate`. Open the SQL; confirm both tables, the unique constraint on labels, the composite PK + both FKs (cascade) on track_labels.
- [ ] **Step 4:** Apply: `pnpm drizzle-kit migrate`. Verify via psql (`\d labels`, `\d track_labels`) — unique constraint + cascades present.
- [ ] **Step 5:** Export the inferred types if the file's pattern does so for other tables (match existing convention — Plan 1 added `User`/`NewUser` types; only add label types if you'll use them).
- [ ] **Step 6:** Commit: `db: labels + track_labels tables`.

---

## Task 2: Label query helpers

**Files:**
- Create: `src/lib/server/labels.ts`

- [ ] **Step 1:** `listLabels(userId): Promise<{ id, name, lastUsedAt }[]>` — select user's labels ordered by `lastUsedAt DESC, name ASC`.
- [ ] **Step 2:** `appliedLabelIds(userId, trackUri): Promise<string[]>` — select `labelId`s from `track_labels` for that user+track.
- [ ] **Step 3:** `applyLabel(userId, trackUri, name): Promise<{ id, name }>` — trim the name; find-or-create the label via `db.insert(labels).values({...}).onConflictDoUpdate({ target: [labels.userId, labels.name], set: { lastUsedAt: new Date() } }).returning()` (the conflict update both bumps MRU AND lets us read back the existing row's id). Then insert into `track_labels` with `onConflictDoNothing` (re-applying an already-applied label is a no-op). Return `{ id, name }`. Reject empty/whitespace-only names at the endpoint layer, not here — but document the assumption.
- [ ] **Step 4:** `unapplyLabel(userId, trackUri, labelId): Promise<void>` — delete the `track_labels` row matching all three. Leave the `labels` row intact.
- [ ] **Step 5:** No dedicated unit test file for the helpers themselves (thin DB calls); they're covered through the endpoint tests in Task 4 and the e2e in Task 6. If any helper grows non-trivial logic, add a focused test.
- [ ] **Step 6:** Commit: `db: label query helpers`.

---

## Task 3: Endpoints — GET /api/labels, POST/DELETE /api/track-labels

**Files:**
- Create: `src/routes/api/labels/+server.ts`, `src/routes/api/track-labels/+server.ts`

- [ ] **Step 1:** `GET /api/labels`. Require `locals.user` (401). Read optional `trackUri` from `url.searchParams`. Call `listLabels(user.id)`. If `trackUri` is present, validate it against `/^spotify:track:[A-Za-z0-9]{22}$/` (400 if malformed), call `appliedLabelIds(user.id, trackUri)`, and return each label with an `applied: boolean`. Without `trackUri`, return the plain MRU list (no `applied` field). Shape: `{ labels: [{ id, name, applied? }] }`. `Cache-Control: no-store`.
- [ ] **Step 2:** `POST /api/track-labels`. Require `locals.user` (401). Body `{ spotifyTrackUri, name }`. Validate URI (400). Validate `name`: trim, reject empty after trim, cap length (e.g. ≤ 50 chars) → 400. Call `applyLabel(user.id, uri, trimmedName)`. Return `json({ ok: true, label: { id, name } })`.
- [ ] **Step 3:** `DELETE /api/track-labels`. Require `locals.user` (401). Body `{ spotifyTrackUri, labelId }`. Validate URI (400); validate `labelId` is a uuid (400). Call `unapplyLabel(user.id, uri, labelId)`. Return `json({ ok: true })`.
- [ ] **Step 4:** Match the auth + validation + `error()`/`json()` style of `src/routes/api/ratings/+server.ts` exactly.
- [ ] **Step 5:** Commit: `api: labels + track-labels endpoints`.

---

## Task 4: Endpoint validation unit tests

**Files:**
- Create: `tests/unit/labels.test.ts`

- [ ] **Step 1:** Mock `$lib/server/db` (copy the mock structure from `tests/unit/ratings.test.ts`). Mock `$lib/server/labels` where it simplifies asserting the endpoint logic, OR mock the db and let the real helpers run — pick whichever gives clean, real assertions (prefer mocking the `labels.ts` helpers so these tests focus on endpoint validation, and let Task 6 e2e cover the real DB path).
- [ ] **Step 2:** Cover:
  - GET without user → 401
  - GET with malformed `trackUri` → 400
  - GET without `trackUri` → returns MRU list (helper called, no `applied` flags)
  - GET with valid `trackUri` → labels annotated with `applied`
  - POST without user → 401; POST with malformed URI → 400; POST with empty/whitespace name → 400; POST with over-long name → 400; POST valid → calls `applyLabel`, returns label
  - DELETE without user → 401; DELETE with bad URI → 400; DELETE with non-uuid labelId → 400; DELETE valid → calls `unapplyLabel`
- [ ] **Step 3:** `pnpm exec vitest run` green; `pnpm exec svelte-check` 0 errors.
- [ ] **Step 4:** Commit: `test: labels endpoint validation`.

---

## Task 5: LabelChips component + now-playing wiring

**Files:**
- Create: `src/lib/components/LabelChips.svelte`
- Edit: `src/routes/now-playing/+page.svelte`

- [ ] **Step 1:** `LabelChips.svelte` props (`$props()`): `trackUri: string`. The component owns its own label state (fetches `/api/labels?trackUri=...` on mount and when `trackUri` changes via `$effect`). State: `labels` (the annotated list), plus input/UI state.
- [ ] **Step 2:** Render:
  - **Applied chips first** (highlighted, Spotify-green-ish), each with a small ✕ / tap-to-remove. Tapping removes via `DELETE /api/track-labels` (optimistic; revert on error).
  - **MRU suggestions** (the not-yet-applied labels, muted), tap to apply via `POST /api/track-labels` (optimistic).
  - **"+ add" affordance**: a chip that reveals a text input. As the user types, fuzzy-filter the existing labels (simple case-insensitive substring/contains is fine — don't pull in a fuzzy lib) and show matches. Enter (or tapping a match) applies; if the typed text matches no existing label exactly, show a "Create '<text>'" option that applies the new name. After applying, clear + collapse the input.
- [ ] **Step 3:** Optimistic updates everywhere with revert-on-error, mirroring the rating flow in `+page.svelte`. Surface errors via a small inline `aria-live` message (don't add a toast lib). After any successful apply, the just-used label should move to the front of the MRU list locally (re-sort or refetch — refetch is simplest and the lists are tiny).
- [ ] **Step 4:** A11y: the add-input is a real `<input>` with a label; chips are `<button>`s with clear `aria-label`s ("Remove label night drive" / "Add label synth"). Keyboard: Enter in the input applies the top match or the create option; Escape collapses.
- [ ] **Step 5:** Wire into `now-playing/+page.svelte`: render `<LabelChips trackUri={playing.uri} />` below the `<NowPlaying>` rating, only when `playing` is non-null. When the track changes (`playing.uri` changes), LabelChips re-fetches via its `$effect` — confirm it keys correctly so chips don't stick to the previous track.
- [ ] **Step 6:** `pnpm exec svelte-check` 0 errors. Smoke in the browser on 127.0.0.1 if possible (apply/remove/create/MRU-reorder); the live authed path needs the maintainer, so report what you could verify.
- [ ] **Step 7:** Commit: `ui: track labels on now-playing (apply, remove, create, MRU)`.

---

## Task 6: Playwright e2e for labels

**Files:**
- Create: `tests/e2e/labels.spec.ts`

- [ ] **Step 1:** Reuse the Plan 2 e2e harness: per-worker seeded user (`tests/e2e/fixtures/seed.ts`), injected session cookie, and the `mockCurrentlyPlaying` stub (`tests/e2e/mocks/spotify.ts`) so a track is "playing". The real `/api/labels` + `/api/track-labels` endpoints hit the test DB.
- [ ] **Step 2:** Add a `getLabelsForTrack(userId, trackUri)` (or similar) helper to `seed.ts` for DB assertions, and ensure teardown removes the worker's labels + track_labels (cascade from deleting the user already covers this — confirm).
- [ ] **Step 3:** Tests:
  - **Create + apply:** type a new label name in the add-input, submit → expect POST to `/api/track-labels` → the chip appears as applied → DB has the `labels` row and the `track_labels` association for the seeded user+uri.
  - **Remove:** tap the applied chip's remove → expect DELETE → chip leaves applied state → DB `track_labels` row gone (label row still exists).
  - **Reuse + MRU:** create label A, then label B; apply A again → assert A's `last_used_at` is now newer than B (or that A surfaces before B in a fresh `GET /api/labels`).
  - **Fuzzy match:** with label "night drive" existing, type "night" → assert the existing label is offered as a match (not only "Create 'night'").
- [ ] **Step 4:** `pnpm exec playwright test` — all green (existing 7 + new). No leaked rows after run.
- [ ] **Step 5:** Commit: `e2e: track labels flow against mocked Spotify`.

---

## Task 7: Final integration pass + tag

- [ ] **Step 1:** `pnpm exec vitest run` green.
- [ ] **Step 2:** `pnpm exec svelte-check` 0 errors/0 warnings.
- [ ] **Step 3:** `pnpm exec playwright test` green.
- [ ] **Step 4:** Final cross-layer review (label name flows UI ↔ endpoint ↔ DB unique constraint; MRU ordering consistent; applied-set correct per track; user-scoping on every query so no cross-user label leakage).
- [ ] **Step 5:** Maintainer live smoke: log in, play a track, add/remove/create labels, confirm MRU ordering across a reload. Then tag `plan-3-labels`.

---

## Out of scope (later plans)

- Library filter-by-label + label filter chips, and labels in the rating-row subtitle (Plan 4).
- In-app playback / lock-screen title (Plan 5).
- PWA polish (Plan 6).
- Label rename / delete / merge management UI — not requested for MVP; the schema supports it (cascade) when it's wanted.
