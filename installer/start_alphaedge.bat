@echo off
title AlphaEdge
color 0B
cls
echo.
echo  ============================================================
echo   AlphaEdge AI Trading Platform
echo  ============================================================
echo.

set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
set "NPM=%ROOT%runtime\npm.cmd"

:: --- First-run safety net ---
if not exist "%NODE%" (
    echo  First-time setup required. Launching setup...
    if exist "%ROOT%setup_offline.bat" (
        call "%ROOT%setup_offline.bat"
    ) else (
        call "%ROOT%setup_online.bat"
    )
)
if not exist "%NODE%" (
    echo  [!] Setup did not complete. Run "First Time Setup" from Start Menu.
    pause
    exit /b 1
)

set "PATH=%ROOT%runtime;%ROOT%runtime\node_modules\.bin;%PATH%"

:: --- Kill any previous AlphaEdge Vite server ---
taskkill /fi "WindowTitle eq AlphaEdge App*" /f >nul 2>&1
timeout /t 1 /nobreak >nul

:: --- Start the Vite dev server in a minimized window ---
echo  Starting AlphaEdge app server...
start "AlphaEdge App" /min cmd /k "cd /d "%ROOT%" && "%NPM%" run dev"

:: --- Start the MT5 bridge if it exists ---
if exist "%ROOT%mt5-bridge\run.bat" (
    echo  Starting MT5 bridge...
    start "AlphaEdge MT5 Bridge" /min cmd /k "cd /d "%ROOT%mt5-bridge" && run.bat"
)

:: --- Wait for Vite to be ready then open browser ---
timeout /t 5 /nobreak >nul
start http://localhost:3000

echo.
echo  AlphaEdge is running at http://localhost:3000
echo  Both windows must stay open. Use "Stop AlphaEdge" to shut down.
echo.
timeout /t 6 >nul
