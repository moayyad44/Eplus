@echo off
rem Demo / training copy with sample data - separate from the real clinic data. Runs on port 4090.
chcp 65001 >nul
cd /d "%~dp0"
set APP_PORT=4090
echo Starting the EmergencyPlus DEMO... (first run takes a few minutes)
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
if errorlevel 1 (
  echo.
  echo Something went wrong. Make sure Docker Desktop is running, then try again.
  pause
  exit /b 1
)
echo Waiting for the demo to be ready...
for /l %%i in (1,1,60) do (
  curl -s -o nul -f http://localhost:4090/api/health && goto ready
  timeout /t 3 /nobreak >nul
)
:ready
start http://localhost:4090
echo The DEMO is running at http://localhost:4090  (demo data only - not the real clinic)
pause
