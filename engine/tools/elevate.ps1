# 以管理员身份重新启动本程序（会弹出 UAC 确认框）。
# 提权后的进程无法回传输出管道，因此提权实例会自行把日志写进应用目录（state\logs）。
#
# 三种用法：
#  A) 命令行（node 直接运行）：-ExePath <node.exe> -ScriptPath <cli.js> -ExtraArgs "stop --elevated"
#  B) 未打包的桌面应用：      -ExePath <electron.exe> -AppPath <应用目录> -ExtraArgs "--elevate-run stop"
#  C) 打包后的桌面应用：      -ExePath <本应用.exe> -ExtraArgs "--elevate-run stop"
#     （打包后 exe 本身就是应用，既不需要 -ScriptPath 也不需要 -AppPath）
# 加 -DryRun 只打印将要执行的命令行、不真正启动（用于自检，不会弹 UAC）。
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$ScriptPath = '',
    [string]$AppPath = '',
    [string]$ExtraArgs = '',
    [string]$WorkingDirectory = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "可执行文件不存在：$ExePath" }
if ($ScriptPath -and -not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "脚本不存在：$ScriptPath" }
if ($AppPath -and -not (Test-Path -LiteralPath $AppPath)) { throw "应用路径不存在：$AppPath" }
if ($ExtraArgs -match '[\r\n]') { throw '参数字符串非法' }

# Windows 命令行参数转义（CreateProcess 语义）
function Quote-Arg([string]$s) {
    if ($s -match '[\s"]') {
        $q = $s -replace '(\\*)"', '$1$1\"'
        $q = $q -replace '(\\+)$', '$1$1'
        return '"' + $q + '"'
    }
    return $s
}

$parts = @()
if ($ScriptPath) { $parts += (Quote-Arg $ScriptPath) }
if ($AppPath) { $parts += (Quote-Arg $AppPath) }
if ($ExtraArgs) { $parts += $ExtraArgs }
$argLine = ($parts -join ' ')

if ($DryRun) {
    Write-Output ('would-run: ' + (Quote-Arg $ExePath) + ' ' + $argLine)
    return
}

if ($WorkingDirectory) {
    $p = Start-Process -FilePath $ExePath -ArgumentList $argLine -WorkingDirectory $WorkingDirectory -Verb RunAs -PassThru
} else {
    $p = Start-Process -FilePath $ExePath -ArgumentList $argLine -Verb RunAs -PassThru
}
Write-Output ('elevated ' + $p.Id)
