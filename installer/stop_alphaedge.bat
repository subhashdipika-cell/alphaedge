@echo off
title AlphaEdge - Stopping
color 0C
echo.
echo  Stopping AlphaEdge...
taskkill /fi "WindowTitle eq AlphaEdge App*" /f >nul 2>&1
taskkill /fi "WindowTitle eq AlphaEdge MT5 Bridge*" /f >nul 2>&1
echo  Done. AlphaEdge has been stopped.
timeout /t 3 >nul
