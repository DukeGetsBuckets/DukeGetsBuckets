#!/usr/bin/env bash
# Builds the all-in-one container image for Cloudflare Containers.
#
#   PUBLIC_URL=https://tempo-chess.<your-subdomain>.workers.dev deploy/cloudflare/build-image.sh [image-tag]
#
# The three apps are built on the host (the same production builds as `pnpm build`), copied into a
# staging directory together with production-only node_modules and a Node binary, and then packed
# into an Ubuntu image that also contains PostgreSQL, Redis, Stockfish and nginx.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$ROOT/deploy/cloudflare/.stage"
TAG="${1:-tempo-chess:local}"
: "${PUBLIC_URL:?set PUBLIC_URL to the final https URL of the Worker}"

echo "==> building apps for $PUBLIC_URL"
cd "$ROOT"
export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Placeholders only satisfy module-load checks during `next build`; real values are read at runtime.
export DATABASE_URL="postgresql://build:build@localhost:5432/build" REDIS_URL="redis://localhost:6379"
export BETTER_AUTH_SECRET="build-time-placeholder-secret-0123456789" REALTIME_JWT_SECRET="build-time-placeholder-secret-0123456789"
export BETTER_AUTH_URL="$PUBLIC_URL" NEXT_PUBLIC_WEB_URL="$PUBLIC_URL" NEXT_PUBLIC_REALTIME_URL="$PUBLIC_URL" REALTIME_PUBLIC_URL="$PUBLIC_URL"
pnpm --filter @tempo/database generate
pnpm --filter @tempo/web build
pnpm --filter @tempo/realtime build
pnpm --filter @tempo/worker build

echo "==> assembling build context"
rm -rf "$STAGE"
mkdir -p "$STAGE/web" "$STAGE/realtime" "$STAGE/worker"
cp -a apps/web/.next/standalone/. "$STAGE/web/"
mkdir -p "$STAGE/web/apps/web/.next"
cp -a apps/web/.next/static "$STAGE/web/apps/web/.next/static"
cp -a apps/web/public "$STAGE/web/apps/web/public"
cp -a apps/realtime/dist "$STAGE/realtime/dist"
cp -a apps/worker/dist "$STAGE/worker/dist"
cp -a packages/database/prisma/migrations "$STAGE/migrations"
rm -f "$STAGE/migrations/migration_lock.toml"
cp "$(readlink -f "$(command -v node)")" "$STAGE/node"
cp deploy/cloudflare/container/supervisor.mjs deploy/cloudflare/container/nginx.conf.template deploy/cloudflare/container/Dockerfile "$STAGE/"

echo "==> installing production dependencies for realtime + worker"
node -e '
const fs = require("fs");
const merged = {};
for (const app of ["realtime", "worker"]) {
  const pkg = JSON.parse(fs.readFileSync(`apps/${app}/package.json`, "utf8"));
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith("@tempo/")) merged[name] = version;
  }
}
fs.writeFileSync(process.argv[1], JSON.stringify({ name: "tempo-runtime", private: true, dependencies: merged }, null, 2));
' "$STAGE/package.json"
(cd "$STAGE" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$STAGE/package.json" "$STAGE/package-lock.json"

BROKEN="$(find "$STAGE/web" -xtype l | head -5)"
if [ -n "$BROKEN" ]; then echo "broken symlinks in standalone output:"; echo "$BROKEN"; exit 1; fi

echo "==> docker build $TAG (host network so apt can reach the mirrors)"
docker build --network host -t "$TAG" "$STAGE"
docker image ls "$TAG"
