@echo off
rem Double-click to make demo Marg-style Excel files in the demo-files folder.
cd /d "%~dp0"
node scripts\make-demo-files.js
start "" demo-files
pause
