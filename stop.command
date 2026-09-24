#!/bin/sh
cd "$(dirname "$0")" || exit 1
docker compose -f docker-compose.yml -f docker-compose.demo.yml stop
echo "EmergencyPlus stopped. Your data is kept."
