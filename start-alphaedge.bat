@echo off
title AlphaEdge Launcher
color 0B
cd /d "%~dp0"
set "LOGDIR=%~dp0work\launcher-logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo  ============================================================
echo    Starting AlphaEdge  -  Indian index-options (PAPER ONLY)
echo  ============================================================
echo.

REM --- Reuse healthy AlphaEdge services instead of killing them. A listener
REM     that is not AlphaEdge is reported and left untouched. ---
set "BRIDGE_READY=0"
set "APP_READY=0"
set "PORT_CONFLICT=0"

powershell -NoProfile -Command "$l=Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue; if(-not $l){exit 2}; try{$r=Invoke-RestMethod -Uri 'http://127.0.0.1:5000/' -TimeoutSec 3; if($r.ok -eq $true -and $r.service -like 'AlphaEdge*'){exit 0}}catch{}; exit 1" >nul 2>&1
if not errorlevel 1 set "BRIDGE_READY=1"
if errorlevel 1 if not errorlevel 2 (
    echo  [ERROR] Port 5000 is occupied by a service that is not the AlphaEdge bridge.
    set "PORT_CONFLICT=1"
)

powershell -NoProfile -Command "$l=Get-NetTCPConnection -LocalPort 5001 -State Listen -ErrorAction SilentlyContinue; if(-not $l){exit 2}; try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5001/' -TimeoutSec 3; if($r.StatusCode -eq 200 -and $r.Content -match '<title>AlphaEdge'){exit 0}}catch{}; exit 1" >nul 2>&1
if not errorlevel 1 set "APP_READY=1"
if errorlevel 1 if not errorlevel 2 (
    echo  [ERROR] Port 5001 is occupied by a service that is not the AlphaEdge app.
    set "PORT_CONFLICT=1"
)

if "%PORT_CONFLICT%"=="1" (
    echo  AlphaEdge did not stop or replace the process using that port.
    echo  Close the conflicting application or change its port, then try again.
    echo.
    if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
    exit /b 1
)

if "%BRIDGE_READY%"=="1" echo  [READY] Reusing the AlphaEdge bridge on port 5000.
if "%APP_READY%"=="1" echo  [READY] Reusing the AlphaEdge app on port 5001.

REM --- Check Node.js is installed ---
node.exe --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed.
    echo  Install it from https://nodejs.org  ^(LTS version^), then run this again.
    echo.
    if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
    exit /b 1
)

REM --- Install app dependencies on the first run ---
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] npm.cmd is not available in PATH.
    if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
    exit /b 1
)

if not exist ".chronos-venv\Scripts\python.exe" (
    echo  [ERROR] AlphaEdge Python environment is missing: .chronos-venv
    if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
    exit /b 1
)

if not exist "node_modules" (
    echo  First run: installing dependencies ^(this takes 1-2 minutes^)...
    call npm.cmd install
    if errorlevel 1 (
        echo  [ERROR] Dependency installation failed.
        if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
        exit /b 1
    )
    echo.
)

REM --- Window 1: the Dhan data bridge (port 5000) ---
if "%BRIDGE_READY%"=="1" (
    echo  [1/4] Dhan data bridge is already running.
) else (
    echo  [1/4] Launching the Dhan data bridge...
    if /i "%TRADING_LAB_HIDDEN%"=="1" (
        start "" /b cmd.exe /d /c "cd /d ""%~dp0mt5-bridge"" && call run.bat 1^>^>""%LOGDIR%\bridge.log"" 2^>^&1"
    ) else (
        start "AlphaEdge Dhan Bridge" cmd.exe /k "cd /d ""%~dp0mt5-bridge"" && call run.bat"
    )
)

REM --- Wait for the bridge health endpoint before starting dependants. Token
REM     refresh and dependency setup can take longer than a fixed sleep. ---
if "%BRIDGE_READY%"=="0" (
    powershell.exe -NoLogo -NoProfile -Command "$deadline=(Get-Date).AddSeconds(90); do { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5000/market/holiday' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0} } catch {}; Start-Sleep -Milliseconds 500 } while((Get-Date)-lt $deadline); exit 1"
    if errorlevel 1 echo  [WARN] Dhan bridge did not become ready within 90 seconds; dependants will retry.
)

REM --- Window 2: the option-chain collector (feeds OI + premium history).
REM     Self-gates on the NSE session, so it idles quietly off-hours. ---
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'dhan_options_collector[.]py' }; if($p){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo  [2/4] Option-chain collector is already running.
) else (
    echo  [2/4] Launching the option-chain collector...
    if /i "%TRADING_LAB_HIDDEN%"=="1" (
        powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath '%~dp0.chronos-venv\Scripts\python.exe' -ArgumentList 'strategy-lab\dhan_options_collector.py' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\collector.log' -RedirectStandardError '%LOGDIR%\collector.err.log'"
    ) else (
        start "AlphaEdge Collector" cmd.exe /k "cd /d ""%~dp0"" && .chronos-venv\Scripts\python.exe strategy-lab\dhan_options_collector.py"
    )
)

REM --- Window 3: the HEADLESS autonomous paper-trade scanner.
REM     This is what takes paper trades on its own - it scores all four indices
REM     every ~5 min in-session and logs every TRADE-grade setup. Runs without
REM     the browser; writes strategy-lab\paper\auto_paper_trades.json. ---
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'scripts[\\/]scanner[.]mjs' }; if($p){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo  [3/4] Autonomous paper-trade scanner is already running.
) else (
    echo  [3/4] Launching the autonomous paper-trade scanner...
    if /i "%TRADING_LAB_HIDDEN%"=="1" (
        powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'scripts\scanner.mjs','--zerohero-v2','--zerohero-divergence' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\scanner.log' -RedirectStandardError '%LOGDIR%\scanner.err.log'"
    ) else (
        start "AlphaEdge Scanner" cmd.exe /k "cd /d ""%~dp0"" && node.exe scripts\scanner.mjs --zerohero-v2 --zerohero-divergence"
    )
)

REM --- Window 4: the app UI (port 5001, opens your browser automatically) ---
if "%APP_READY%"=="1" (
    echo  [4/4] AlphaEdge app is already running; opening it in the browser...
    start "" "http://localhost:5001"
) else (
    echo  [4/4] Launching the AlphaEdge app...
    if /i "%TRADING_LAB_HIDDEN%"=="1" (
        powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev','--','--port','5001' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\app.log' -RedirectStandardError '%LOGDIR%\app.err.log'"
    ) else (
        start "AlphaEdge App" cmd.exe /k "cd /d ""%~dp0"" && npm.cmd run dev -- --port 5001"
    )
    powershell.exe -NoLogo -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); do { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5001/' -TimeoutSec 2; if($r.StatusCode -eq 200){Start-Process 'http://127.0.0.1:5001/'; exit 0} } catch {}; Start-Sleep -Milliseconds 500 } while((Get-Date)-lt $deadline); exit 1"
    if errorlevel 1 (
        echo  [ERROR] AlphaEdge app did not become ready within 60 seconds.
        exit /b 1
    )
)

echo.
echo  ============================================================
echo   AlphaEdge is ready. Existing healthy components were reused;
echo   only missing components were started:
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
