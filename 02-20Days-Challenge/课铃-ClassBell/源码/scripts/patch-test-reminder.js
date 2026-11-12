'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/src/renderer/app.js';
let s = fs.readFileSync(p, 'utf8');

const from = [
  "  $('#btn-test-reminder').addEventListener('click', async () => {",
  "    await api.testReminder();",
  "    toast('测试弹窗已发送，看看右下角。', 'success');",
  "  });"
].join('\n');

const to = [
  "  $('#btn-test-reminder').addEventListener('click', async () => {",
  "    try {",
  "      await api.testReminder();",
  "      toast('测试弹窗已发送，看看屏幕右下角。', 'success');",
  "    } catch (error) {",
  "      toast(`无法打开测试弹窗：${error.message || error}`, 'error', 5000);",
  "    }",
  "  });"
].join('\n');

if (!s.includes(from)) throw new Error('test reminder handler not found');
s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
console.log('testReminder guarded');
