@echo off
rem EmergencyPlus - start the real clinic system (no demo data).
chcp 65001 >nul
cd /d "%~dp0"
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Start Docker Desktop, wait until it is ready, then try again.
  pause
  exit /b 1
)

if exist .env goto haveenv
echo First start: creating the settings file .env with a private database password...
powershell -NoProfile -Command "$p = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); Set-Content -Encoding ascii -Path .env -Value @('# EmergencyPlus settings. Keep this file private and do NOT delete it: it holds the database password.', ('DB_PASSWORD=' + $p), 'APP_PORT=4080', 'TZ=Asia/Amman', '# Where daily backups are saved. Best: an external disk or a OneDrive / Google Drive folder, e.g. D:/EmergencyPlus-Backups', 'BACKUP_DIR=./backups', 'BACKUP_TIME=02:00', 'BACKUP_KEEP_DAYS=30')"
if not exist .env (
  echo Could not create the .env file.
  pause
  exit /b 1
)
:haveenv

set APP_PORT=4080
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if "%%a"=="APP_PORT" set APP_PORT=%%b
if not exist backups mkdir backups

rem The demo copy used to run on the same port: stop it if it is holding this port.
for /f %%c in ('docker ps -q --filter "label=com.docker.compose.project=emergencyplus" --filter "publish=%APP_PORT%"') do (
  echo Stopping the demo copy that is using port %APP_PORT%...
  docker compose -f docker-compose.yml -f docker-compose.demo.yml stop >nul
  goto demostopped
)
:demostopped

echo Starting EmergencyPlus... (the first start takes a few minutes)
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Something went wrong while starting. Make sure Docker Desktop is running, then try again.
  pause
  exit /b 1
)

echo Waiting for the system to be ready...
for /l %%i in (1,1,60) do (
  curl -s -o nul -f http://localhost:%APP_PORT%/api/health && goto ready
  timeout /t 3 /nobreak >nul
)
echo The system is taking longer than usual. Check with:  docker compose logs app
pause
exit /b 1

:ready
start http://localhost:%APP_PORT%
echo.
echo ============================================================
echo  EmergencyPlus is running:  http://localhost:%APP_PORT%
echo  Other devices on the clinic network open one of these:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%b in ("%%a") do echo     http://%%b:%APP_PORT%
echo  (use the address that starts with 192.168 or 10. - not the Docker/WSL ones)
echo  First sign-in: admin / Admin@12345  (you will be asked to set a new password)
echo  Daily backups are saved automatically (see BACKUP_DIR in .env).
echo ============================================================
pause
