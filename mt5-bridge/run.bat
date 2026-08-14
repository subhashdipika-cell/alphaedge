@echo off
title AlphaEdge Dhan Data Bridge
color 0B
rem Chronos shadow inference uses the isolated environment below. The bridge
rem remains data-only and places no broker orders.
set "PY=D:\alphaedge\.chronos-venv\Scripts\python.exe"
echo Installing/updating the dhanhq package (first run only)...
"%PY%" -m pip install dhanhq >nul 2>&1
echo Starting the bridge...
echo.
"%PY%" "%~dp0bridge.py"
pause
