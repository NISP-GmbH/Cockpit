@echo off
title Cockpit  (auto-restart - close THIS window to stop)
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Open a terminal here and run:  npm install
  pause
  exit /b 1
)
:loop
"node_modules\electron\dist\electron.exe" .
echo.
echo App closed - restarting in 2 seconds.  Close THIS window to stop.
timeout /t 2 >nul
goto loop
