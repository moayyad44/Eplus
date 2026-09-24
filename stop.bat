@echo off
docker compose -f docker-compose.yml -f docker-compose.demo.yml stop
echo EmergencyPlus stopped. Your data is kept.
pause
