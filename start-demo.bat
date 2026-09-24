@echo off
chcp 65001 >nul
echo Starting EmergencyPlus demo... (first run takes a few minutes)
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
if errorlevel 1 (
  echo.
  echo Something went wrong. Make sure Docker Desktop is running, then try again.
  pause
  exit /b 1
)
echo.
echo Waiting for the system to be ready...
timeout /t 20 /nobreak >nul
start http://localhost:4080
echo EmergencyPlus is running at http://localhost:4080
pause
