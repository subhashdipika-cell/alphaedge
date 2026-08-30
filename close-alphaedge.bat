@echo off
setlocal EnableExtensions
title Close AlphaEdge

powershell.exe -NoLogo -NoProfile -Command ^
  "$targets=New-Object 'System.Collections.Generic.HashSet[int]';" ^
  "$rules=@(@{Port=5000;Pattern='alphaedge.+bridge[.]py'},@{Port=5001;Pattern='alphaedge.+vite'});" ^
  "foreach($rule in $rules){$listener=Get-NetTCPConnection -LocalPort $rule.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $listener){continue}; $process=Get-CimInstance Win32_Process -Filter \"ProcessId=$($listener.OwningProcess)\" -ErrorAction SilentlyContinue; if($process.CommandLine -match $rule.Pattern){[void]$targets.Add([int]$process.ProcessId)}else{Write-Warning \"Port $($rule.Port) belongs to another application; it was not stopped.\"}};" ^
  "$workers=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -match 'D:[\\/]alphaedge' -and $_.CommandLine -match 'dhan_options_collector[.]py|scripts[\\/]scanner[.]mjs'};" ^
  "foreach($worker in $workers){[void]$targets.Add([int]$worker.ProcessId)};" ^
  "if($targets.Count -eq 0){Write-Host 'AlphaEdge is not running.'; exit 0};" ^
  "foreach($processId in $targets){Write-Host \"Stopping AlphaEdge PID $processId...\"; & taskkill.exe /PID $processId /T /F | Out-Null; if($LASTEXITCODE -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)){exit $LASTEXITCODE}}; exit 0"

set "CLOSE_EXIT=%ERRORLEVEL%"
if not "%CLOSE_EXIT%"=="0" echo [ERROR] AlphaEdge could not be stopped cleanly.
if /i not "%TRADING_LAB_HIDDEN%"=="1" timeout /t 2 /nobreak >nul
endlocal & exit /b %CLOSE_EXIT%
