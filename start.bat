@echo off
rem Starts the OMP companion and opens the control room in your browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org and try again. & pause & exit /b 1)
if not defined OMP_BIN where omp >nul 2>nul || echo Warning: omp was not found on PATH. Sessions will not start until OMP is installed.
title OMP companion
node companion\server.mjs %*
echo.
echo The companion stopped.
pause
