#!/bin/sh
# Container entrypoint: apply pending migrations, then start the SvelteKit
# adapter-node server. drizzle tracks applied migrations in
# __drizzle_migrations, so a restart loop will just no-op on subsequent runs.
#
# If migrations fail, we exit non-zero so Coolify / the orchestrator surfaces
# the failure rather than starting an app pointed at a half-applied schema.
set -e

echo "entrypoint: running migrations"
node scripts/migrate.mjs

echo "entrypoint: starting server"
exec node build/index.js
