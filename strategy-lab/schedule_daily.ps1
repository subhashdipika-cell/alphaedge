# schedule_daily.ps1
# Registers a Windows Scheduled Task that runs the Strategy Lab pipeline daily at 6:30 AM.
# Run this script ONCE as Administrator to install the task.

$TaskName   = "AlphaEdge-StrategyLab"
$ScriptPath = "D:\alphaedge\strategy-lab\run_daily.py"
$PythonExe  = (Get-Command python).Source

$Action  = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument "$ScriptPath --collect-hours 8 --max-dd 500" `
    -WorkingDirectory "D:\alphaedge\strategy-lab"

# Run daily at 6:30 AM
$Trigger = New-ScheduledTaskTrigger -Daily -At "06:30AM"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   $Trigger `
    -Settings  $Settings `
    -RunLevel  Highest `
    -Force

Write-Host "Task '$TaskName' registered. It will run daily at 6:30 AM."
Write-Host "To run immediately: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "To remove:          Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
