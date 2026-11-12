'use strict';
/**
 * 给“字号引导”加一个安全的重新入口。
 *
 * 背景：上一版我给了一条 Remove-Item 删除 WebView2 数据目录的命令，那会连登录 Cookie
 * 一起删掉，而且不进回收站。正确做法是提供一个应用内按钮，不需要删任何文件。
 */
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/src/renderer/app.js';
let s = fs.readFileSync(p, 'utf8');

const anchor = "  $('#scale-guide-done').addEventListener('click', closeScaleGuide);";
const add = [
  anchor,
  '  // 设置页里的“重新查看字号引导”：只重开弹窗，不动任何本地文件',
  "  $('#btn-reopen-scale-guide').addEventListener('click', () => {",
  '    openScaleGuide();',
  '  });'
].join('\n');

if (!s.includes(anchor)) throw new Error('scale guide done binding not found');
s = s.replace(anchor, add);
fs.writeFileSync(p, s, 'utf8');
console.log('reopen button wired');
