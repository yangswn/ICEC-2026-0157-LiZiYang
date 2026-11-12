$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root "desktop"
$lib = Join-Path $desktop "lib"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  $csc = (Get-Command csc.exe -ErrorAction SilentlyContinue).Source
}
if (-not $csc) { throw "csc.exe not found (install .NET Framework 4.8)" }

$core = Join-Path $lib "Microsoft.Web.WebView2.Core.dll"
$winforms = Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll"
if (-not (Test-Path $core)) { throw "WebView2 SDK missing: $core" }

Push-Location $desktop
try {
  & $csc /nologo /platform:x64 /target:winexe /out:ClassBell.exe /win32manifest:app.manifest /win32icon:"$root\build\icon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Net.Http.dll `
    /r:"$core" /r:"$winforms" `
    Program.cs MainForm.cs LoginForm.cs ReminderForm.cs HostApi.cs AssemblyInfo.cs
  if ($LASTEXITCODE -ne 0) { throw "desktop host build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
Write-Host "Desktop host built: $desktop\ClassBell.exe"
