# discovery — Claude notes

## Spotify developer policy guardrail

Before implementing **any** new feature that touches Spotify data, playback, or the SDK, check it against Spotify's developer terms. If the proposed change is in the gray zone or clearly disallowed, **stop and flag it before writing code** — don't build it and surface the issue later.

Things to call out, in order of severity:

1. **Hard rejections (will get the app banned, never build):**
   - Downloading, ripping, recording, or persisting audio streams or 30-second previews beyond Spotify's permitted caching window.
   - Circumventing DRM or the Web Playback SDK's playback pipeline.
   - Manipulating play counts (auto-play loops to inflate streams, bot-like playback patterns).
   - Reselling Spotify data, audio, or metadata to third parties.
   - Building features that let users export Spotify audio out of the platform.

2. **Approval-blockers (will fail extended quota review):**
   - Aggregating other users' listening data into a product offered to people who aren't those users (analytics-as-a-service across accounts without explicit per-user consent).
   - Cloning Spotify's own surfaces (a search-and-play UI that's effectively a Spotify front-end with no added value).
   - Removing required Spotify attribution / logos from playback surfaces.
   - Storing full track audio server-side, or caching it beyond what the SDK + their caching rules permit.
   - Using the API to power a competing streaming service or a non-Spotify playback target.

3. **Worth a second look (probably fine, but flag the reasoning):**
   - New scopes being requested — confirm we actually need them and that the use is documented.
   - Anything that writes to the user's Spotify account (playlists, library, follows) — confirm it's user-initiated, not automatic background writes.
   - Sharing or exporting rating data tied to Spotify track IDs — fine as long as we're sharing *the user's opinions about tracks*, not Spotify's catalog data.
   - Anything that displays track metadata outside an authenticated Spotify context (e.g. public pages showing track info to logged-out viewers) — check the attribution + linking rules.

**What discovery currently does is fine:** OAuth login, Web Playback SDK, rating tracks the user listens to, building personal library/taste data. Standard good-citizen integration.

When in doubt, say so out loud before coding. A 30-second "hey, this might trip the policy because X" beats discovering it at extended-quota review.
