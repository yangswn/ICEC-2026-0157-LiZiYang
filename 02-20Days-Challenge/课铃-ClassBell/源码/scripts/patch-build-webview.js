'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/scripts/build-setup.ps1';
let s = fs.readFileSync(p, 'utf8');

const from = '$setup = Join-Path $dist "ClassBell-Setup-$version.exe"';
const to = [
  '$webview2 = Join-Path $root "tools\\MicrosoftEdgeWebview2Setup.exe"',
  'if (-not (Test-Path $webview2)) {',
  '  Write-Host "warning: WebView2 bootstrapper missing, installer will not carry it"',
  '}',
  '$setup = Join-Path $dist "ClassBell-Setup-$version.exe"'
].join('\n');

if (!s.includes(from)) throw new Error('setup path anchor not found');
s = s.replace(from, to);

const resFrom = '    /resource:"$zip",ClassBell.payload.zip /resource:"$root\\LICENSE",ClassBell.LICENSE.txt `';
const resTo = [
  '    /resource:"$zip",ClassBell.payload.zip /resource:"$root\\LICENSE",ClassBell.LICENSE.txt `',
  '    /resource:"$webview2",ClassBell.webview2 `'
].join('\n');

if (!s.includes(resFrom)) throw new Error('resource anchor not found');
s = s.replace(resFrom, resTo);

fs.writeFileSync(p, s, 'utf8');
console.log('build script embeds bootstrapper');
