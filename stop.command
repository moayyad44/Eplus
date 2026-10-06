#!/bin/sh
cd "$(dirname "$0")" || exit 1
docker compose stop
echo "EmergencyPlus stopped. Your data is kept."
