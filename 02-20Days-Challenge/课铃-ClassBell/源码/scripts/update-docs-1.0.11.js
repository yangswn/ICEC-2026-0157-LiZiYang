'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');
const VERSION = '1.0.11';

for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  write(file, read(file).replace(/ClassBell-Setup-1\.0\.\d+\.exe/g, `ClassBell-Setup-${VERSION}.exe`));
}

/* README: the installer now carries the runtime */
let readme = read('README.md');
if (!readme.includes('安装包内置 WebView2')) {
  readme = readme.replace(
    '安装不需要管理员权限，默认安装到 `%LOCALAPPDATA%\\Programs\\ClassBell`。',
    '安装不需要管理员权限，默认安装到 `%LOCALAPPDATA%\\Programs\\ClassBell`。\n\n安装包**内置 WebView2 引导程序**：目标电脑没有 WebView2 运行时会自动静默安装，对方不需要自己准备任何环境。若目标电脑完全离线导致安装失败，课铃仍可用默认浏览器打开，功能不受影响。'
  );
}
write('README.md', readme);

/* manual: installation section */
let manual = read('docs/使用手册.md');
if (!manual.includes('内置 WebView2')) {
  manual = manual.replace(
    'Windows SmartScreen 如提示未知发布者，见 [安装说明与 SmartScreen](docs/安装说明与SmartScreen.md)；这是未签名应用的正常提示。',
    '安装包内置 WebView2 引导程序：目标电脑缺少 WebView2 运行时会自动安装，不需要对方手动准备环境。\n\nWindows SmartScreen 如提示未知发布者，见 [安装说明与 SmartScreen](docs/安装说明与SmartScreen.md)；这是未签名应用的正常提示。'
  );
}
write('docs/使用手册.md', manual);

/* changelog */
let changelog = read('CHANGELOG.md');
changelog = changelog.replace(
  '# Changelog',
  [
    '# Changelog',
    '',
    `## ${VERSION} — 2026-11-10`,
    '',
    '### Changed',
    '',
    '- 安装包内置 Microsoft WebView2 引导程序（约 1.9 MB）：目标电脑缺少运行时时自动静默安装，接收方不需要自己准备环境；',
    '- 运行时安装失败时不影响课铃安装，程序启动会用默认浏览器打开，功能可用。',
    ''
  ].join('\n')
);
write('CHANGELOG.md', changelog);

console.log('docs updated for', VERSION);
