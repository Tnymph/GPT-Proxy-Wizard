# add-bom.ps1 -- ensure every *.ps1 under a directory carries a UTF-8 BOM.
# Why: Windows PowerShell 5.1 decodes BOM-less UTF-8 scripts as the system code page (GBK on zh-CN),
# which breaks scripts containing non-ASCII text. This repo's rule: all .ps1 files carry a BOM.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File add-bom.ps1 -Target <dir>
param([Parameter(Mandatory = $true)][string]$Target)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Target)) { Write-Output ("target not found: " + $Target); exit 2 }
$root = (Resolve-Path -LiteralPath $Target).Path

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$changed = 0
$total = 0
foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ps1' -ErrorAction SilentlyContinue)) {
    $total++
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($hasBom) { continue }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
    $changed++
    Write-Output ("added BOM: " + $f.FullName.Substring($root.Length).TrimStart('\'))
}
Write-Output ("scanned .ps1 files: " + $total + ", fixed: " + $changed)
