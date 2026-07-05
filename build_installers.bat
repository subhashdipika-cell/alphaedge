@echo off
:: ============================================================
::  AlphaEdge AI Trading Platform - one-click installer builder
::  Run this on a WINDOWS PC from the project root.
::  Produces both setup .exe files in installer_output\
::
::  Build-machine prerequisites (NOT needed on the user's PC):
::    - NSIS          https://nsis.sourceforge.io
::    - Node.js 18+   https://nodejs.org  (to run npm install + build)
::    - Internet      (to download Node.js runtime for the offline bundle)
:: ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
color 0B

set "NODEVER=20.19.2"
set "NODEZIP=node-v%NODEVER%-win-x64.zip"
set "NODEURL=https://nodejs.org/dist/v%NODEVER%/%NODEZIP%"
set "ASSETS=build_assets"

echo  ============================================================
echo   AlphaEdge - Installer Builder
echo  ============================================================
echo.

:: --- 0) Find NSIS (makensis) --------------------------------
set "MAKENSIS="
where makensis >nul 2>&1 && set "MAKENSIS=makensis"
if not defined MAKENSIS if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%LOCALAPPDATA%\Programs\NSIS\makensis.exe" set "MAKENSIS=%LOCALAPPDATA%\Programs\NSIS\makensis.exe"
if defined MAKENSIS goto nsis_ok
echo  [!] NSIS not found. Install it from https://nsis.sourceforge.io
pause
exit /b 1
:nsis_ok
echo  Using NSIS: %MAKENSIS%
if not exist installer_output mkdir installer_output

:: --- 1) Install dev dependencies (needed for the Vite build) ---
echo.
echo  [1/5] Installing dev dependencies...
where npm >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js/npm not found. Install from https://nodejs.org (LTS).
    pause & exit /b 1
)
call npm install
if errorlevel 1 ( echo  [!] npm install failed. & pause & exit /b 1 )

:: --- 2) Build the ONLINE installer (small) ------------------
echo.
echo  [2/5] Building ONLINE (small) installer...
pushd installer
"%MAKENSIS%" ae_online.nsi
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo  [!] Online build failed. & pause & exit /b 1 )

:: --- 3) Download the bundled Node.js runtime ----------------
echo.
echo  [3/5] Preparing offline Node.js runtime...
if not exist "%ASSETS%" mkdir "%ASSETS%"
if not exist "%ASSETS%\%NODEZIP%" (
    echo  Downloading Node.js v%NODEVER% portable zip (~32 MB)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%NODEURL%' -OutFile '%ASSETS%\%NODEZIP%'"
)
if not exist "%ASSETS%\%NODEZIP%" (
    echo  [!] Could not download Node.js runtime. Check your internet connection.
    pause & exit /b 1
)
:: Rename for the offline installer script
copy /y "%ASSETS%\%NODEZIP%" "%ASSETS%\node-win-x64.zip" >nul

:: --- 4) Snapshot node_modules for the offline bundle --------
echo.
echo  [4/5] Snapshotting node_modules for offline bundle...
if exist "%ASSETS%\node_modules_snapshot" rd /s /q "%ASSETS%\node_modules_snapshot"
xcopy /e /i /q node_modules "%ASSETS%\node_modules_snapshot\" >nul
if not exist "%ASSETS%\node_modules_snapshot\vite\package.json" (
    echo  [!] node_modules snapshot failed or node_modules is missing.
    echo      Run "npm install" first, then re-run this script.
    pause & exit /b 1
)

:: --- 5) Build the OFFLINE self-contained installer ----------
echo.
echo  [5/5] Building OFFLINE (self-contained) installer...
pushd installer
"%MAKENSIS%" ae_offline.nsi
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo  [!] Offline build failed. & pause & exit /b 1 )

echo.
echo  ============================================================
echo   DONE!  Files are in installer_output\
echo     - AlphaEdge_Setup_Online.exe            (~5 MB)
echo     - AlphaEdge_Setup_Offline_SelfContained.exe  (~80 MB)
echo  ============================================================
echo.
pause
endlocal
