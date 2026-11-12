'use strict';
const fs = require('fs');
const path = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/docs/使用手册.md';
let text = fs.readFileSync(path, 'utf8');

const pairs = [
  ['主窗口左侧有五个页面：', '主窗口左侧有四个页面：'],
  [
    '- **学习通同步**：登录学习通并同步作业/考试。\n- **运行日志**：查看本机过程数据、镜像到 Git。\n- **偏好设置**：提醒、后台运行、数据与日志。',
    '- **学习通同步**：登录学习通并同步作业/考试。\n- **偏好设置**：提醒、后台运行、界面大小、运行日志、数据备份与退出。'
  ],
  [
    '关闭主窗口时默认收起到系统托盘，程序继续运行并按时提醒。',
    '关闭主窗口时默认隐藏到系统托盘，程序继续运行并按时提醒。\n\n找回窗口：按 `Ctrl+Alt+B`，或双击桌面“显示课铃”。'
  ],
  ['运行日志页展示：', '偏好设置最下方的运行日志区展示：'],
  [
    'A：会，默认最小化到托盘。确保托盘图标仍在，且没有在设置中关闭“关闭窗口时最小化到托盘”。',
    'A：会，默认隐藏到托盘。用 `Ctrl+Alt+B` 或桌面“显示课铃”找回，且没有在设置中关闭“关闭窗口时隐藏到托盘”。'
  ],
  [
    '托盘菜单：',
    '偏好设置中还有：\n\n- **界面大小**：小 / 标准 / 大 / 特大 / 超大 / 巨大，也可用 `Ctrl` + `+`、`Ctrl` + `-`、`Ctrl` + `0`；\n- **终止课铃**：左侧底部的红色按钮，确认后关闭程序和后台服务。\n\n托盘菜单：'
  ]
];

for (const [from, to] of pairs) {
  if (text.includes(from)) text = text.split(from).join(to);
  else console.log('not found:', from.slice(0, 30));
}
fs.writeFileSync(path, text, 'utf8');
console.log('manual updated');
