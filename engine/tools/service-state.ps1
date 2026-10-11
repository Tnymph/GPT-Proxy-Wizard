# Print the status of a Windows service: RUNNING / STOPPED / NOTFOUND
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'SilentlyContinue'
$svc = Get-Service -Name $Name
if (-not $svc) { Write-Output 'NOTFOUND' } else { Write-Output ([string]$svc.Status).ToUpper() }
