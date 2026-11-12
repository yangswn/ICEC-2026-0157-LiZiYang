'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');

for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  let text = read(file).split('ClassBell-Setup-1.0.3.exe').join('ClassBell-Setup-1.0.4.exe');
  write(file, text);
}

let manual = read('docs/使用手册.md');
manual = manual.replace(
  '- **从学习通归档**：读取已批阅/已完成作业的详情页，按“我的答案 / 正确答案 / 解析”识别错题并归档；',
  [
    '- **扫描当前作业页**：在登录窗口打开“已批改”的作业详情页，回到错题本点一下，直接读取当前页面文字并归档；',
    '- **从学习通归档**：批量读取作业详情页，跟进 `doHomeWork` 跳转，按“我的答案 / 正确答案 / 解析”识别错题；'
  ].join('\n')
);
write('docs/使用手册.md', manual);

console.log('docs updated to 1.0.4');
