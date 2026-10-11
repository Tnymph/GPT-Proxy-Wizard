# 一次性采集本机运行态信息（进程/窗口标题/监听端口/网卡/系统代理/命名管道），以 UTF-8 JSON 写入文件。
# 由 Node 调用：powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1 -OutFile <path>
param([Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'

$diag = [ordered]@{ cimCounts = @(); cimError = ''; wmiCount = -1; wmiError = ''; psCount = -1 }

# 1) 有主窗口的进程标题（非 WMI，稳定）
$mainWindows = @{}
$psProcs = @(Get-Process)
$diag.psCount = $psProcs.Count
foreach ($p in $psProcs) {
    if ($p.MainWindowHandle -ne 0) { $mainWindows[[int]$p.Id] = $p.MainWindowTitle }
}

# 2) 进程 + 命令行：WMI 偶发瞬时失败（返回空），重试 3 次并回退旧 API
$raw = @()
for ($i = 0; $i -lt 3; $i++) {
    $one = @(Get-CimInstance Win32_Process)
    $diag.cimCounts += $one.Count
    if ($one.Count -gt 0) { $raw = $one; break }
    if (-not $diag.cimError) { $diag.cimError = "$($Error[0].Exception.Message)" }
    Start-Sleep -Milliseconds 500
}
if ($raw.Count -eq 0) {
    $legacy = @(Get-WmiObject Win32_Process)
    $diag.wmiCount = $legacy.Count
    if ($legacy.Count -eq 0) { $diag.wmiError = "$($Error[0].Exception.Message)" }
    $raw = $legacy
}

$procs = @()
foreach ($item in $raw) {
    $procs += [pscustomobject]@{
        Id    = [int]$item.ProcessId
        Pid2  = [int]$item.ParentProcessId
        Name  = $item.Name
        Path  = $item.ExecutablePath
        Cmd   = $item.CommandLine
        Title = $mainWindows[[int]$item.ProcessId]
    }
}

$listeners = @(Get-NetTCPConnection -State Listen | ForEach-Object {
    [pscustomobject]@{ Addr = $_.LocalAddress; Port = [int]$_.LocalPort; Pid = [int]$_.OwningProcess }
})

$adapters = @(Get-NetAdapter | ForEach-Object {
    [pscustomobject]@{ Name = $_.Name; Desc = $_.InterfaceDescription; Status = [string]$_.Status }
})

$sysproxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
    Select-Object ProxyEnable, ProxyServer, ProxyOverride

$pipes = @()
try { $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\')) } catch { }

$obj = [pscustomobject]@{
    processes = $procs
    listeners = $listeners
    adapters  = $adapters
    sysproxy  = $sysproxy
    pipes     = $pipes
    diag      = $diag
}

$json = $obj | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
