@echo off
title AlphaEdge Launcher
color 0B
cd /d "%~dp0"

echo  ============================================================
echo    Starting AlphaEdge  -  Indian index-options (PAPER ONLY)
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

REM --- Window 1: the Dhan data bridge (port 5000) ---
echo  [1/4] Launching the Dhan data bridge...
start "AlphaEdge Dhan Bridge" cmd /k "pushd ""%~dp0mt5-bridge"" && run.bat"

REM --- Give the bridge a few seconds to bind :5000 before the collector and
REM     scanner start hitting it. ---
timeout /t 6 >nul

REM --- Window 2: the option-chain collector (feeds OI + premium history).
REM     Self-gates on the NSE session, so it idles quietly off-hours. ---
echo  [2/4] Launching the option-chain collector...
start "AlphaEdge Collector" cmd /k "pushd ""%~dp0"" && .chronos-venv\Scripts\python.exe strategy-lab\dhan_options_collector.py"

REM --- Window 3: the HEADLESS autonomous paper-trade scanner.
REM     This is what takes paper trades on its own - it scores all four indices
REM     every ~5 min in-session and logs every TRADE-grade setup. Runs without
REM     the browser; writes strategy-lab\paper\auto_paper_trades.json. ---
echo  [3/4] Launching the autonomous paper-trade scanner...
start "AlphaEdge Scanner" cmd /k "pushd ""%~dp0"" && node scripts\scanner.mjs --zerohero-v2 --zerohero-divergence"

REM --- Window 4: the app UI (port 5001, opens your browser automatically) ---
echo  [4/4] Launching the AlphaEdge app...
start "AlphaEdge App" cmd /k "pushd ""%~dp0"" && npm run dev -- --port 5001"

echo.
echo  ============================================================
echo   AlphaEdge is starting in FOUR windows:
echo     1^) Dhan Bridge   - Dhan market data on http://127.0.0.1:5000
echo     2^) Collector     - snapshots the option chain (OI + premium history)
echo     3^) Scanner       - AUTONOMOUS paper trader (no broker orders)
echo     4^) App           - the UI on http://localhost:5001 (browser opens)
echo.
echo   The Scanner takes paper trades on its own during market hours
echo   (09:20-15:00 IST entries, 15:12 square-off). It keeps running even
echo   if you close the browser - watch its window, or the app's
echo   Paper Trades page -^> "Autonomous Scanner" section.
echo.
echo   PAPER ONLY - AlphaEdge places NO real broker orders.
echo   Keep these windows open while trading - closing them stops it.
echo   Dhan token refresh runs automatically before the bridge starts.
echo  ============================================================
echo   This launcher window will close on its own.
timeout /t 10 >nul
