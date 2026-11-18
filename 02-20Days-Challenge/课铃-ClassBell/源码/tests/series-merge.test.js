'use strict';

/**
 * 1.11.2 的三个修复：
 *  1. 浮窗倒计时不再被截断；
 *  2. 恢复任务时撤销它自动生成的下一期；
 *  3. 同系列任务在浮窗合并成一格，并标注「下次 …」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { Store, nextOccurrence, normalizeTask } = require('../server/store.js');
const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'series-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/* ======================================================= 4.1 seriesId */

test('a recurring root task gets its own id as seriesId', () => {
  const store = makeStore();
  const task = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  assert.equal(task.seriesId, task.id, '系列根节点也要有 seriesId');
});

test('a one-off task keeps an empty seriesId (nothing to group)', () => {
  const store = makeStore();
  const task = store.addTask({ title: '一次性', dueAt: '2026-12-01T10:00:00' });
  assert.equal(task.seriesId, '', '非重复任务不该被塞进任何系列');
});

test('the next period inherits the root seriesId', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const done = store.completeTask(root.id);
  assert.ok(done.next);
  assert.equal(done.next.seriesId, root.id, '子期必须指向同一个系列键');
});

test('old data without seriesId still resolves to one key via || id', () => {
  // 老数据根节点 seriesId 是空串：约定读取时用 seriesId || id 兜底
  const draft = {
    id: 't_old',
    title: '老任务',
    dueAt: '2026-12-01T10:00:00',
    recurrence: 'daily',
    seriesId: ''
  };
  const normalized = normalizeTask(draft, draft);
  assert.equal(normalized.seriesId, 't_old', ' normalizeTask 会补上，等于读取侧兜底');
  assert.ok(mainCs.includes('string.IsNullOrEmpty(seriesId) ? id : seriesId'), '宿主也按 seriesId || id 取键');
});

/* =================================================== 4.2 restoreTask */

test('restoring a completed recurring task removes the period it generated', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const before = store.state.tasks.length;

  const done = store.completeTask(root.id);
  assert.equal(store.state.tasks.length, before + 1, '完成后多了一期');

  const result = store.restoreTask(root.id);
  assert.equal(store.state.tasks.length, before, '恢复后任务数应回到完成前');
  assert.equal(result.removedNextId, done.next.id, '要返回被撤销的下一期 id');
  assert.equal(result.task.status, 'pending');
  assert.equal(store.state.tasks.filter((t) => t.status === 'pending').length, 1, '不能同时躺着两条 pending');
});

test('restoring twice is harmless', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  store.completeTask(root.id);
  store.restoreTask(root.id);
  const again = store.restoreTask(root.id);
  assert.equal(again.removedNextId, null, '已经没得删了');
  assert.equal(store.state.tasks.length, 1);
});

test('a next period that the user already started is kept', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const done = store.completeTask(root.id);
  store.startTask(done.next.id);

  const result = store.restoreTask(root.id);
  assert.equal(result.removedNextId, null, '下一期已经开始做，不能删');
  assert.equal(store.state.tasks.length, 2);
  assert.ok(store.state.tasks.some((t) => t.id === done.next.id), '下一期还在');
});

test('a next period that was already completed is kept', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const done = store.completeTask(root.id);
  store.completeTask(done.next.id);

  const result = store.restoreTask(root.id);
  assert.equal(result.removedNextId, null, '下一期已经是既成事实，不删');
});

test('a next period carrying actualMinutes is kept', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const done = store.completeTask(root.id);
  store.updateTask(done.next.id, { actualMinutes: 25 });

  const result = store.restoreTask(root.id);
  assert.equal(result.removedNextId, null, '有实际耗时说明被用过，不删');
});

test('completing again after a restore still generates the next period', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  store.completeTask(root.id);
  store.restoreTask(root.id);

  const again = store.completeTask(root.id);
  assert.ok(again.next, '修复不能把生成逻辑弄坏');
  assert.equal(store.state.tasks.length, 2);
  assert.equal(again.next.seriesId, root.id);
});

test('restoring a one-off task removes nothing', () => {
  const store = makeStore();
  const task = store.addTask({ title: '一次性', dueAt: '2026-12-01T10:00:00' });
  store.completeTask(task.id);
  const result = store.restoreTask(task.id);
  assert.equal(result.removedNextId, null);
});

test('restore only removes the immediate successor, not later periods', () => {
  const store = makeStore();
  const root = store.addTask({ title: '每天', dueAt: '2026-12-01T10:00:00', recurrence: 'daily' });
  const done1 = store.completeTask(root.id);      // 生成第二期
  const done2 = store.completeTask(done1.next.id); // 生成第三期
  assert.equal(store.state.tasks.length, 3);

  // 恢复第二期：应该只撤销第三期
  const result = store.restoreTask(done1.next.id);
  assert.equal(result.removedNextId, done2.next.id);
  assert.equal(store.state.tasks.length, 2, '第一期和第二期还在');
  assert.ok(store.state.tasks.some((t) => t.id === root.id));
});

/* ================================================= 4.3/4.4 浮窗显示 */

test('float grouping keys off seriesId, never the title', () => {
  assert.ok(mainCs.includes('string.IsNullOrEmpty(seriesId) ? id : seriesId'),
    '分组键必须是 seriesId（空则退回 id）');
  assert.equal(/GroupBy\(.*Title|key\s*=\s*.*\.Title/.test(mainCs), false,
    '不能按标题分组：同名但不同系列的任务会被吃掉');
  assert.ok(mainCs.includes('SeriesGroup'), '要有系列分组结构');
});

test('grouping happens before truncation', () => {
  const at = mainCs.indexOf('private static List<FloatWindow.TaskInfo> ComputeFloatTasks');
  const block = mainCs.slice(at, at + 4200);
  const groupAt = block.indexOf('groups.TryGetValue');
  const takeAt = block.indexOf('int take = Math.Max(1, Math.Min(3, count));');
  assert.ok(groupAt > 0 && takeAt > groupAt, '先分组、再排序、最后截断');
});

test('each series shows only its earliest period, with the next one as a hint', () => {
  const at = mainCs.indexOf('private sealed class SeriesGroup');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 1800);
  assert.ok(block.includes('TakeEarliest'), '每组取最早一期');
  assert.ok(block.includes('SecondDue'), '并算出下一期时间');
  assert.ok(mainCs.includes('head.NextDueAt = group.SecondDue();'));
});

test('countdown is formatted compactly and never ellipsised', () => {
  // 格式：1 天 2 时 / 1 时 52 分 / 22 分
  assert.ok(floatCs.includes('private static string FormatCountdown'));
  assert.ok(floatCs.includes('天 {1} 时'), '天 + 时的紧凑写法');
  assert.ok(floatCs.includes('时 {1} 分'), '时 + 分的紧凑写法');
  assert.ok(floatCs.includes('{0} 分'), '只有分钟时的写法');
  // 倒计时只做格式化，不走 FitOneLine
  assert.equal(/countdownLabels\[i\]\.Text = FitOneLine/.test(floatCs), false,
    '倒计时不许被截断');
  assert.ok(floatCs.includes('countdownLabels[i].Text = dueText;'), '倒计时直接赋值');
  // 宽度是按文字量出来的
  assert.ok(floatCs.includes('int dueWidth = MeasureWidth(dueText'), '倒计时先量宽再占位');
  assert.ok(floatCs.includes('rowWidth - dueWidth - gap'), '标题用剩下的宽度');
});

test('the hint line formats relative dates', () => {
  assert.ok(floatCs.includes('private static string FormatNextHint'));
  const at = floatCs.indexOf('private static string FormatNextHint');
  const block = floatCs.slice(at, at + 900);
  assert.ok(block.includes('"下次 {0} {1:00}:{2:00}"'), '文案是「下次 …」');
  assert.ok(block.includes('明天') && block.includes('今天'), '相对日期');
});

test('next hint does not add a row (height unchanged)', () => {
  // 小字放在主条目标题行右侧，不新增一行，所以高度公式不变
  assert.ok(floatCs.includes('BaseHeight + (count - 1) * ExtraRowStride'), '高度只跟条数有关');
  assert.ok(floatCs.includes('nextLabel.Bounds = new Rectangle(ClientSize.Width - pad'), '小字占标题行右侧');
});