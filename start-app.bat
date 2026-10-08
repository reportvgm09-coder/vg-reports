@echo off
rem Double-click to start VG Reports on this computer.
rem First run: installs what it needs and asks you to set a login.
cd /d "%~dp0"
title VG Reports

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. The download page will open now.
  echo   Install the LTS version, then double-click start-app again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node scripts\check-node.js
if errorlevel 1 ( pause & exit /b 1 )

node scripts\needs-install.js
if errorlevel 1 (
  echo.
  echo   Installing the parts VG Reports needs. First time takes a minute or two...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   Install failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist .env node scripts\setup-local.js

rem Open the browser a few seconds after the app starts.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"
node src\server.js
echo.
echo   VG Reports has stopped.
pause
