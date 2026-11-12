'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');
const VERSION = '1.2.5';

for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  write(file, read(file).replace(/ClassBell-Setup-1\.\d+\.\d+\.exe/g, `ClassBell-Setup-${VERSION}.exe`));
}

let changelog = read('CHANGELOG.md');
changelog = changelog.replace(
  '# Changelog\n',
  [
    '# Changelog',
    '',
    `## ${VERSION} — 2026-11-11`,
    '',
    '### Fixed',
    '',
    '- **字号引导每次启动都弹**：本地服务每次启动监听随机端口，页面源（含端口）一变，`localStorage` 就等于换了一个存储空间，`scaleGuideDone` / `uiScale` / `lastPage` 全部读不回来。现在这些界面偏好改存到服务端 `settings`（端口无关），`localStorage` 仅作兼容缓存；',
    '- 顺带修复“上次停留的页面”重启后丢失（同一根因）；',
    '- 日志结果列改为三态「正常 / 已恢复 / 异常」，403 这类由备用通道兜底的事件不再显示成红色异常，也不再计入错误数（含历史日志）。',
    ''
  ].join('\n')
);
write('CHANGELOG.md', changelog);

console.log('docs updated for', VERSION);
