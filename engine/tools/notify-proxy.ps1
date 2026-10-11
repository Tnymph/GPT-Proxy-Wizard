# 通知 Windows（WinINET）系统代理设置已变更，使已运行程序立即重新读取。
$sig = '[DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
$t = Add-Type -MemberDefinition $sig -Name WininetApi -Namespace GptProxy -PassThru
# 39 = INTERNET_OPTION_SETTINGS_CHANGED, 37 = INTERNET_OPTION_REFRESH
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
Write-Output 'notified'
