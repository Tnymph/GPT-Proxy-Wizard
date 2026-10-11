# 探测本机已安装的相关软件与数据目录（只读，不做任何修改）。
# 输出 JSON 文件（UTF-8 无 BOM）。由 Node 调用：powershell -File detect-apps.ps1 -OutFile <path>
# 结构：{ clash: {candidates:[{path,source,exists}], best}, roxy: {...}, chatgpt: {packages:[...], aumid},
#         dataDirs: {clash, roxy}, drives: [...], os: {...} }
param([Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'

# —— 通用：从注册表"卸载项"里找安装位置 ——
function Get-RegistryInstallCandidates([string]$NamePattern, [string]$ExeName) {
    $out = @()
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $roots) {
        foreach ($item in @(Get-ItemProperty $root)) {
            if (-not $item.DisplayName) { continue }
            if ($item.DisplayName -notlike $NamePattern) { continue }
            if ($item.InstallLocation) {
                $p = Join-Path ($item.InstallLocation.Trim('"')) $ExeName
                $out += [pscustomobject]@{ path = $p; source = 'registry'; exists = [bool](Test-Path -LiteralPath $p -PathType Leaf) }
            }
            if ($item.DisplayIcon) {
                $icon = ($item.DisplayIcon.Trim('"') -split ',')[0]
                if ($icon -match '\.exe$') {
                    $out += [pscustomobject]@{ path = $icon; source = 'registry-icon'; exists = [bool](Test-Path -LiteralPath $icon -PathType Leaf) }
                }
            }
        }
    }
    return $out
}

# —— 通用：正在运行的进程的可执行路径 ——
function Get-RunningPath([string]$ImageName) {
    $p = Get-CimInstance Win32_Process -Filter ("Name='" + $ImageName + "'") | Select-Object -First 1
    if ($p -and $p.ExecutablePath) { return $p.ExecutablePath }
    return $null
}

$drives = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    if ($d.DriveType -eq [System.IO.DriveType]::Fixed) { $drives += $d.Name.TrimEnd('\') }
}

function Get-AppCandidates([string]$NamePattern, [string]$ExeName, [string]$FolderName) {
    $list = @()
    $list += Get-RegistryInstallCandidates $NamePattern $ExeName
    $running = Get-RunningPath $ExeName
    if ($running) { $list += [pscustomobject]@{ path = $running; source = 'process'; exists = [bool](Test-Path -LiteralPath $running -PathType Leaf) } }
    $stdRoots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})
    foreach ($root in $stdRoots) {
        if (-not $root) { continue }
        $p = Join-Path (Join-Path $root 'Programs') (Join-Path $FolderName $ExeName)
        $list += [pscustomobject]@{ path = $p; source = 'programs'; exists = [bool](Test-Path -LiteralPath $p -PathType Leaf) }
        $p2 = Join-Path (Join-Path $root $FolderName) $ExeName
        $list += [pscustomobject]@{ path = $p2; source = 'std-dir'; exists = [bool](Test-Path -LiteralPath $p2 -PathType Leaf) }
    }
    foreach ($drive in $drives) {
        $p = Join-Path (Join-Path ($drive + '\') $FolderName) $ExeName
        $list += [pscustomobject]@{ path = $p; source = 'drive-root'; exists = [bool](Test-Path -LiteralPath $p -PathType Leaf) }
    }
    # 去重（按 path，保留首个）+ 优先给出存在的
    $seen = @{}
    $uniq = @()
    foreach ($c in $list) {
        if (-not $c.path) { continue }
        $key = $c.path.ToLower()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $uniq += $c
    }
    $best = ($uniq | Where-Object { $_.exists } | Select-Object -First 1).path
    return [pscustomobject]@{ candidates = $uniq; best = $best }
}

$clash = Get-AppCandidates '*Clash Verge*' 'clash-verge.exe' 'Clash Verge'
$roxy = Get-AppCandidates '*Roxy*' 'RoxyBrowser.exe' 'RoxyBrowser'

# —— ChatGPT 桌面端（Microsoft Store 包）——
$packages = @()
foreach ($pkg in @(Get-AppxPackage | Where-Object { $_.Name -like '*OpenAI*' -or $_.PackageFamilyName -like '*OpenAI*' })) {
    $aumid = ''
    try {
        $manifest = Get-AppxPackageManifest -Package $pkg.PackageFullName
        $appId = @($manifest.Package.Applications.Application)[0].Id
        if ($appId) { $aumid = $pkg.PackageFamilyName + '!' + $appId }
    } catch { }
    $packages += [pscustomobject]@{
        name = $pkg.Name; familyName = $pkg.PackageFamilyName; fullName = $pkg.PackageFullName
        version = [string]$pkg.Version; installLocation = $pkg.InstallLocation; aumid = $aumid
    }
}

$dataDirs = [pscustomobject]@{
    clash = [pscustomobject]@{ path = (Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'); exists = [bool](Test-Path -LiteralPath (Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev')) }
    roxy  = [pscustomobject]@{ path = (Join-Path $env:APPDATA 'RoxyBrowser'); exists = [bool](Test-Path -LiteralPath (Join-Path $env:APPDATA 'RoxyBrowser')) }
}

$os = Get-CimInstance Win32_OperatingSystem

$obj = [pscustomobject]@{
    clash     = $clash
    roxy      = $roxy
    chatgpt   = [pscustomobject]@{ packages = $packages; aumid = (@($packages | Where-Object { $_.aumid })[0]).aumid }
    dataDirs  = $dataDirs
    drives    = $drives
    os        = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber }
}

$json = $obj | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
