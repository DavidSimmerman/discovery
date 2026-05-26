# Multi-stage image for disccovery (SvelteKit + adapter-node).
#
# Stage layout:
#   deps  — pnpm install with the lockfile (full devDeps for build)
#   build — vite build with static env baked in via build args
#   run   — slim Node runtime serving build/index.js
#
# Migrations are NOT run automatically on container start. Instead, run
# `pnpm db:migrate:prod` as a Coolify pre-deploy command (one-off container)
# so a crash-loop restart can't re-trigger them mid-migration.

ARG NODE_VERSION=22

# ------- deps -------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ------- build ------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
RUN corepack enable

# Static $env/static/public + private values are inlined at build time, so
# Coolify must pass them as build args (and as runtime env for the running
# server too — adapter-node still reads several of these at request time).
ARG PUBLIC_BASE_URL
ARG SPOTIFY_CLIENT_ID
ARG SPOTIFY_CLIENT_SECRET
ARG SESSION_SECRET
ARG DATABASE_URL
ENV PUBLIC_BASE_URL=$PUBLIC_BASE_URL \
    SPOTIFY_CLIENT_ID=$SPOTIFY_CLIENT_ID \
    SPOTIFY_CLIENT_SECRET=$SPOTIFY_CLIENT_SECRET \
    SESSION_SECRET=$SESSION_SECRET \
    DATABASE_URL=$DATABASE_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# Drop devDeps from node_modules before copying to the runtime stage. Keeps
# drizzle-orm + postgres (needed by scripts/migrate.mjs and the running server)
# but removes vite, vitest, playwright, etc.
RUN pnpm prune --prod

# ------- run --------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# adapter-node artifacts + pruned deps + drizzle SQL (for the migrator script).
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs

EXPOSE 3000
CMD ["node", "build/index.js"]
