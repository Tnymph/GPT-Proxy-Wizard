# Create (idempotently) a helper scheduled task that starts a Windows service with
# highest privileges. Needs an elevated session to create the task.
# After that, a NON-elevated program can trigger it via: schtasks /run /tn <TaskName>
# Usage: ensure-service-task.ps1 -TaskName GPTProxy-StartClashService -ServiceName clash_verge_service
param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$ServiceName
)
$ErrorActionPreference = 'Stop'

if ($TaskName -notmatch '^[A-Za-z0-9_-]{3,64}$') { throw "任务名非法：$TaskName" }
if ($ServiceName -notmatch '^[A-Za-z0-9_.-]{3,64}$') { throw "服务名非法：$ServiceName" }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "task-exists"
    return
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "Start-Service -Name ' + $ServiceName + '"')
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "task-created"
