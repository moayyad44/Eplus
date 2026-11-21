@echo off
cd /d "%~dp0"
docker compose -f docker-compose.yml -f docker-compose.demo.yml stop
echo EmergencyPlus demo stopped.
pause
