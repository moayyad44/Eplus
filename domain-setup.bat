@echo off
rem EmergencyPlus - serve the system on the clinic's own domain over HTTPS (run on the clinic server).
rem The database and all files stay on this computer. No router port is opened.
chcp 65001 >nul
cd /d "%~dp0"
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Start it, wait until it is ready, then run this again.
  pause
  exit /b 1
)
if not exist .env (
  echo Run start.bat once first - it creates the settings file .env.
  pause
  exit /b 1
)

echo.
echo === EmergencyPlus - domain setup ===
echo Before this step (see docs\DOMAIN-SETUP.md):
echo   1. The domain's DNS is managed by Cloudflare (DNS only - grey cloud).
echo   2. You created a Cloudflare API token: Zone - DNS - Edit, for this domain only.
echo   3. Tailscale is installed on this computer (for access from outside the clinic).
echo.
set "DOMAIN=eplus.life"
set /p "DOMAIN=Domain [eplus.life]: "
set "ACME_EMAIL="
set /p "ACME_EMAIL=Email for certificate notices: "
set "DNS_API_TOKEN="
set /p "DNS_API_TOKEN=Cloudflare API token: "
if "%ACME_EMAIL%"=="" goto missing
if "%DNS_API_TOKEN%"=="" goto missing

echo Making a backup first...
docker compose run --rm backup now
if errorlevel 1 (
  echo The backup failed, so nothing was changed. Run start.bat, then try again.
  pause
  exit /b 1
)

rem Keep a copy of the current settings, then (re)write only the domain lines in .env.
copy /y .env .env.before-domain >nul
powershell -NoProfile -Command "$keys='COMPOSE_PROFILES','DOMAIN','ACME_EMAIL','DNS_API_TOKEN','SECURE_COOKIES','TRUST_PROXY'; $lines = Get-Content .env | Where-Object { $k = ($_ -split '=',2)[0]; $keys -notcontains $k }; $lines += '# HTTPS on the clinic domain (domain-setup.bat). Keep this file private: it holds the DNS token.'; $lines += 'COMPOSE_PROFILES=domain'; $lines += ('DOMAIN=' + $env:DOMAIN); $lines += ('ACME_EMAIL=' + $env:ACME_EMAIL); $lines += ('DNS_API_TOKEN=' + $env:DNS_API_TOKEN); Set-Content -Encoding ascii -Path .env -Value $lines"

rem Allow HTTPS (443) into this computer only from the clinic network and from Tailscale devices.
net session >nul 2>&1
if errorlevel 1 (
  echo NOTE: not running as administrator - the Windows firewall rule was not added.
  echo       Right-click domain-setup.bat and choose "Run as administrator" to add it.
) else (
  netsh advfirewall firewall delete rule name="EmergencyPlus HTTPS" >nul 2>&1
  netsh advfirewall firewall add rule name="EmergencyPlus HTTPS" dir=in action=allow protocol=TCP localport=443 remoteip=LocalSubnet,100.64.0.0/10 >nul
  echo Firewall: port 443 allowed from the clinic network and Tailscale only.
)

echo Starting the HTTPS proxy... (the first time it is built, a few minutes)
docker compose up -d --build
if errorlevel 1 (
  echo Could not start. Your previous settings are in .env.before-domain.
  pause
  exit /b 1
)

echo Waiting for the certificate (up to 3 minutes)...
for /l %%i in (1,1,36) do (
  curl -s -o nul -f --resolve %DOMAIN%:443:127.0.0.1 https://%DOMAIN%/api/health && goto ok
  timeout /t 5 /nobreak >nul
)
echo.
echo The certificate is not ready yet. Last messages from the proxy:
docker compose logs --tail 30 caddy
echo Check the API token and the DNS records (docs\DOMAIN-SETUP.md), then run this again.
pause
exit /b 1

:ok
echo.
echo ============================================================
echo  HTTPS is working on this computer:  https://%DOMAIN%
echo  The clinic network address by IP keeps working as before.
echo  Next: the DNS "A" record and the devices - see docs\DOMAIN-SETUP.md
echo  Check everything any time with check-system.bat
echo ============================================================
pause
exit /b 0

:missing
echo Email and API token are required. Nothing was changed.
pause
exit /b 1
