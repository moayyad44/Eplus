@echo off
rem EmergencyPlus - health check of the clinic server (read-only: nothing is changed).
chcp 65001 >nul
cd /d "%~dp0"
set APP_PORT=4080
set DOMAIN=
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if "%%a"=="APP_PORT" set APP_PORT=%%b
  if "%%a"=="DOMAIN" set DOMAIN=%%b
)
echo.
echo [1] Services (all should be "running" / "healthy"):
docker compose ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"
echo.
echo [2] Program + database by IP (clinic network):
curl -s -f http://localhost:%APP_PORT%/api/health && echo   OK || echo   NOT RESPONDING
if not "%DOMAIN%"=="" (
  echo.
  echo [3] HTTPS on the domain (on this computer):
  curl -s -f --resolve %DOMAIN%:443:127.0.0.1 https://%DOMAIN%/api/health && echo   OK || echo   NOT RESPONDING - see: docker compose logs caddy
  echo     The domain resolves to:
  nslookup %DOMAIN% 1.1.1.1 2>nul | findstr /r /c:"Address.*[0-9]" | findstr /v "1.1.1.1"
)
echo.
echo [4] The database must NOT be reachable from outside Docker (expect no lines below):
netstat -ano | findstr /r /c:":5432 .*LISTENING"
echo.
echo [5] Latest backups:
dir /b /o-d backups\eplus-backup-*.tar 2>nul || echo   No backup files found in the backups folder!
echo.
echo [6] Tailscale (access from outside the clinic):
where tailscale >nul 2>&1 && (tailscale ip -4 & tailscale status) || echo   Tailscale is not installed on this computer.
echo.
pause
