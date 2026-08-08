@echo off
:: Run this file as Administrator (right-click -> Run as administrator)
:: Re-run this any time to UPDATE the task (it overwrites with /f).
echo Registering AlphaEdge Strategy Lab daily task...

:: --collect-hours 9 = 06:30 -> 15:30 IST, covering the full options session.
:: Use the FULL python path — Task Scheduler has a minimal PATH and cannot find
:: bare "python" (that caused error 0x80070002 / file-not-found).
:: Point at the 3.12 VENV python: Smart App Control blocks the base 3.14 native
:: wheels (pandas/MT5), so the venv (signed/reputable cp312 wheels) is required.
schtasks /create /tn "AlphaEdge-StrategyLab" ^
  /tr "D:\alphaedge\.venv\Scripts\python.exe D:\alphaedge\strategy-lab\run_daily.py --collect-hours 9 --max-dd 20 --zerohero-index-days 5" ^
  /sc daily /st 06:30 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

:: Kill a stuck run after 11h so it can't block the next morning's 6:30 start,
:: and allow it to start late if the PC was asleep at 6:30.
:: Power conditions matter: the 2026-07-08 run died at 06:40 because the default
:: task settings STOP the task when the laptop switches to battery. AllowStart +
:: DontStop keep it running on battery; run_daily.py also holds the machine awake.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 11) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Set-ScheduledTask -TaskName 'AlphaEdge-StrategyLab' -Settings $s | Out-Null"

if %errorlevel%==0 (
    echo.
    echo Task registered successfully.
    echo It will run every day at 6:30 AM.
    echo.
    echo To run immediately:  schtasks /run /tn "AlphaEdge-StrategyLab"
    echo To remove:           schtasks /delete /tn "AlphaEdge-StrategyLab" /f
) else (
    echo ERROR: Failed to register task. Make sure you ran as Administrator.
)
pause
