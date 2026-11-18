#!/bin/sh
# Apply pending database migrations, then start the realtime service.
set -e
cd /app/packages/database
node /app/node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts
cd /app/apps/realtime
exec node dist/index.js
