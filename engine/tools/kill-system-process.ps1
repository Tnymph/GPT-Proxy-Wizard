# Kill processes owned by other accounts (e.g. SYSTEM) from an elevated session.
# Enables SeDebugPrivilege in this process token first: a plain elevated taskkill may
# still be denied for SYSTEM-owned processes because the privilege is disabled by default.
# Usage: kill-system-process.ps1 -ImageNames "verge-mihomo.exe"
param([Parameter(Mandatory = $true)][string]$ImageNames)
$ErrorActionPreference = 'SilentlyContinue'

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class TokenPrivilege
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privilege; }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr tokenHandle, bool disableAllPrivileges,
        ref TOKEN_PRIVILEGES newState, uint bufferLength, IntPtr previousState, IntPtr returnLength);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    public static bool EnableDebugPrivilege()
    {
        const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
        const uint TOKEN_QUERY = 0x0008;
        const uint SE_PRIVILEGE_ENABLED = 0x0002;
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) return false;
        LUID luid;
        if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out luid)) return false;
        TOKEN_PRIVILEGES tp;
        tp.PrivilegeCount = 1;
        tp.Privilege.Luid = luid;
        tp.Privilege.Attributes = SE_PRIVILEGE_ENABLED;
        if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return false;
        return Marshal.GetLastWin32Error() == 0;
    }
}
'@

Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$enabled = [TokenPrivilege]::EnableDebugPrivilege()
Write-Output ("SeDebugPrivilege enabled: " + $enabled)

foreach ($image in $ImageNames.Split(',')) {
    $name = $image.Trim()
    if (-not $name) { continue }
    $base = $name -replace '\.exe$', ''
    $targets = @(Get-Process -Name $base -ErrorAction SilentlyContinue)
    foreach ($target in $targets) {
        Write-Output ("killing " + $target.ProcessName + " (PID " + $target.Id + ") ...")
        Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $left = @(Get-Process -Name $base -ErrorAction SilentlyContinue).Count
    Write-Output ("remaining " + $base + ": " + $left)
}
