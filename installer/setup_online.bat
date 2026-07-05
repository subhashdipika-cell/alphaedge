@echo off
title AlphaEdge - First Time Setup (Online)
color 0B
cls
setlocal
set "ROOT=%~dp0"
set "RT=%ROOT%runtime"
set "NODEVER=20.19.2"
set "NODEZIP=node-v%NODEVER%-win-x64.zip"
set "NODEURL=https://nodejs.org/dist/v%NODEVER%/%NODEZIP%"
set "NODE=%RT%\node.exe"

echo  ============================================================
echo   AlphaEdge AI Trading Platform - First Time Setup (Online)
echo  ============================================================
echo.
echo  This needs an internet connection. It runs only once.
echo.

:: ---------------------------------------------------------------
:: 1) Download + unpack the Node.js runtime
:: ---------------------------------------------------------------
if exist "%NODE%" goto packages

echo  [1/2] Downloading Node.js v%NODEVER% runtime (~32 MB)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%NODEURL%' -OutFile '%TEMP%\ae_node.zip'"
if not exist "%TEMP%\ae_node.zip" (
    echo  [!] Download failed. Check your internet connection and run setup again.
    pause & exit /b 1
)
echo  Unpacking Node.js...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force '%TEMP%\ae_node.zip' '%RT%_tmp'"
:: Move the inner versioned folder up
for /d %%D in ("%RT%_tmp\node-v%NODEVER%-win-x64") do (
    move "%%D" "%RT%" >nul
)
rd /s /q "%RT%_tmp" >nul 2>&1
del "%TEMP%\ae_node.zip" >nul 2>&1

if not exist "%NODE%" (
    echo  [!] Node.js extraction failed. Please reinstall.
    pause & exit /b 1
)

:: ---------------------------------------------------------------
:: 2) Install app packages from npm (online)
:: ---------------------------------------------------------------
:packages
if exist "%ROOT%node_modules\vite\package.json" goto done

echo  [2/2] Installing packages from npm (2-3 minutes)...
set "PATH=%RT%;%RT%\node_modules\.bin;%PATH%"
cd /d "%ROOT%"
"%RT%\npm.cmd" install --prefer-offline
if not exist "%ROOT%node_modules\vite\package.json" (
    echo  [!] npm install failed. Check your connection and run setup again.
    pause & exit /b 1
)

:done
echo.
echo  ============================================================
echo   SETUP COMPLETE!
echo  ============================================================
echo  Use "Start AlphaEdge" to launch the platform.
echo.
timeout /t 5 >nul
endlocal
