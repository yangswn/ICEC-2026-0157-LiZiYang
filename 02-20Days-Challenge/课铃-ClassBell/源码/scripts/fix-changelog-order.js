'use strict';
/** 修复 CHANGELOG：版本规则说明放回文件顶部，并修正被替换破坏的示例文字。 */
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/CHANGELOG.md';
let s = fs.readFileSync(p, 'utf8');

const NOTE = [
  '> 版本规则（语义化版本）：`主.次.补丁`。',
  '> - 功能、安全或行为变更 → **次版本 +1**（例如 1.0.9 → 1.1.0）；',
  '> - 只修缺陷 → **补丁 +1**（例如 1.1.0 → 1.1.1）；',
  '> - 不再使用 `1.0.10` 这种两位补丁号。',
  '> `package.json` 的 `version` 是唯一版本源，构建脚本会自动同步程序集版本、安装器版本、安装包文件名与界面版本号。'
].join('\n');

// 1) 把误放的说明块从正文里摘掉（连同前后多余空行）
s = s.replace('\n\n' + NOTE + '\n', '\n');
s = s.replace(NOTE + '\n', '');
s = s.replace(/\n{3,}/g, '\n\n');

// 2) 修正被替换脚本破坏的示例：1/3131 → 1/31
s = s.split('1/3131 →').join('1/31 →');
s = s.split('31 → 2/28').join('1/31 → 2/28');

// 3) 顶部重新插入说明
s = s.replace('# Changelog\n', '# Changelog\n\n' + NOTE + '\n');

fs.writeFileSync(p, s, 'utf8');

const lines = s.split('\n').slice(0, 22);
console.log(lines.map((l, i) => String(i + 1).padStart(2) + ' ' + l).join('\n'));
