@echo off
title AlphaEdge MT5 Bridge
color 0B
set "PY=D:\alphaedge\.venv\Scripts\python.exe"
echo Installing/updating the MetaTrader5 package (first run only)...
"%PY%" -m pip install MetaTrader5 >nul 2>&1
echo Starting the bridge...
echo.
"%PY%" "%~dp0bridge.py"
pause
