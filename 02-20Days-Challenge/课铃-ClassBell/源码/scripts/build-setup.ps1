$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root "installer"
$dist = Join-Path $root "dist"
$payload = Join-Path $dist "ClassBell"
$build = Join-Path $installer "build"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found" }
$seven = Join-Path $root "tools\7za.exe"
if (-not (Test-Path $seven)) { throw "7za.exe not found: $seven" }

# package.json is the single source of truth for the version.
$version = ([System.IO.File]::ReadAllText((Join-Path $root "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
if (-not $version) { throw "package.json has no version" }
$parts = @($version.Split('.'))
while ($parts.Count -lt 4) { $parts += '0' }
$asmVersion = ($parts[0..3] -join '.')
Write-Host "Building ClassBell $version"

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Update-File($path, $pattern, $replacement) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $next = [System.Text.RegularExpressions.Regex]::Replace($text, $pattern, $replacement)
  if ($next -ne $text) { [System.IO.File]::WriteAllText($path, $next, $utf8) }
}

Update-File (Join-Path $root "desktop\AssemblyInfo.cs") 'AssemblyVersion\("[^"]+"\)' "AssemblyVersion(`"$asmVersion`")"
Update-File (Join-Path $root "desktop\AssemblyInfo.cs") 'AssemblyFileVersion\("[^"]+"\)' "AssemblyFileVersion(`"$asmVersion`")"
Update-File (Join-Path $root "installer\InstallerInfo.cs") 'AssemblyVersion\("[^"]+"\)' "AssemblyVersion(`"$asmVersion`")"
Update-File (Join-Path $root "installer\InstallerInfo.cs") 'AssemblyFileVersion\("[^"]+"\)' "AssemblyFileVersion(`"$asmVersion`")"
Update-File (Join-Path $root "installer\Setup.cs") 'internal const string Version = "[^"]+";' "internal const string Version = `"$version`";"
Update-File (Join-Path $root "desktop\app.manifest") '<assemblyIdentity version="[^"]+"' "<assemblyIdentity version=`"$asmVersion`""
Update-File (Join-Path $root "src\renderer\index.html") 'id="foot-version">v[^<]+<' "id=`"foot-version`">v$version<"
Update-File (Join-Path $root "src\renderer\index.html") 'id="about-version">v[^<]+<' "id=`"about-version`">v$version<"

& (Join-Path $PSScriptRoot "build-desktop.ps1")
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }
$env:CAMPUSPULSE_NODE = (Get-Command node).Source
Push-Location $root
try {
  node scripts\package-native.js
  if ($LASTEXITCODE -ne 0) { throw "app packaging failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $build | Out-Null
Push-Location $installer
try {
  & $csc /nologo /platform:x64 /target:winexe /out:"$build\Uninstall.exe" /win32icon:"$root\build\icon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll Uninstaller.cs InstallerInfo.cs
  if ($LASTEXITCODE -ne 0) { throw "uninstaller build failed" }
} finally { Pop-Location }
Copy-Item (Join-Path $build "Uninstall.exe") (Join-Path $payload "Uninstall.exe") -Force

$zip = Join-Path $dist "payload.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Push-Location $payload
try {
  & $seven a -tzip -mx=9 "$zip" ".\*" -r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "payload zip failed" }
} finally { Pop-Location }

$webview2 = Join-Path $root "tools\MicrosoftEdgeWebview2Setup.exe"
if (-not (Test-Path $webview2)) {
  Write-Host "warning: WebView2 bootstrapper missing, installer will not carry it"
}
$setup = Join-Path $dist "ClassBell-Setup-$version.exe"
if (Test-Path $setup) { Remove-Item $setup -Force }
Push-Location $installer
try {
  & $csc /nologo /platform:x64 /target:winexe /out:"$setup" /win32icon:"$root\build\icon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    /resource:"$zip",ClassBell.payload.zip /resource:"$root\LICENSE",ClassBell.LICENSE.txt `
    /resource:"$webview2",ClassBell.webview2 `
    Setup.cs InstallerInfo.cs
  if ($LASTEXITCODE -ne 0) { throw "setup build failed" }
} finally { Pop-Location }

# Keep only the current installer so the newest build is never ambiguous.
Get-ChildItem $dist -Filter "ClassBell-Setup-*.exe" | Where-Object { $_.Name -ne "ClassBell-Setup-$version.exe" } | Remove-Item -Force

Write-Host "Installer: $setup"
