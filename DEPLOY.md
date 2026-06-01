# Deploying disccovery (Coolify + Cloudflare tunnel)

Concise checklist. Assumes Coolify is already installed and Cloudflare tunnel reaches it.

## 1. Provision Postgres in Coolify

In the same Coolify project as the app, add a **PostgreSQL** resource. Coolify
exposes it on the internal Docker network — copy the generated connection
string for the next step.

## 2. Generate secrets

Run locally, one fresh value each:

```sh
openssl rand -base64 32   # → SESSION_SECRET
openssl rand -base64 32   # → TOKEN_ENC_KEY
```

## 3. Environment variables (Coolify → App → Environment)

Mark the ones below as **both** "Build Variable" and runtime — SvelteKit's
`$env/static/*` reads happen at build time, but adapter-node also reads them
at request time.

| Key                     | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| `DATABASE_URL`          | Postgres URL from step 1                                |
| `SPOTIFY_CLIENT_ID`     | Spotify dashboard → your app                            |
| `SPOTIFY_CLIENT_SECRET` | Spotify dashboard → your app                            |
| `PUBLIC_BASE_URL`       | `https://<your-domain>` (e.g. the Cloudflare hostname)  |
| `SESSION_SECRET`        | from step 2                                             |
| `TOKEN_ENC_KEY`         | from step 2                                             |
| `ORIGIN`                | same as `PUBLIC_BASE_URL` — adapter-node CSRF check     |
| `PROTOCOL_HEADER`       | `x-forwarded-proto` — needed behind the tunnel          |
| `HOST_HEADER`           | `x-forwarded-host` — needed behind the tunnel          |
| `NODE_ENV`              | `production`                                            |
| `PORT`                  | `3000` (matches the Dockerfile EXPOSE)                  |

Without `ORIGIN` + the `*_HEADER` vars, every POST (rating, label, logout)
gets rejected as cross-origin once you're behind the tunnel.

## 4. Migrations

Migrations run automatically on container start via `scripts/docker-entrypoint.sh`
— no Coolify pre-deploy command needed. Drizzle tracks applied migrations in
`__drizzle_migrations`, so restarts are no-ops. A migration failure exits
non-zero before adapter-node boots, so we never serve traffic against a
half-applied schema.

To run a migration manually (e.g. from the Coolify Terminal tab), use:

```
pnpm db:migrate:prod
```

## 5. Spotify dashboard

In the Spotify developer dashboard for your app:

- **Redirect URIs** → add `https://<your-domain>/auth/callback`
- Keep the localhost callback if you still develop locally
- Confirm requested scopes still match `src/routes/auth/login/+server.ts`

## 6. Cloudflare tunnel

In Cloudflare Zero Trust → Tunnels:

- **Public hostname** → service URL = `http://<coolify-container-name>:3000`
  (Coolify shows the container hostname in the app's "FQDN" or "Network" tab)
- DNS record auto-created for the chosen hostname
- HTTPS termination is handled by Cloudflare — the origin can speak plain HTTP

## 7. Build + first deploy

Coolify reads the repo's `Dockerfile` automatically. Trigger a deploy. First
boot will:

1. Pre-deploy: apply migrations
2. App container: start adapter-node on port 3000

## 8. Smoke check after deploy

- `GET /` → 200, login page
- Log in via Spotify → returns to `/`, then visit `/now-playing`
- Rate a track, apply a label, open `/library`
- Add to home screen on iOS — branded icon, opens to `/now-playing`
- DevTools → Application → Service Worker installed; Manifest fields green

## Local production sanity test

To smoke the Dockerfile before pushing to Coolify:

```sh
# Build (pass the static envs the build inlines)
docker build \
  --build-arg PUBLIC_BASE_URL=http://localhost:3000 \
  --build-arg SPOTIFY_CLIENT_ID=... \
  --build-arg SPOTIFY_CLIENT_SECRET=... \
  --build-arg SESSION_SECRET=$(openssl rand -base64 32) \
  --build-arg DATABASE_URL=postgres://disccovery:disccovery@host.docker.internal:5434/disccovery \
  -t disccovery .

# Run (note: ORIGIN must match the URL you'll actually visit)
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://disccovery:disccovery@host.docker.internal:5434/disccovery \
  -e SPOTIFY_CLIENT_ID=... \
  -e SPOTIFY_CLIENT_SECRET=... \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e ORIGIN=http://localhost:3000 \
  -e SESSION_SECRET=... \
  -e TOKEN_ENC_KEY=... \
  -e NODE_ENV=production \
  disccovery
```

## Syncing the prod library into local dev

`scripts/library-transfer.mjs` (wrappers: `pnpm library:export` / `pnpm library:import`)
copies a user's taste data — ratings, labels, track-labels, plus the referenced
`tracks` / `artists` / `track_artists` rows — between databases. It does NOT touch
plays, shuffle state, AI suggestions, top lists, users, or Spotify tokens. Import
is idempotent, transactional, additive (upsert — it never deletes local rows), and
re-points everything at the target DB's user.

**Reaching prod from a dev machine on the LAN.** Prod Postgres runs as the
`discovery-db` Coolify resource. It is *not* reachable over the WAN (only the app
is, via the Cloudflare tunnel), but with "Make it publicly available" enabled
Coolify binds it on the host's public port, reachable on the **LAN** at
`<coolify-host-LAN-IP>:<public-port>` (currently `192.168.1.56:3160`; the Coolify
UI is at `http://192.168.1.56:8000`).

Grab the full connection string from Coolify → `discovery-db` → **Postgres URL
(public)** — it contains the password, so pass it inline via `--db` and never
commit it. Prod has more than one user, so select yours by Spotify ID.

```sh
# 1. Export your prod library to a file (paste the public URL from Coolify)
pnpm library:export \
  --db 'postgres://postgres:<PASSWORD>@192.168.1.56:3160/postgres' \
  --user 313e7xmyj7jaq6cjrlpsmewfsona \
  --out /tmp/prod-lib.json

# 2. Load it into local dev (uses .env's DATABASE_URL)
pnpm library:import /tmp/prod-lib.json --user 313e7xmyj7jaq6cjrlpsmewfsona

# Preview without writing: add --dry-run to the import.
```

When done, untick "Make it publicly available" in Coolify if you don't want the
DB exposed on the LAN, and rotate the password if the URL leaked anywhere.
