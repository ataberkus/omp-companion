@echo off
rem Starts the OMP companion and opens the control room in your browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org and try again. & pause & exit /b 1)
if defined OMP_BIN echo Using OMP: %OMP_BIN%
if not defined OMP_BIN where omp >nul 2>nul || echo Warning: omp was not found on PATH. Sessions will not start until OMP is installed.
rem Reachable from your network (and your tailnet, if Tailscale runs) with a login. Set OMP_WEB_PASSWORD to choose the password;
rem without it the console prints a random connection token per launch. Set OMP_WEB_HOST=127.0.0.1 to keep it on this PC only,
rem or to this PC's Tailscale address (100.x.y.z) to accept only tailnet devices (see "Away from home with Tailscale" in README.md).
if not defined OMP_WEB_HOST set OMP_WEB_HOST=0.0.0.0
if not "%OMP_WEB_NO_TOKEN%"=="1" if not defined OMP_WEB_PASSWORD echo OMP_WEB_PASSWORD is not set: other devices need the connection token printed below.
title OMP companion
node companion\server.mjs %*
echo.
echo The companion stopped.
pause
