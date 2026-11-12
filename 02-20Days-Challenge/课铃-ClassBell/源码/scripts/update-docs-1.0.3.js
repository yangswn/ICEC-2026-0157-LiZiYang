'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');

/* changelog */
let changelog = read('CHANGELOG.md');
changelog = changelog.replace(
  '## 1.0.2 — 2026-11-09',
  [
    '## 1.0.3 — 2026-11-10',
    '',
    '### Added',
    '',
    '- 通知中心：从学习通通知页与本地关键事件（逾期、错过、器材未还）提取通知，支持已读、展开与手动补录；',
    '- 器材借还核对：登记借出、应还时间、逾期提示与一键归还，逾期自动进入通知中心；',
    '- 错题本：按学习通课程归档错题，可读取已批阅作业中的错题，也可手动补录，支持课程筛选与考点标签。',
    '',
    '### Known',
    '',
    '- 学习通通知接口没有公开稳定地址，提取失败时以本地事件兜底；',
    '- 错题自动归档依赖作业详情页结构，识别不到时请在错题本手动添加。',
    '',
    '## 1.0.2 — 2026-11-09'
  ].join('\n')
);
write('CHANGELOG.md', changelog);

/* readme */
let readme = read('README.md');
readme = readme.replace(
  '课铃是一个面向大学生的 Windows 轻量课程任务提醒工具：登录学习通后自动读取作业、考试与截止时间，也可以完全离线手动记录课程日程；到期前通过桌面弹窗、托盘和声音提醒。',
  '课铃是一个面向大学生的 Windows 轻量课程任务提醒工具：登录学习通后自动读取作业、考试与截止时间，也可以完全离线手动记录课程日程；到期前通过桌面弹窗、托盘和声音提醒。此外还提供通知提取、器材借还核对和按课程归档的错题本。'
);
readme = readme.split('ClassBell-Setup-1.0.2.exe').join('ClassBell-Setup-1.0.3.exe');
write('README.md', readme);

/* manual */
let manual = read('docs/使用手册.md');
manual = manual.split('ClassBell-Setup-1.0.2.exe').join('ClassBell-Setup-1.0.3.exe');
manual = manual.replace(
  '主窗口左侧有四个页面：',
  '主窗口左侧有七个页面：'
);
manual = manual.replace(
  '- **偏好设置**：提醒、后台运行、界面大小、运行日志、数据备份与退出。',
  [
    '- **通知中心**：提取学习通通知与本地关键事件，集中查看与标记已读；',
    '- **器材借还**：登记借出、核对归回、提示逾期；',
    '- **错题本**：按课程归档错题，支持自动读取与手动补录；',
    '- **偏好设置**：提醒、后台运行、界面大小、运行日志、数据备份与退出。'
  ].join('\n')
);
manual = manual.replace(
  '## 8. 数据备份',
  [
    '## 8. 通知中心',
    '',
    '进入“通知中心”：',
    '',
    '- **从学习通提取**：尝试读取学习通通知页，同时把本地的逾期作业、已错过作业、逾期未还器材整理成通知；',
    '- **手动添加**：填写标题、课程、类型和正文；',
    '- 点标题可展开正文；未读左侧有红点，可逐条标为已读，或“全部已读”。',
    '',
    '学习通通知接口没有公开稳定地址，若提取不到线上通知，本地关键事件仍会照常生成。',
    '',
    '## 9. 器材借还核对',
    '',
    '进入“器材借还”，点“登记借出”填写：',
    '',
    '- 器材名称、编号；',
    '- 借用人；',
    '- 借出时间、应还时间；',
    '- 备注（配件、存放位置等）。',
    '',
    '列表按“逾期未还 → 借出中 → 已归还”排序。点“归还”即核对完成，记录保留但不再提醒。',
    '“核对未还”会汇总当前未还数量与逾期数量。逾期器材会出现在通知中心。',
    '',
    '## 10. 错题本',
    '',
    '进入“错题本”：',
    '',
    '- **从学习通归档**：读取已批阅/已完成作业的详情页，按“我的答案 / 正确答案 / 解析”识别错题并归档；',
    '- **手动添加**：填写课程、来源作业、题目、我的答案、正确答案、解析和考点标签；',
    '- 顶部可按课程筛选，卡片上会标注“自动归档 / 手动记录”。',
    '',
    '自动识别依赖学习通作业详情页的结构；如果页面是图片题、验证页或结构变化，识别不到时请手动添加。',
    '',
    '## 11. 数据备份'
  ].join('\n')
);
write('docs/使用手册.md', manual);

/* test record */
let tests = read('docs/测试记录.md');
tests = tests.split('ClassBell-Setup-1.0.2.exe').join('ClassBell-Setup-1.0.3.exe');
write('docs/测试记录.md', tests);

/* submission doc */
let submit = read('docs/作业提交说明.md');
submit = submit.split('ClassBell-Setup-1.0.2.exe').join('ClassBell-Setup-1.0.3.exe');
write('docs/作业提交说明.md', submit);

console.log('docs updated');
