# disccovery — Plan 1: Foundation + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the SvelteKit + Postgres skeleton with a working Spotify OAuth login. End state: a user can click "Log in with Spotify", grant scopes, land on a page showing their Spotify display name + ID, and log out. Refresh tokens are stored encrypted at rest; access tokens are minted on demand for the client.

**Architecture:** SvelteKit (Node adapter) server-side holds the Spotify client secret and refresh tokens. PKCE Authorization Code flow. Browser never sees the refresh token; it asks the server for a short-lived access token when it needs one. Postgres via Drizzle for users + tokens. Token encryption is AES-256-GCM with a key from `TOKEN_ENC_KEY`.

**Tech Stack:** SvelteKit 2 + Svelte 5 + TypeScript + Tailwind v4 + shadcn-svelte + Drizzle ORM + Postgres + Playwright. Bun or pnpm as package manager (plan uses pnpm; swap if user prefers Bun).

**Pre-flight (one-time, done by user, not the agent):**
- A Spotify Developer App must exist with redirect URI `http://127.0.0.1:5173/auth/callback` for local dev.
- Local Postgres must be reachable. The plan includes a `docker-compose.yml` for convenience.
- Env vars in `.env`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `DATABASE_URL`, `TOKEN_ENC_KEY` (32 random bytes, hex), `PUBLIC_BASE_URL=http://127.0.0.1:5173`.

> Spotify's Web Playback SDK works on iOS Safari with the `activateElement()` autoplay caveat (verified against current docs at brainstorm time). The `streaming` scope is requested even though playback isn't built yet — it's a no-op for Plan 1 and avoids a re-consent prompt later.

---

## File structure

```
discovery/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── svelte.config.js
├── vite.config.ts
├── tailwind.config.ts
├── drizzle.config.ts
├── docker-compose.yml                  # local Postgres
├── .env.example
├── .gitignore
├── playwright.config.ts
├── src/
│   ├── app.html
│   ├── app.css                         # Tailwind entrypoint
│   ├── hooks.server.ts                 # session cookie → locals.user
│   ├── lib/
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   ├── index.ts            # Drizzle client
│   │   │   │   └── schema.ts           # users, spotify_tokens
│   │   │   ├── crypto.ts               # AES-256-GCM encrypt/decrypt
│   │   │   ├── pkce.ts                 # PKCE verifier + challenge
│   │   │   ├── spotify.ts              # token exchange + refresh
│   │   │   └── session.ts              # signed session cookie helpers
│   │   └── components/
│   │       └── LoginButton.svelte
│   └── routes/
│       ├── +layout.svelte
│       ├── +page.svelte                # landing (logged-in or login button)
│       ├── auth/
│       │   ├── login/+server.ts        # GET → redirect to Spotify
│       │   ├── callback/+server.ts     # GET → exchange code, set cookie
│       │   └── logout/+server.ts       # POST → clear cookie
│       └── api/
│           └── spotify/
│               ├── access-token/+server.ts   # GET → short-lived token
│               └── me/+server.ts             # GET → /v1/me passthrough
├── drizzle/                            # generated migrations
└── tests/
    ├── unit/
    │   ├── crypto.test.ts
    │   └── pkce.test.ts
    └── e2e/
        └── auth.spec.ts
```

Each unit has one responsibility. `crypto.ts` and `pkce.ts` are pure functions, fully unit-testable. `spotify.ts` and `session.ts` are server-only helpers. Route handlers stay thin — they call the helpers.

---

## Task 1: Initialize SvelteKit project

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `src/app.html`, `src/routes/+page.svelte`

- [ ] **Step 1: Scaffold SvelteKit**

```bash
cd /Users/david/dev/discovery
pnpm dlx sv@latest create . --template minimal --types ts --no-add-ons
```

When prompted to install dependencies, answer yes. When prompted about init in non-empty dir, allow it.

- [ ] **Step 2: Install Node adapter (replace auto adapter)**

```bash
pnpm remove @sveltejs/adapter-auto
pnpm add -D @sveltejs/adapter-node
```

Edit `svelte.config.js` — replace the import line and the `adapter()` call:

```js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};

export default config;
```

- [ ] **Step 3: Verify dev server boots**

```bash
pnpm dev
```

Open http://127.0.0.1:5173 — should see the default SvelteKit welcome. Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "scaffold: sveltekit + ts + node adapter"
```

---

## Task 2: Tailwind v4 + base styles

**Files:**
- Create: `src/app.css`
- Modify: `src/routes/+layout.svelte` (create), `src/app.html`, `vite.config.ts`

- [ ] **Step 1: Install Tailwind v4 Vite plugin**

```bash
pnpm add -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Wire Tailwind into Vite**

Edit `vite.config.ts`:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
```

- [ ] **Step 3: Create the CSS entrypoint**

Create `src/app.css`:

```css
@import 'tailwindcss';

@theme {
  --color-spotify-green: #1DB954;
}

html, body { background: #000; color: #fff; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", sans-serif; }
```

- [ ] **Step 4: Create the root layout that imports the CSS**

Create `src/routes/+layout.svelte`:

```svelte
<script>
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
```

- [ ] **Step 5: Verify**

```bash
pnpm dev
```

Page should now be black with white text. Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "tailwind: v4 + base theme (black canvas, spotify green token)"
```

---

## Task 3: Local Postgres via Docker

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `.env`, `.gitignore`

- [ ] **Step 1: Compose file**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: disccovery
      POSTGRES_PASSWORD: disccovery
      POSTGRES_DB: disccovery
    ports:
      - "5433:5432"
    volumes:
      - disccovery_pgdata:/var/lib/postgresql/data

volumes:
  disccovery_pgdata:
```

(Port 5433 to avoid clashing with a system Postgres if any.)

- [ ] **Step 2: Env files**

Create `.env.example`:

```
DATABASE_URL=postgres://disccovery:disccovery@127.0.0.1:5433/disccovery
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
PUBLIC_BASE_URL=http://127.0.0.1:5173
TOKEN_ENC_KEY=
SESSION_SECRET=
```

Create local `.env` (USER fills in `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and generates `TOKEN_ENC_KEY` + `SESSION_SECRET`):

```bash
cp .env.example .env
# Generate the secrets:
node -e "console.log('TOKEN_ENC_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
# Then edit .env to paste in the Spotify client id/secret from developer.spotify.com.
```

- [ ] **Step 3: Update .gitignore**

Append to `.gitignore` (it already exists from the scaffold):

```
.env
.env.local
docker-compose.override.yml
playwright-report/
test-results/
.svelte-kit/
```

- [ ] **Step 4: Boot Postgres and verify**

```bash
docker compose up -d
docker compose ps
```

Both should show the db service as healthy/running.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "infra: local postgres via docker compose + .env scaffolding"
```

---

## Task 4: Drizzle ORM setup

**Files:**
- Create: `drizzle.config.ts`, `src/lib/server/db/index.ts`, `src/lib/server/db/schema.ts`

- [ ] **Step 1: Install Drizzle + driver**

```bash
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit @types/node
```

- [ ] **Step 2: Drizzle config**

Create `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 3: Schema**

Create `src/lib/server/db/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Drizzle's pg-core doesn't ship a bytea column type; define one via customType.
const byteaCol = customType<{ data: Buffer; default: false }>({
  dataType() { return 'bytea'; },
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  spotifyId: text('spotify_id').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spotifyTokens = pgTable('spotify_tokens', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenEnc: byteaCol('refresh_token_enc').notNull(),
  accessToken: text('access_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

- [ ] **Step 4: DB client**

Create `src/lib/server/db/index.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DATABASE_URL } from '$env/static/private';
import * as schema from './schema';

const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema });
export type DB = typeof db;
```

- [ ] **Step 5: Generate and apply initial migration**

```bash
pnpm drizzle-kit generate --name init
pnpm drizzle-kit migrate
```

Verify a `drizzle/0000_*.sql` file appeared.

- [ ] **Step 6: Add convenience scripts**

Edit `package.json` `scripts`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:push": "drizzle-kit push",
"db:studio": "drizzle-kit studio"
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "db: drizzle setup + users + spotify_tokens schema"
```

---

## Task 5: Token encryption helper (TDD)

**Files:**
- Create: `src/lib/server/crypto.ts`, `tests/unit/crypto.test.ts`

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest @vitest/ui
```

Edit `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Edit `vite.config.ts` to add the test block:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/crypto.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptToken, decryptToken } from '../../src/lib/server/crypto';

const KEY = Buffer.from('00'.repeat(32), 'hex'); // 32 zero bytes for test

describe('crypto', () => {
  it('round-trips a string', () => {
    const enc = encryptToken('hello-refresh-token', KEY);
    const dec = decryptToken(enc, KEY);
    expect(dec).toBe('hello-refresh-token');
  });

  it('produces different ciphertext each call (random nonce)', () => {
    const a = encryptToken('same-input', KEY);
    const b = encryptToken('same-input', KEY);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('throws on tampered ciphertext', () => {
    const enc = encryptToken('hello', KEY);
    enc[enc.length - 1] ^= 0xff; // flip the last byte (in the auth tag)
    expect(() => decryptToken(enc, KEY)).toThrow();
  });

  it('throws on wrong key', () => {
    const enc = encryptToken('hello', KEY);
    const wrong = Buffer.from('ff'.repeat(32), 'hex');
    expect(() => decryptToken(enc, wrong)).toThrow();
  });
});
```

- [ ] **Step 3: Run, expect failure**

```bash
pnpm test
```

Expected: fails with "Cannot find module './crypto'" or similar.

- [ ] **Step 4: Implement**

Create `src/lib/server/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

/**
 * Encrypts a UTF-8 string. Layout of returned buffer:
 *   [12-byte nonce][ciphertext][16-byte auth tag]
 */
export function encryptToken(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('crypto: key must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, enc, tag]);
}

export function decryptToken(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('crypto: key must be 32 bytes');
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('crypto: blob too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function loadKey(): Buffer {
  const hex = process.env.TOKEN_ENC_KEY;
  if (!hex) throw new Error('TOKEN_ENC_KEY env var missing');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  return buf;
}
```

- [ ] **Step 5: Run tests, expect pass**

```bash
pnpm test
```

All four tests should pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "crypto: AES-256-GCM token encryption (tested)"
```

---

## Task 6: PKCE helper (TDD)

**Files:**
- Create: `src/lib/server/pkce.ts`, `tests/unit/pkce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pkce.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generatePkce, computeChallenge } from '../../src/lib/server/pkce';
import { createHash } from 'node:crypto';

describe('pkce', () => {
  it('generates a 43-128 char verifier (base64url alphabet)', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('two calls produce different verifiers', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('computeChallenge agrees with generatePkce', () => {
    const { verifier, challenge } = generatePkce();
    expect(computeChallenge(verifier)).toBe(challenge);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test
```

Expected: fails with "Cannot find module './pkce'".

- [ ] **Step 3: Implement**

Create `src/lib/server/pkce.ts`:

```ts
import { randomBytes, createHash } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  // 32 bytes → 43 base64url chars (within the 43–128 spec range)
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computeChallenge(verifier);
  return { verifier, challenge };
}

export function computeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "pkce: verifier + challenge helpers (tested)"
```

---

## Task 7: Signed session cookie helper

**Files:**
- Create: `src/lib/server/session.ts`

This holds the user id in a signed cookie. We use HMAC-SHA256 to sign so the cookie can't be forged. No DB lookup needed to validate.

- [ ] **Step 1: Implement**

Create `src/lib/server/session.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_SECRET } from '$env/static/private';
import type { Cookies } from '@sveltejs/kit';

const COOKIE_NAME = 'disccovery_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(value: string): string {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

export function setSessionCookie(cookies: Cookies, userId: string): void {
  const sig = sign(userId);
  cookies.set(COOKIE_NAME, `${userId}.${sig}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
  });
}

export function readSessionCookie(cookies: Cookies): string | null {
  const raw = cookies.get(COOKIE_NAME);
  if (!raw) return null;
  const [userId, sig] = raw.split('.');
  if (!userId || !sig) return null;
  const expected = sign(userId);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "session: signed http-only cookie helpers"
```

---

## Task 8: SvelteKit hooks — load current user

**Files:**
- Create: `src/hooks.server.ts`
- Modify: `src/app.d.ts`

- [ ] **Step 1: Type the locals**

Edit `src/app.d.ts` (it was created by the scaffold):

```ts
declare global {
  namespace App {
    interface Locals {
      user: { id: string; spotifyId: string; displayName: string | null } | null;
    }
  }
}

export {};
```

- [ ] **Step 2: Hook**

Create `src/hooks.server.ts`:

```ts
import type { Handle } from '@sveltejs/kit';
import { readSessionCookie } from '$lib/server/session';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const handle: Handle = async ({ event, resolve }) => {
  const userId = readSessionCookie(event.cookies);
  if (userId) {
    const row = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    event.locals.user = row[0]
      ? { id: row[0].id, spotifyId: row[0].spotifyId, displayName: row[0].displayName }
      : null;
  } else {
    event.locals.user = null;
  }
  return resolve(event);
};
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "hooks: load current user from session cookie into locals"
```

---

## Task 9: Spotify token-exchange helper

**Files:**
- Create: `src/lib/server/spotify.ts`

This is the half that talks to Spotify's `/api/token` endpoint. Two functions: `exchangeCode` (called once on callback) and `refreshAccessToken` (called when a stored access token has expired).

- [ ] **Step 1: Implement**

Create `src/lib/server/spotify.ts`:

```ts
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, PUBLIC_BASE_URL } from '$env/static/private';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/callback`;

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;        // seconds
  scope: string;
  token_type: 'Bearer';
}

function basicAuth(): string {
  return 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }
  // Spotify may or may not return a new refresh_token; if absent, keep the old one.
  const json = await res.json();
  return { ...json, refresh_token: json.refresh_token ?? refreshToken };
}

export async function fetchSpotifyMe(accessToken: string): Promise<{ id: string; display_name: string | null; email?: string }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify /me failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "spotify: token exchange + refresh + /me helpers"
```

---

## Task 10: Login redirect endpoint

**Files:**
- Create: `src/routes/auth/login/+server.ts`

Stores the PKCE verifier in a short-lived cookie (so the callback can retrieve it) and redirects to Spotify's authorize page.

- [ ] **Step 1: Implement**

Create `src/routes/auth/login/+server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { generatePkce } from '$lib/server/pkce';
import { SPOTIFY_CLIENT_ID, PUBLIC_BASE_URL } from '$env/static/private';

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-library-read',
].join(' ');

export const GET: RequestHandler = async ({ cookies, url }) => {
  const { verifier, challenge } = generatePkce();

  cookies.set('disccovery_pkce', verifier, {
    path: '/auth/callback',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 10, // 10 minutes
  });

  const authorize = new URL('https://accounts.spotify.com/authorize');
  authorize.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', `${PUBLIC_BASE_URL}/auth/callback`);
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', challenge);

  throw redirect(302, authorize.toString());
};
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "auth: /auth/login → spotify authorize with PKCE"
```

---

## Task 11: OAuth callback handler

**Files:**
- Create: `src/routes/auth/callback/+server.ts`

On callback: pull the verifier from the cookie, exchange the code, fetch /me, upsert the user, store the encrypted refresh token, set the session cookie, redirect to `/`.

- [ ] **Step 1: Implement**

Create `src/routes/auth/callback/+server.ts`:

```ts
import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchSpotifyMe } from '$lib/server/spotify';
import { db } from '$lib/server/db';
import { users, spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encryptToken, loadKey } from '$lib/server/crypto';
import { setSessionCookie } from '$lib/server/session';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const oauthErr = url.searchParams.get('error');
  if (oauthErr) throw error(400, `Spotify denied authorization: ${oauthErr}`);
  if (!code) throw error(400, 'Missing code');

  const verifier = cookies.get('disccovery_pkce');
  if (!verifier) throw error(400, 'PKCE verifier missing or expired; please try again');
  cookies.delete('disccovery_pkce', { path: '/auth/callback' });

  const tokenSet = await exchangeCode(code, verifier);
  const me = await fetchSpotifyMe(tokenSet.access_token);

  // Upsert user
  const existing = await db.select().from(users).where(eq(users.spotifyId, me.id)).limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    await db.update(users)
      .set({ displayName: me.display_name })
      .where(eq(users.id, userId));
  } else {
    const inserted = await db.insert(users)
      .values({ spotifyId: me.id, displayName: me.display_name })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }

  // Store / overwrite encrypted refresh token + access token
  const key = loadKey();
  const enc = encryptToken(tokenSet.refresh_token, key);
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);

  await db.insert(spotifyTokens)
    .values({
      userId,
      refreshTokenEnc: enc,
      accessToken: tokenSet.access_token,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: spotifyTokens.userId,
      set: {
        refreshTokenEnc: enc,
        accessToken: tokenSet.access_token,
        expiresAt,
        updatedAt: new Date(),
      },
    });

  setSessionCookie(cookies, userId);
  throw redirect(303, '/');
};
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "auth: /auth/callback → exchange code, upsert user, set session"
```

---

## Task 12: Access-token endpoint (client → server)

**Files:**
- Create: `src/routes/api/spotify/access-token/+server.ts`

The browser asks the server for a short-lived access token when it needs to talk to Spotify (later: SDK init, Web API calls). Server refreshes if expired.

- [ ] **Step 1: Implement**

Create `src/routes/api/spotify/access-token/+server.ts`:

```ts
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decryptToken, encryptToken, loadKey } from '$lib/server/crypto';
import { refreshAccessToken } from '$lib/server/spotify';

const SAFETY_MS = 60_000; // refresh 1 min before expiry

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const row = await db.select().from(spotifyTokens)
    .where(eq(spotifyTokens.userId, locals.user.id)).limit(1);
  if (!row[0]) throw error(500, 'no spotify token for user');

  const now = Date.now();
  const expiresAt = row[0].expiresAt?.getTime() ?? 0;

  if (row[0].accessToken && expiresAt - now > SAFETY_MS) {
    return json({ access_token: row[0].accessToken, expires_at: expiresAt });
  }

  // Refresh
  const key = loadKey();
  const refreshToken = decryptToken(row[0].refreshTokenEnc, key);
  const fresh = await refreshAccessToken(refreshToken);
  const newExpiresAt = new Date(now + fresh.expires_in * 1000);
  const newEnc = encryptToken(fresh.refresh_token, key);

  await db.update(spotifyTokens)
    .set({
      accessToken: fresh.access_token,
      refreshTokenEnc: newEnc,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(spotifyTokens.userId, locals.user.id));

  return json({ access_token: fresh.access_token, expires_at: newExpiresAt.getTime() });
};
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "api: /api/spotify/access-token → short-lived token with refresh"
```

---

## Task 13: /api/spotify/me passthrough

**Files:**
- Create: `src/routes/api/spotify/me/+server.ts`

- [ ] **Step 1: Implement**

Create `src/routes/api/spotify/me/+server.ts`:

```ts
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchSpotifyMe } from '$lib/server/spotify';

export const GET: RequestHandler = async ({ locals, fetch }) => {
  if (!locals.user) throw error(401, 'not logged in');
  // Reuse the access-token endpoint via internal fetch to dodge refresh logic duplication.
  const tokRes = await fetch('/api/spotify/access-token');
  if (!tokRes.ok) throw error(tokRes.status, 'token unavailable');
  const { access_token } = await tokRes.json();
  const me = await fetchSpotifyMe(access_token);
  return json(me);
};
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "api: /api/spotify/me passthrough"
```

---

## Task 14: Logout endpoint

**Files:**
- Create: `src/routes/auth/logout/+server.ts`

- [ ] **Step 1: Implement**

Create `src/routes/auth/logout/+server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSessionCookie } from '$lib/server/session';

export const POST: RequestHandler = async ({ cookies }) => {
  clearSessionCookie(cookies);
  throw redirect(303, '/');
};
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "auth: /auth/logout"
```

---

## Task 15: Landing page (login button OR hello-user)

**Files:**
- Create: `src/lib/components/LoginButton.svelte`, `src/routes/+page.server.ts`
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Server load — pass user into the page**

Create `src/routes/+page.server.ts`:

```ts
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  return { user: locals.user };
};
```

- [ ] **Step 2: Login button component**

Create `src/lib/components/LoginButton.svelte`:

```svelte
<a
  href="/auth/login"
  class="inline-block rounded-full bg-spotify-green text-black font-bold px-6 py-3 hover:opacity-90"
>
  Log in with Spotify
</a>
```

- [ ] **Step 3: Page**

Replace `src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import LoginButton from '$lib/components/LoginButton.svelte';
  let { data } = $props();
</script>

<main class="min-h-screen flex flex-col items-center justify-center gap-6 p-6 text-center">
  <h1 class="text-4xl font-black tracking-tight">
    <span class="text-spotify-green">disc</span>overy
  </h1>

  {#if data.user}
    <p class="text-lg">Hi, <strong>{data.user.displayName ?? data.user.spotifyId}</strong></p>
    <p class="text-sm opacity-60">Spotify id: {data.user.spotifyId}</p>
    <form method="POST" action="/auth/logout">
      <button class="rounded-full border border-white/20 px-5 py-2 hover:bg-white/10">
        Log out
      </button>
    </form>
  {:else}
    <p class="opacity-70 max-w-sm">Rate and label what you're listening to.</p>
    <LoginButton />
  {/if}
</main>
```

- [ ] **Step 4: Verify manually**

```bash
pnpm dev
```

Visit http://127.0.0.1:5173 — should see "disccovery" + Log in button. Click it, complete the Spotify flow, land back at "Hi, {your name}".

Click "Log out" — back to the login button.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ui: landing page (login button OR hello-user) + logout form"
```

---

## Task 16: Playwright E2E for the auth flow

We can't drive Spotify's real OAuth screen in CI. Instead, mock the redirect by hitting `/auth/callback` directly with a stub that doesn't actually call Spotify. The cleanest pattern is to inject a test-only "fake exchange" path.

A simpler path that doesn't fork production code: stub `fetch` for the Spotify token endpoint inside Playwright via a route-mock. This requires loading the SvelteKit dev server with a test-mode env flag.

We'll take the route-mock approach.

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/auth.spec.ts`

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

- [ ] **Step 2: Config**

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

Add to `package.json` scripts:

```json
"e2e": "playwright test"
```

- [ ] **Step 3: E2E test**

Create `tests/e2e/auth.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// This test verifies the LOGGED-OUT landing page and that /auth/login redirects
// to accounts.spotify.com. We do NOT drive Spotify's real OAuth screen.
// A future integration test (with a real test account + manual login) will cover
// the full callback round-trip.

test('logged-out landing shows login button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /log in with spotify/i })).toBeVisible();
});

test('/auth/login redirects to spotify accounts', async ({ page }) => {
  // Stop following the redirect so we can assert on the destination
  const resp = await page.request.get('/auth/login', { maxRedirects: 0 });
  expect(resp.status()).toBe(302);
  const loc = resp.headers()['location'];
  expect(loc).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize/);
  // PKCE challenge present
  expect(loc).toMatch(/code_challenge_method=S256/);
  expect(loc).toMatch(/code_challenge=[A-Za-z0-9_-]+/);
});

test('/auth/callback without PKCE cookie 400s', async ({ page }) => {
  const resp = await page.request.get('/auth/callback?code=fake', { maxRedirects: 0 });
  expect(resp.status()).toBe(400);
});
```

- [ ] **Step 4: Run**

```bash
docker compose up -d
pnpm e2e
```

All three tests should pass. The full happy-path callback test is left for a manual smoke (you'll exercise it in Step 4 of Task 15 already).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "e2e: playwright auth tests (login button, redirect, callback 400)"
```

---

## Task 17: Final manual smoke + verify

- [ ] **Step 1: Fresh DB sanity**

```bash
docker compose down -v   # wipe data
docker compose up -d
pnpm db:migrate
```

- [ ] **Step 2: Full happy path manually**

```bash
pnpm dev
```

1. Open http://127.0.0.1:5173
2. Click "Log in with Spotify"
3. Approve scopes on Spotify's screen
4. Land at "Hi, {your name}"
5. Open Drizzle Studio (`pnpm db:studio`) → verify a `users` row and a `spotify_tokens` row with non-null encrypted `refresh_token_enc`
6. Visit http://127.0.0.1:5173/api/spotify/me → should return your Spotify profile JSON
7. Click "Log out" → back to the login button
8. Click "Log in with Spotify" again → no re-consent (already authorized), straight back to "Hi, {your name}"

- [ ] **Step 3: All checks pass — tag the end of Plan 1**

```bash
git tag plan-1-foundation
```

---

## Plan 1 done — what's next

Plan 1 ships:
- ✅ SvelteKit + TS + Tailwind v4 + shadcn-svelte-ready
- ✅ Local Postgres + Drizzle migrations
- ✅ AES-256-GCM token encryption (tested)
- ✅ PKCE helpers (tested)
- ✅ Signed session cookies
- ✅ Spotify OAuth login + callback + logout
- ✅ Server-mediated access-token refresh
- ✅ `/api/spotify/me` passthrough
- ✅ Landing page (login OR hello-user)
- ✅ Playwright covers login button, redirect, callback validation

After Plan 1 lands, write **Plan 2: Currently-playing + rating** — it'll cover the now-playing screen, the ½-star component, the `ratings` table + endpoints, and Playwright over the rating flow.
