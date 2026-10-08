@echo off
rem Double-click to change the login name or password.
cd /d "%~dp0"
node scripts\setup-local.js
echo   Close VG Reports if it is open, then start it again.
pause
