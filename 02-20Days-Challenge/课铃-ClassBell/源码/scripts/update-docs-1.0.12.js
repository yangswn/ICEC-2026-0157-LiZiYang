'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');
const VERSION = '1.0.12';

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
    '学生评审反馈的重复日程缺陷修复。',
    '',
    '### Fixed',
    '',
    '- **每月重复日期漂移**：原来逐月取“当前日”，1/31 变成 2/28 后永远停在 28 号。现在任务保存 `recurrenceDay`（锚点日）与 `seriesStartAt`（系列首期），每期都以锚点日重算，1/31 → 2/28 → 3/31 正常回位；',
    '- **过期重复任务补完后立刻又是“已逾期”**：生成下一期时会向前滚动到今天之后，不再产生一条刚出生就过期的任务；',
    '- `nextOccurrence` 增加滚动上限，避免异常数据导致死循环；',
    '- 重复日程相关代码补充中文注释，说明锚点、系列首期与滚动逻辑。',
    ''
  ].join('\n')
);
write('CHANGELOG.md', changelog);

let manual = read('docs/使用手册.md');
if (!manual.includes('每月重复的日期规则')) {
  manual = manual.replace(
    '任务列表默认按截止时间升序',
    [
      '每月重复的日期规则：以首次设置的“日”为锚点。例如 1 月 31 日 → 2 月 28 日（当月没有 31 日）→ 3 月 31 日，不会永久变成 28 日。',
      '',
      '补完一条已经过期的重复任务时，下一期会自动滚到“今天之后”的下一个周期，不会立刻又出现一条逾期任务。',
      '',
      '任务列表默认按截止时间升序'
    ].join('\n')
  );
}
write('docs/使用手册.md', manual);

console.log('docs updated for', VERSION);
