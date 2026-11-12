'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');
const VERSION = '1.0.13';

for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  write(file, read(file).replace(/ClassBell-Setup-1\.0\.\d+\.exe/g, `ClassBell-Setup-${VERSION}.exe`));
}

let changelog = read('CHANGELOG.md');
changelog = changelog.replace(
  '# Changelog',
  [
    '# Changelog',
    '',
    `## ${VERSION} — 2026-11-10`,
    '',
    '### Fixed',
    '',
    '- **导出日志/导出数据点了没反应**：原来用网页里的 `<a download>` 触发下载，WebView2 在部分机器上会静默拦截，既不落盘也不报错。现在改为宿主接管：从本地服务取内容 → 弹“另存为” → 用 UTF-8（无 BOM）写盘，并提示实际保存路径；',
    '- 浏览器兜底模式（缺少 WebView2 时）仍保留普通下载路径；',
    '- 导出取消时给出“已取消保存”，不再误报成功。',
    ''
  ].join('\n')
);
write('CHANGELOG.md', changelog);

let manual = read('docs/使用手册.md');
if (!manual.includes('导出的文件会保存到哪里')) {
  manual = manual.replace(
    '## 12. 日志',
    [
      '导出的文件会保存到哪里：点“导出全部日志”/“导出数据”会弹出 Windows 的“另存为”对话框，默认文件名带日期时间，保存成功后会提示完整路径。若在浏览器兜底模式下使用，则走浏览器自己的下载。',
      '',
      '## 12. 日志'
    ].join('\n')
  );
}
write('docs/使用手册.md', manual);

console.log('docs updated for', VERSION);
