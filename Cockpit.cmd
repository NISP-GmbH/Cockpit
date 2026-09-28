@echo off
setlocal EnableDelayedExpansion
title Cockpit  (auto-restart - close THIS window to stop)
cd /d "%~dp0"
rem   Cockpit.cmd            start - or, if Cockpit is already running, offer to restart it
rem   Cockpit.cmd --restart  restart a running Cockpit without asking (e.g. after git pull)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Open a terminal here and run:  npm install
  pause
  exit /b 1
)
set "EXE=node_modules\electron\dist\electron.exe"
rem Exit codes from main.js (see "single instance" there):
rem   3 another Cockpit is running, 4 this one was restarted from elsewhere,
rem   5 asked for a restart but nothing was running
set RESTART=0
if /i "%~1"=="--restart" set RESTART=1
set WAITING=0
set QUICK=0

:loop
call :now STARTED
"%EXE%" .
set RC=!errorlevel!
if "!RC!"=="3" (
  if !WAITING! gtr 0 (
    set /a WAITING-=1
    timeout /t 1 >nul
    goto loop
  )
  echo.
  echo Cockpit is already running - its window has been brought to the front.
  if "!RESTART!"=="1" goto restart
  choice /c YN /n /t 30 /d N /m "Restart it now, so it runs the current code? [Y/N] "
  if !errorlevel!==1 goto restart
  echo Not starting a second copy.
  timeout /t 3 >nul
  exit /b 0
)
set WAITING=0
if "!RC!"=="4" (
  echo.
  echo Cockpit was restarted from another window - this launcher stops here.
  timeout /t 3 >nul
  exit /b 0
)
rem A Cockpit that dies right after starting would otherwise be restarted for ever.
call :now ENDED
set /a RAN=ENDED-STARTED
if !RAN! lss 5 (set /a QUICK+=1) else (set QUICK=0)
if !QUICK! geq 3 (
  echo.
  echo Cockpit closed right after starting, 3 times in a row - not restarting again.
  echo Open a terminal here and run  npm start  to see what goes wrong.
  pause
  exit /b 1
)
echo.
echo App closed - restarting in 2 seconds.  Close THIS window to stop.
timeout /t 2 >nul
goto loop

:restart
set RESTART=0
echo Asking it to quit - any held mail is sent first ...
"%EXE%" . --restart-running >nul 2>&1
if not "!errorlevel!"=="5" set WAITING=30
goto loop

:now
for /f %%t in ('powershell -NoProfile -Command "[DateTimeOffset]::Now.ToUnixTimeSeconds()"') do set "%1=%%t"
exit /b 0
