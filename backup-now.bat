@echo off
rem Makes a backup right now (database + attachments) into the backups folder.
cd /d "%~dp0"
docker compose run --rm backup now
if errorlevel 1 (
  echo BACKUP FAILED. Make sure EmergencyPlus is running ^(start.bat^) and try again.
  pause
  exit /b 1
)
echo.
echo Backup saved. Copy the newest file in the backups folder to a USB disk or cloud folder from time to time.
pause
