#!/bin/sh
# macOS / Linux: start the real clinic system (no demo data). Double-click (macOS) or run ./start.command
cd "$(dirname "$0")" || exit 1
if [ ! -f .env ]; then
  echo "First start: creating .env with a private database password..."
  cat > .env <<ENV
# EmergencyPlus settings. Keep this file private and do NOT delete it: it holds the database password.
DB_PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
APP_PORT=4080
TZ=Asia/Amman
BACKUP_DIR=./backups
BACKUP_TIME=02:00
BACKUP_KEEP_DAYS=30
ENV
fi
mkdir -p backups
PORT=$(grep '^APP_PORT=' .env | cut -d= -f2); PORT=${PORT:-4080}
docker compose up -d --build || { echo "Make sure Docker Desktop is running, then try again."; exit 1; }
echo "Waiting for the system to be ready..."
i=0; until curl -sf -o /dev/null "http://localhost:$PORT/api/health" || [ $i -ge 60 ]; do i=$((i+1)); sleep 3; done
open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null
echo "EmergencyPlus is running at http://localhost:$PORT  — first sign-in: admin / Admin@12345"
