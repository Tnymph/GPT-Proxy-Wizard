# 对指定进程名发送"关闭主窗口"（WM_CLOSE），等待若干秒后返回。
# 用法：close-gracefully.ps1 -Names "ChatGPT.exe,Codex.exe" -WaitSeconds 5
param(
    [Parameter(Mandatory = $true)][string]$Names,
    [int]$WaitSeconds = 5
)
$ErrorActionPreference = 'SilentlyContinue'

foreach ($n in $Names.Split(',')) {
    $name = $n.Trim()
    if (-not $name) { continue }
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
        try { [void]$_.CloseMainWindow() } catch { }
    }
}
Start-Sleep -Seconds $WaitSeconds
Write-Output 'graceful-close-sent'
