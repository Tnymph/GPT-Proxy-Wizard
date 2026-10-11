# 输出 ADMIN 或 USER，用于判断当前进程是否已提权。
$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Output 'ADMIN' } else { Write-Output 'USER' }
