# scan-for-secrets.ps1 -- pre-package / pre-commit hygiene scanner (zero dependency, read-only).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan-for-secrets.ps1 -Command secrets -Target <dir> [-Project <projDir>] [-Aggressive]
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan-for-secrets.ps1 -Command lint    -Target <dir>
#
# secrets: forbidden values come from
#   1) string literals inside <projDir>\src\config.local.js  (parsed as TEXT, never executed)
#   2) this machine's user name / host name
#   3) structural rules (GitHub/sk token prefixes, token=<hex>, credential URL forms)
#   -Aggressive additionally flags ANY public IPv4 address.
# lint: *.ps1 must start with a UTF-8 BOM; *.cmd / *.bat must be pure ASCII; *.json must NOT have a BOM.
#
# Exit codes: 0 = pass, 1 = findings, 2 = usage/env error.
param(
    [Parameter(Mandatory = $true)][ValidateSet('secrets', 'lint')][string]$Command,
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Project = 'E:\VibeCoding\HelpUseCodexAndGPTAPI',
    [switch]$Aggressive
)

$ErrorActionPreference = 'Stop'
$TextExt = @('.md', '.js', '.cjs', '.mjs', '.json', '.txt', '.ps1', '.cmd', '.bat', '.yaml', '.yml', '.html', '.css', '.ts', '.tsx', '.jsx', '.ini', '.conf', '.log')
$SkipDirs = @('.git', 'node_modules')
$MaxBytes = 2MB

function Fail([string]$msg) { Write-Output $msg; exit 2 }

if (-not (Test-Path -LiteralPath $Target)) { Fail ("target not found: " + $Target) }
$TargetRoot = (Resolve-Path -LiteralPath $Target).Path.TrimEnd('\')

function Get-TargetFiles {
    $all = Get-ChildItem -LiteralPath $TargetRoot -Recurse -File -ErrorAction SilentlyContinue
    $kept = @()
    foreach ($f in $all) {
        $skip = $false
        foreach ($d in $SkipDirs) { if ($f.FullName -like ("*\" + $d + "\*")) { $skip = $true; break } }
        if ($skip) { continue }
        if ($f.Length -gt $MaxBytes) { continue }
        if ($f.Extension -eq '' -and $f.Name -notin @('LICENSE', 'NOTICE')) { continue }
        if ($f.Extension -ne '' -and $TextExt -notcontains $f.Extension.ToLower()) { continue }
        $kept += $f
    }
    return $kept
}

function Mask([string]$value) {
    if ($value.Length -le 6) { return $value.Substring(0, [Math]::Min(2, $value.Length)) + '***' }
    return $value.Substring(0, 6) + '***'
}

function Test-PrivateIp([string]$ip) {
    $p = $ip.Split('.')
    if ($p.Count -ne 4) { return $true }
    $a = [int]$p[0]; $b = [int]$p[1]; $c = [int]$p[2]
    if ($a -eq 10 -or $a -eq 127 -or $a -eq 0) { return $true }
    if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $true }
    if ($a -eq 192 -and $b -eq 168) { return $true }
    if ($a -eq 169 -and $b -eq 254) { return $true }
    if ($a -eq 192 -and $b -eq 0 -and $c -eq 2) { return $true }
    if ($a -eq 198 -and $b -eq 51 -and $c -eq 100) { return $true }
    if ($a -eq 203 -and $b -eq 0 -and $c -eq 113) { return $true }
    if ($a -ge 224) { return $true }
    return $false
}

# Sensitive keys inside config.local.js (case-insensitive substring / suffix match).
$SensitiveKeyPattern = 'ip|host|user|pass|token|secret|credential|account|id$'

function Get-ForbiddenValues {
    $values = New-Object System.Collections.Generic.List[string]
    $cfg = Join-Path $Project 'src\config.local.js'
    if (Test-Path -LiteralPath $cfg) {
        $raw = [System.IO.File]::ReadAllText($cfg)
        $raw = [System.Text.RegularExpressions.Regex]::Replace($raw, '/\*[\s\S]*?\*/', ' ')
        $raw = [System.Text.RegularExpressions.Regex]::Replace($raw, '(^|[^:])//[^\r\n]*', '$1 ')
        # key: 'value' -- 只取"键名敏感"或"值形态像机密"（IPv4 / 长 hex / 超长串）的字面量，
        # 避免把 'use strict' 这类代码字面量也当成敏感值（实测会产生大量噪声）
        foreach ($m in [System.Text.RegularExpressions.Regex]::Matches($raw, "([A-Za-z][A-Za-z0-9_]*)\s*:\s*'([^'\r\n]{2,})'")) {
            $key = $m.Groups[1].Value
            $v = $m.Groups[2].Value
            if (-not $v -or $v.StartsWith('<')) { continue }
            $sensitiveKey = $key -match $SensitiveKeyPattern
            $secretShape = ($v -match '^\d{1,3}(\.\d{1,3}){3}$') -or ($v -match '^[0-9a-fA-F]{16,}$') -or ($v.Length -ge 20)
            if (($sensitiveKey -or $secretShape) -and -not $values.Contains($v)) { $values.Add($v) }
        }
    }
    if ($env:USERNAME -and $env:USERNAME.Length -ge 3 -and -not $values.Contains($env:USERNAME)) { $values.Add($env:USERNAME) }
    if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 3 -and -not $values.Contains($env:COMPUTERNAME)) { $values.Add($env:COMPUTERNAME) }
    return $values
}

function Invoke-Secrets {
    $files = Get-TargetFiles
    $values = Get-ForbiddenValues
    Write-Output ("target : " + $TargetRoot)
    Write-Output ("files  : " + $files.Count)
    Write-Output ("forbidden values loaded : " + $values.Count + " (from config.local.js + machine env)")
    foreach ($v in $values) { Write-Output ("   - " + (Mask $v)) }
    Write-Output ""

    $hits = 0
    foreach ($f in $files) {
        $lines = @()
        try { $lines = [System.IO.File]::ReadAllLines($f.FullName) } catch { continue }
        $rel = $f.FullName.Substring($TargetRoot.Length).TrimStart('\')
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            foreach ($v in $values) {
                if ($line.Contains($v)) {
                    $hits++
                    Write-Output ("X " + $rel + ":" + ($i + 1) + "  private-value  sample=" + (Mask $v))
                }
            }
            if ($line -match '\bgh[a-z]_[A-Za-z0-9]{20,}' -or $line -match 'github_[a-z]+_[A-Za-z0-9_]{20,}') {
                $hits++; Write-Output ("X " + $rel + ":" + ($i + 1) + "  github-token")
            }
            if ($line -match '\bsk-[A-Za-z0-9]{20,}') { $hits++; Write-Output ("X " + $rel + ":" + ($i + 1) + "  api-key") }
            if ($line -match '[?&]token=[A-Za-z0-9]{16,}') { $hits++; Write-Output ("X " + $rel + ":" + ($i + 1) + "  token-param") }
            if ($line -match 'x-access-token:[^@\s]{8,}') { $hits++; Write-Output ("X " + $rel + ":" + ($i + 1) + "  credential-url") }
            if ($Aggressive) {
                foreach ($m in [System.Text.RegularExpressions.Regex]::Matches($line, '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')) {
                    if (-not (Test-PrivateIp $m.Value)) {
                        $hits++; Write-Output ("X " + $rel + ":" + ($i + 1) + "  public-ipv4  sample=" + $m.Value)
                    }
                }
            }
        }
    }
    Write-Output ""
    if ($hits -eq 0) { Write-Output "OK: no sensitive values found"; exit 0 }
    Write-Output ("X total findings: " + $hits + " -- sanitize before packaging/committing")
    exit 1
}

function Invoke-Lint {
    $files = Get-TargetFiles
    $issues = 0
    $ps = 0; $cmd = 0
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($TargetRoot.Length).TrimStart('\')
        $ext = $f.Extension.ToLower()
        if ($ext -eq '.ps1') {
            $ps++
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
            if (-not $bom) { $issues++; Write-Output ("X " + $rel + "  missing UTF-8 BOM (PS 5.1 would parse it as GBK)") }
        }
        elseif ($ext -eq '.cmd' -or $ext -eq '.bat') {
            $cmd++
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            $bad = $false
            foreach ($b in $bytes) { if ($b -gt 0x7F) { $bad = $true; break } }
            if ($bad) { $issues++; Write-Output ("X " + $rel + "  non-ASCII bytes (cmd would misparse)") }
        }
        elseif ($ext -eq '.json') {
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                $issues++; Write-Output ("X " + $rel + "  JSON should not carry a BOM")
            }
        }
    }
    Write-Output ""
    Write-Output ("checked: .ps1=" + $ps + "  .cmd/.bat=" + $cmd)
    if ($issues -eq 0) { Write-Output "OK: encoding rules satisfied"; exit 0 }
    Write-Output ("X violations: " + $issues)
    exit 1
}

if ($Command -eq 'secrets') { Invoke-Secrets } else { Invoke-Lint }
