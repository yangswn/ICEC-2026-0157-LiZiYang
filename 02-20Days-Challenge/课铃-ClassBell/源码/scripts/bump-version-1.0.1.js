'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const edits = {
  'package.json': [
    ['"version": "1.0.0"', '"version": "1.0.1"']
  ],
  'desktop/AssemblyInfo.cs': [
    ['AssemblyVersion("1.0.0.0")', 'AssemblyVersion("1.0.1.0")'],
    ['AssemblyFileVersion("1.0.0.0")', 'AssemblyFileVersion("1.0.1.0")']
  ],
  'installer/InstallerInfo.cs': [
    ['AssemblyVersion("1.0.0.0")', 'AssemblyVersion("1.0.1.0")'],
    ['AssemblyFileVersion("1.0.0.0")', 'AssemblyFileVersion("1.0.1.0")']
  ],
  'installer/Setup.cs': [
    ['internal const string Version = "1.0.0";', 'internal const string Version = "1.0.1";']
  ],
  'installer/setup.nsi': [
    ['!define PRODUCT_VERSION "1.0.0"', '!define PRODUCT_VERSION "1.0.1"'],
    ['VIProductVersion "1.0.0.0"', 'VIProductVersion "1.0.1.0"'],
    ['"FileVersion" "1.0.0.0"', '"FileVersion" "1.0.1.0"'],
    ['"ProductVersion" "1.0.0.0"', '"ProductVersion" "1.0.1.0"']
  ],
  'scripts/build-setup.ps1': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ],
  'scripts/build-installer.ps1': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ],
  'src/renderer/index.html': [
    ['v1.0.0', 'v1.0.1']
  ],
  'README.md': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ],
  'docs/作业提交说明.md': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ],
  'docs/使用手册.md': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ],
  'docs/测试记录.md': [
    ['ClassBell-Setup-1.0.0.exe', 'ClassBell-Setup-1.0.1.exe']
  ]
};

for (const [file, rules] of Object.entries(edits)) {
  const full = root + file;
  let text = fs.readFileSync(full, 'utf8');
  for (const [from, to] of rules) text = text.split(from).join(to);
  fs.writeFileSync(full, text, 'utf8');
  console.log('updated', file);
}
