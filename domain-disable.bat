@echo off
rem EmergencyPlus - stop serving the domain (HTTPS). Access by IP address keeps working. No data is touched.
cd /d "%~dp0"
docker compose stop caddy
powershell -NoProfile -Command "Set-Content -Encoding ascii -Path .env -Value (Get-Content .env | Where-Object { ($_ -split '=',2)[0] -ne 'COMPOSE_PROFILES' })"
echo The domain is switched off. Run domain-setup.bat to switch it on again.
pause
