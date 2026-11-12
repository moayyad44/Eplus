#!/bin/sh
# EmergencyPlus container start-up.
set -e
cd /app/server

# A signing secret is required. If none was provided, generate one once and keep it in the data volume.
if [ -z "$JWT_SECRET" ]; then
  if [ ! -s /data/jwt-secret ]; then
    node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))" > /data/jwt-secret
    chmod 600 /data/jwt-secret
  fi
  JWT_SECRET="$(cat /data/jwt-secret)"
  export JWT_SECRET
fi

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Syncing permissions and base configuration"
npx tsx prisma/bootstrap.ts

if [ "$DEMO_DATA" = "true" ]; then
  echo "==> Loading demo data (DEMO_DATA=true)"
  ALLOW_DEMO_SEED=true npx tsx prisma/seed-dev.ts
fi

echo "==> EmergencyPlus is starting — open http://localhost:${APP_PORT:-4080}"
exec node dist/index.js
