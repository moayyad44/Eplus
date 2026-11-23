@echo off
cd /d "%~dp0"
docker compose stop
echo EmergencyPlus stopped. Your data is kept.
pause
