@echo off
rem Updates EmergencyPlus to the latest version. A backup is taken first; your data is kept.
cd /d "%~dp0"
echo 1/3  Backing up your data first...
docker compose run --rm backup now
if errorlevel 1 (
  echo The backup failed, so the update was not started. Run start.bat, then try again.
  pause
  exit /b 1
)
echo 2/3  Downloading the latest version...
git pull
if errorlevel 1 (
  echo Could not download the update. Check the internet connection and try again.
  pause
  exit /b 1
)
echo 3/3  Rebuilding and restarting... (a few minutes)
docker compose up -d --build
if errorlevel 1 (
  echo Something went wrong while restarting. Run start.bat.
  pause
  exit /b 1
)
echo Update complete.
pause
