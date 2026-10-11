# Stop a Windows service (needs an elevated session). Stopping Clash Verge's service
# also terminates its core process (verge-mihomo), which is what program B relies on.
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9_.-]{3,64}$') { throw "服务名非法：$Name" }
Stop-Service -Name $Name -Force
Start-Sleep -Seconds 2
$svc = Get-Service -Name $Name
Write-Output ([string]$svc.Status).ToUpper()
