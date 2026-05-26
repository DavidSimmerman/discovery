/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Offline-shell service worker for disccovery.
//
// Caching model:
//   - Cache-first for build artifacts (hashed JS/CSS) and static files (icons,
//     manifest, robots, offline.html). Hashed URLs are content-stable so this is
//     safe and fast.
//   - Network-first for everything else (navigations, dynamic same-origin
//     requests). We never cache navigation responses, because the SSR HTML
//     embeds per-user session data — caching it would risk leaking the previous
//     user's data across logout / new-user-on-same-browser scenarios.
//   - On navigation failure (offline), we serve a neutral /offline.html shell —
//     no user data, just the brand + a "try again" button.
//
// What this MUST NOT cache (per Spotify developer policy + CLAUDE.md):
//   - Any /api/* response.
//   - Any Spotify-hosted asset (audio, previews, scdn.co images, accounts).
//   - Any SSR navigation HTML containing user data.

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE = `disccovery-shell-${version}`;

// Hashed + static assets we precache. ASSET_SET enables O(1) "is this URL
// cache-first eligible?" lookup in the fetch handler.
const ASSETS = [
  ...build,
  ...files,
];
const ASSET_SET = new Set(ASSETS);

// The offline navigation fallback. Must be present in `files` (i.e. under
// /static) so it's precached above.
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  // Intentionally NOT calling skipWaiting(). When a new deployment installs
  // while a tab from the previous build is still open, that tab keeps fetching
  // old hashed /_app/immutable/* chunks — we let the previous worker keep
  // serving until all clients of that build are closed, then activate.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop previous-version shell caches so stale build hashes don't pile up.
      // Safe to do here because activate only fires once all old clients close.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Also intentionally NOT calling clients.claim() — wait for natural
      // reload so clients only switch to this worker when their build matches.
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Non-GETs (POST/PUT/DELETE for ratings, labels, logout) always go straight
  // to the network so optimistic UI + auth still work.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (Spotify CDN audio/images/auth) always bypasses the SW.
  if (url.origin !== self.location.origin) return;

  // Same-origin /api/* always bypasses — per-user data must never be cached.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      // Cache-first for the precached, content-hashed asset list.
      if (ASSET_SET.has(url.pathname)) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }

      // Network-first for everything else. We never store the response — see
      // the privacy note at the top of this file.
      try {
        return await fetch(request);
      } catch {
        if (request.mode === 'navigate') {
          const fallback = await cache.match(OFFLINE_URL);
          if (fallback) return fallback;
        }
        return Response.error();
      }
    })(),
  );
});
