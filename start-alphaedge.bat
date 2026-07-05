@echo off
title AlphaEdge Launcher
color 0B
cd /d "%~dp0"

echo  ============================================================
echo    Starting AlphaEdge...
echo  ============================================================
echo.

REM --- Free AlphaEdge's own ports (5000 bridge, 5001 app) so an orphaned
REM     process from a previous run can't cause a "port in use" conflict. ---
echo  Clearing any stale processes on ports 5000 and 5001...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5000,5001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

REM --- Check Node.js is installed ---
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed.
    echo  Install it from https://nodejs.org  ^(LTS version^), then run this again.
    echo.
    pause
    exit /b 1
)

REM --- Install app dependencies on the first run ---
if not exist "node_modules" (
    echo  First run: installing dependencies ^(this takes 1-2 minutes^)...
    call npm install
    echo.
)

REM --- Window 1: the AlphaEdge app (opens your browser automatically) ---
echo  Launching the AlphaEdge app...
start "AlphaEdge App" cmd /k "pushd ""%~dp0"" && npm run dev"

REM --- Window 2: the MT5 bridge ---
echo  Launching the MT5 bridge...
start "AlphaEdge MT5 Bridge" cmd /k "pushd ""%~dp0mt5-bridge"" && run.bat"

echo.
echo  ============================================================
echo   AlphaEdge is starting in TWO windows:
echo     1^) AlphaEdge App   - the platform (your browser will open)
echo     2^) MT5 Bridge      - sends signals to MetaTrader 5
echo.
echo   Make sure MetaTrader 5 is OPEN and logged in first.
echo   Keep both windows open while trading - closing them stops it.
echo  ============================================================
echo   This launcher window will close on its own.
timeout /t 8 >nul
