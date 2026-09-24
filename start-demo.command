#!/bin/sh
# macOS / Linux: double-click (macOS) or run ./start-demo.command
cd "$(dirname "$0")" || exit 1
echo "Starting EmergencyPlus demo... (first run takes a few minutes)"
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build || { echo "Make sure Docker Desktop is running, then try again."; exit 1; }
echo "Waiting for the system to be ready..."
sleep 20
open http://localhost:4080 2>/dev/null || xdg-open http://localhost:4080 2>/dev/null
echo "EmergencyPlus is running at http://localhost:4080"
