@echo off
title AlphaEdge Dhan Data Bridge
color 0B
rem Chronos shadow inference uses the isolated environment below. The bridge
rem remains data-only and places no broker orders.
set "PY=D:\alphaedge\.chronos-venv\Scripts\python.exe"
if not exist "%PY%" (
  echo ERROR: AlphaEdge Python environment is missing: %PY%
  if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
  exit /b 1
)
echo Installing/updating the dhanhq package (first run only)...
"%PY%" -m pip install -r "%~dp0requirements-chronos.txt" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Bridge dependencies could not be installed.
  if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
  exit /b 1
)
echo Refreshing the Dhan access token via configured PIN and TOTP...
"%PY%" "%~dp0..\strategy-lab\dhan_token_refresh.py"
if errorlevel 1 (
  echo WARNING: Dhan token refresh failed. The bridge will start, but Dhan data may be unavailable.
)
echo Starting the bridge...
echo.
"%PY%" "%~dp0bridge.py"
set "BRIDGE_EXIT=%ERRORLEVEL%"
if /i not "%TRADING_LAB_HIDDEN%"=="1" pause
exit /b %BRIDGE_EXIT%
