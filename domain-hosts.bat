@echo off
rem EmergencyPlus - run ONCE as administrator on a clinic PC that should open the domain inside the clinic
rem without Tailscale. It maps the domain to the clinic server's address on the local network.
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
set "DOMAIN=eplus.life"
set /p "DOMAIN=Domain [eplus.life]: "
set "SERVER_IP="
set /p "SERVER_IP=Clinic server IP on the local network (e.g. 192.168.1.93): "
if "%SERVER_IP%"=="" (
  echo No address given. Nothing was changed.
  pause
  exit /b 1
)
powershell -NoProfile -Command "$h = \"$env:windir\System32\drivers\etc\hosts\"; Copy-Item $h \"$h.eplus-backup\" -Force; $lines = Get-Content $h | Where-Object { $_ -notmatch ('\s' + [regex]::Escape($env:DOMAIN) + '\s*$') }; $lines += ($env:SERVER_IP + '  ' + $env:DOMAIN); Set-Content -Encoding ascii -Path $h -Value $lines"
ipconfig /flushdns >nul
echo Done: %DOMAIN% opens %SERVER_IP% on this PC. Test:  https://%DOMAIN%
pause
