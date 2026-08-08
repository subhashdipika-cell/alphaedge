@echo off
setlocal
pushd "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo AlphaEdge Python environment not found: .venv\Scripts\python.exe
  exit /b 1
)
echo Backfilling one year of NIFTY/BANKNIFTY index candles from Dhan...
".venv\Scripts\python.exe" "strategy-lab\collect_zerohero_history.py" --days 365 --intervals 1,5 --expired-options
if errorlevel 1 exit /b %errorlevel%
echo.
echo Index backfill complete. Option-chain history is collected forward-only.
echo To run the live option collector through the market session:
echo   ".venv\Scripts\python.exe" "strategy-lab\collect_zerohero_history.py" --no-index --live-options
popd
