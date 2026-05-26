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

## 4. Pre-deploy command

In Coolify → App → General → **Pre-Deployment Command**, set:

```
pnpm db:migrate:prod
```

This runs `scripts/migrate.mjs` against `DATABASE_URL` in a one-off container
before the new app container starts. Safe to re-run — drizzle tracks applied
migrations.

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
