# 启动一个"已知程序"：只接受白名单内的程序名（避免变成"启动任意程序"的入口），
# 路径来自用户配置/自动探测；工作目录固定为该程序自己的安装目录
# （继承调用方目录会让 Roxy 等程序把日志/缓存写进启动者目录，实测踩过）。
# 用法：launch-app.ps1 -ExePath "D:\Clash Verge\clash-verge.exe" -ArgsJson '[]'
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$ArgsJson = '[]',
    [string]$WorkingDirectory = ''
)
$ErrorActionPreference = 'Stop'

# —— 校验（白名单 + 绝对路径 + 真实文件）——
$allowed = @('clash-verge.exe', 'RoxyBrowser.exe', 'RoxyChrome.exe')
if (-not [System.IO.Path]::IsPathRooted($ExePath)) { throw "必须是绝对路径：$ExePath" }
$full = [System.IO.Path]::GetFullPath($ExePath)
$base = [System.IO.Path]::GetFileName($full)
if ($allowed -notcontains $base) { throw "不在允许启动的程序清单内：$base" }
if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "可执行文件不存在：$full" }

# —— 参数：JSON 数组，逐项校验（本程序只传无空格的开关与 ID，出现空白/引号说明调用方有误）——
$argList = @()
$trimmed = ('{0}' -f $ArgsJson).Trim()
if ($trimmed -and $trimmed -ne '[]') {
    foreach ($a in ($ArgsJson | ConvertFrom-Json)) {
        $s = [string]$a
        if ($s -match '[\s"' + [char]39 + ']') { throw "启动参数含非法字符：$s" }
        $argList += $s
    }
}

if (-not $WorkingDirectory) { $WorkingDirectory = [System.IO.Path]::GetDirectoryName($full) }

# 注意：Start-Process 的 -ArgumentList 不接受空数组（会绑定失败），无参数时必须省略该参数
if ($argList.Count -gt 0) {
    $p = Start-Process -FilePath $full -ArgumentList $argList -WorkingDirectory $WorkingDirectory -PassThru
} else {
    $p = Start-Process -FilePath $full -WorkingDirectory $WorkingDirectory -PassThru
}
Write-Output ("launched " + $p.Id)
