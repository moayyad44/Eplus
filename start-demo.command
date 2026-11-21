#!/bin/sh
# Demo / training copy with sample data — separate from the real clinic data. Runs on port 4090.
cd "$(dirname "$0")" || exit 1
echo "Starting the EmergencyPlus DEMO... (first run takes a few minutes)"
APP_PORT=4090 docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build || { echo "Make sure Docker Desktop is running, then try again."; exit 1; }
i=0; until curl -sf -o /dev/null http://localhost:4090/api/health || [ $i -ge 60 ]; do i=$((i+1)); sleep 3; done
open http://localhost:4090 2>/dev/null || xdg-open http://localhost:4090 2>/dev/null
echo "The DEMO is running at http://localhost:4090"
