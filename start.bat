@echo off
rem Starts the OMP companion and opens the control room in your browser.
rem Variables set here (OMP_WEB_HOST, OMP_WEB_RESTART_EXIT) stay in this script, not in the console that ran it.
setlocal
cd /d "%~dp0"
rem Sessions run OMP's SDK (the npm package @oh-my-pi/pi-coding-agent) inside the companion, on Bun.
rem Started from Explorer, PATH can miss the user's entries (Windows drops an oversized user Path): try the default install folders.
where bun >nul 2>nul || if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%PATH%;%USERPROFILE%\.bun\bin"
where omp >nul 2>nul || if exist "%LOCALAPPDATA%\omp\omp.exe" set "PATH=%PATH%;%LOCALAPPDATA%\omp"
where bun >nul 2>nul || (echo Bun was not found. Install it from https://bun.sh and try again. & pause & exit /b 1)
if not exist node_modules\@oh-my-pi\pi-coding-agent\package.json (
  where npm >nul 2>nul || (echo OMP's SDK is not installed and npm was not found. Install Node.js from https://nodejs.org, then run npm ci here. & pause & exit /b 1)
  echo Installing OMP's SDK ^(npm ci^)...
  call npm ci || (echo npm ci failed. & pause & exit /b 1)
)
if defined OMP_BIN echo Using OMP: %OMP_BIN%
if not defined OMP_BIN where omp >nul 2>nul || echo Warning: omp was not found on PATH. Updates, usage and the Tools page need the OMP CLI.
rem Reachable from your network (and your tailnet, if Tailscale runs) with a login. Set OMP_WEB_PASSWORD to choose the password;
rem without it the console prints a random connection token per launch. Set OMP_WEB_HOST=127.0.0.1 to keep it on this PC only,
rem or to this PC's Tailscale address (100.x.y.z) to accept only tailnet devices (see "Away from home with Tailscale" in README.md).
if not defined OMP_WEB_HOST set OMP_WEB_HOST=0.0.0.0
if not "%OMP_WEB_NO_TOKEN%"=="1" if not defined OMP_WEB_PASSWORD echo OMP_WEB_PASSWORD is not set: other devices need the connection token printed below.
title OMP companion
rem Restart companion (dashboard menu) stops the companion with exit code 75; the loop starts it again on the same port.
set OMP_WEB_RESTART_EXIT=75
:run
bun companion\server.mjs %*
if "%ERRORLEVEL%"=="75" (echo. & echo Restarting the companion... & goto run)
echo.
echo The companion stopped.
pause
