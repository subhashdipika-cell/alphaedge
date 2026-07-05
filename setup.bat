@echo off
title AlphaEdge Setup
color 0B
chcp 65001 >nul 2>&1

echo.
echo  ============================================================
echo   AlphaEdge AI Trading Platform v3.0 - Setup
echo  ============================================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is NOT installed.
    echo.
    echo  Please install Node.js from: https://nodejs.org
    echo  Recommended version: Node 18 or newer (LTS)
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% detected.

:: Check npm
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] npm not found. Please reinstall Node.js.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('npm --version') do set NPM_VER=%%v
echo  [OK] npm %NPM_VER% detected.
echo.

:: Install dependencies
echo  Installing dependencies...
echo  (This may take 1-2 minutes on first run)
echo.
call npm install

if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo   SUCCESS - Starting AlphaEdge...
echo  ============================================================
echo.
echo  The app will open at: http://localhost:3000
echo  Press Ctrl+C in this window to stop the server.
echo.

call npm run dev

pause
