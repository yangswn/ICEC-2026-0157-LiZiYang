$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$nsis = $env:NSIS_DIR
if (-not $nsis) { $nsis = Join-Path (Split-Path -Parent $root) ".tools\nsis\nsis-3.11" }
$makensis = Join-Path $nsis "makensis.exe"
if (-not (Test-Path $makensis)) { throw "NSIS not found: $makensis (set NSIS_DIR)" }

& (Join-Path $PSScriptRoot "build-desktop.ps1")
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }
$node = (Get-Command node).Source
$env:CAMPUSPULSE_NODE = $node
Push-Location $root
try {
  node scripts\package-native.js
  if ($LASTEXITCODE -ne 0) { throw "app packaging failed" }
} finally {
  Pop-Location
}

Push-Location (Join-Path $root "installer")
try {
  & $makensis setup.nsi
  if ($LASTEXITCODE -ne 0) { throw "NSIS build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
Write-Host "Installer: $root\dist\ClassBell-Setup-1.0.1.exe"
