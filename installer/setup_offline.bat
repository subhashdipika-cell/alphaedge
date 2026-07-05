@echo off
title AlphaEdge - First Time Setup (Offline)
color 0B
cls
setlocal
set "ROOT=%~dp0"
set "RT=%ROOT%runtime"
set "NODEZIP=%ROOT%runtime_src\node-embed.zip"
set "PKGDIR=%ROOT%node_modules_bundled"
set "NODE=%RT%\node.exe"

echo  ============================================================
echo   AlphaEdge AI Trading Platform - First Time Setup (Offline)
echo  ============================================================
echo.
echo  No internet needed. Everything is bundled.
echo.

:: ---------------------------------------------------------------
:: 1) Unpack the bundled Node.js runtime
:: ---------------------------------------------------------------
if exist "%NODE%" goto packages

if not exist "%NODEZIP%" (
    echo  [!] Bundled Node.js runtime not found at runtime_src\node-embed.zip
    echo      This installer may be incomplete. Please reinstall.
    pause & exit /b 1
)
echo  [1/2] Unpacking bundled Node.js runtime...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force '%NODEZIP%' '%RT%_tmp'"
:: Move inner versioned folder to runtime\
for /d %%D in ("%RT%_tmp\node-*") do (
    move "%%D" "%RT%" >nul
)
rd /s /q "%RT%_tmp" >nul 2>&1

if not exist "%NODE%" (
    echo  [!] Node.js extraction failed. Installer may be corrupt. Please reinstall.
    pause & exit /b 1
)

:: ---------------------------------------------------------------
:: 2) Copy the bundled node_modules into place
:: ---------------------------------------------------------------
:packages
if exist "%ROOT%node_modules\vite\package.json" goto done

if not exist "%PKGDIR%\vite\package.json" (
    echo  [!] Bundled node_modules not found. Installer may be incomplete.
    pause & exit /b 1
)
echo  [2/2] Installing bundled packages (offline)...
xcopy /e /i /q "%PKGDIR%" "%ROOT%node_modules\" >nul

if not exist "%ROOT%node_modules\vite\package.json" (
    echo  [!] Package extraction failed. Please reinstall.
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
