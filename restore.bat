@echo off
rem Restores a backup. ALL current data is replaced (a safety copy of the current data is saved first).
chcp 65001 >nul
cd /d "%~dp0"
echo Available backups (newest first):
docker compose run --rm --entrypoint sh backup -c "ls -1t /backups | grep '^eplus-backup-'"
if errorlevel 1 (
  echo No backups found, or EmergencyPlus is not running ^(run start.bat first^).
  pause
  exit /b 1
)
echo.
set /p FILE=Type or paste the backup file name to restore: 
if "%FILE%"=="" exit /b 1
echo.
echo WARNING: all current data will be replaced by "%FILE%".
echo A safety copy of the current data is saved first.
set /p OK=Type YES to continue: 
if /i not "%OK%"=="YES" (
  echo Cancelled.
  pause
  exit /b 1
)
docker compose stop app
docker compose run --rm backup restore "%FILE%"
set RESULT=%errorlevel%
docker compose start app
if not "%RESULT%"=="0" (
  echo RESTORE FAILED - see the message above. Your data from before the restore was saved as a backup file; restore that file to go back.
  pause
  exit /b 1
)
echo Restore complete. Sign in again to continue.
pause
