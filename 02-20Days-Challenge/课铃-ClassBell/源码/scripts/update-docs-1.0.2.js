'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const files = ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md'];
for (const file of files) {
  const full = root + file;
  let text = fs.readFileSync(full, 'utf8');
  text = text.split('ClassBell-Setup-1.0.1.exe').join('ClassBell-Setup-1.0.2.exe');
  text = text.split('v1.0.1').join('v1.0.2');
  fs.writeFileSync(full, text, 'utf8');
  console.log('updated', file);
}
