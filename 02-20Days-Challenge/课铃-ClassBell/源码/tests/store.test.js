'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-store-'));
  return { dir, store: new Store(dir) };
}

function due(offsetDays = 1) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setSeconds(0, 0);
  return d.toISOString();
}

test('add, complete and restore a task', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '测试任务', course: '软件工程', dueAt: due(1) });
  assert.equal(store.stats().pending, 1);
  const done = store.completeTask(task.id);
  assert.equal(done.task.status, 'done');
  assert.equal(store.stats().done, 1);
  const restored = store.restoreTask(task.id).task;
  assert.equal(restored.status, 'pending');
  assert.equal(store.stats().pending, 1);
});

test('weekly recurrence creates the next occurrence', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '每周复盘', dueAt: due(1), recurrence: 'weekly' });
  const result = store.completeTask(task.id);
  assert.ok(result.next);
  assert.equal(result.next.status, 'pending');
  const delta = new Date(result.next.dueAt) - new Date(task.dueAt);
  assert.equal(delta, 7 * 86400000);
});

test('editing the due date clears sent reminders', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '提醒重置', dueAt: due(1), reminderOffsets: [60, 10] });
  store.markRemindersSent(task.id, [`o60@${task.dueAt}`]);
  assert.equal(store.snapshot().tasks[0].remindersSent.length, 1);
  const updated = store.updateTask(task.id, { dueAt: due(2) });
  assert.equal(updated.remindersSent.length, 0);
});

test('mergeRemote deduplicates by source key and adds due tasks', () => {
  const { store } = tempStore();
  const remote = {
    title: '课程设计报告', course: '软件工程', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:123', sourceUrl: 'https://mooc1.chaoxing.com/1'
  };
  const first = store.mergeRemote([remote], { autoAdd: true });
  assert.equal(first.added, 1);
  const second = store.mergeRemote([remote], { autoAdd: true });
  assert.equal(second.added, 0);
  assert.equal(store.stats().pending, 1);
});

test('mergeRemote keeps tasks without deadlines as open-ended tasks', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '章节测验', course: '线性代数', type: 'work',
    dueAt: null, sourceKey: 'cx:work:no-due'
  }], { autoAdd: true });
  assert.equal(result.added, 1);
  assert.equal(result.candidates, 0);
  const task = store.snapshot().tasks[0];
  assert.equal(task.noDeadline, true);
  assert.equal(task.dueAt, '2099-12-31T23:59:00.000Z');
  assert.equal(task.status, 'pending');
  assert.equal(store.stats().pending, 1);
});

test('mergeRemote does not add a completed task without a deadline', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '已完成的章节测验', course: '线性代数', type: 'work',
    dueAt: null, sourceKey: 'cx:work:no-due-done', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.snapshot().tasks.length, 0);
});

test('completed remote task is not added; closed unfinished work becomes a warning record', () => {
  const { store } = tempStore();
  const done = store.mergeRemote([{
    title: '已完成作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:done-only', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(done.added, 0);
  assert.equal(store.stats().done, 0);

  const closed = store.mergeRemote([{
    title: '已过期作业', course: '大学英语', type: 'work',
    dueAt: due(-2), sourceKey: 'cx:work:closed', remoteStatus: 0, closed: true
  }], { autoAdd: true });
  assert.equal(closed.missed, 1);
  assert.equal(store.stats().missed, 1);
  assert.equal(store.stats().pending, 0);
  assert.equal(store.snapshot().tasks[0].status, 'missed');
});


test('remote completion is reflected locally', () => {
  const { store } = tempStore();
  const remote = {
    title: '已批阅作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:done', remoteStatus: 0
  };
  store.mergeRemote([remote], { autoAdd: true });
  const result = store.mergeRemote([{ ...remote, remoteStatus: 1 }], { autoAdd: true });
  assert.equal(result.completed, 1);
  assert.equal(store.stats().done, 1);
});

test('does not add an already completed remote task', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '已提交作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:already-done', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.stats().pending, 0);
});


/* ---------------------------------------------- notices / gear / mistakes */

test('notices dedupe by sourceKey and track unread counts', () => {
  const { store } = tempStore();
  const first = store.addNotice({ title: '作业三已发布', sourceKey: 'cx:notice:1', source: 'chaoxing' });
  assert.equal(first.created, true);
  const again = store.addNotice({ title: '作业三已发布', sourceKey: 'cx:notice:1', source: 'chaoxing' });
  assert.equal(again.created, false);
  assert.equal(store.snapshot().notices.length, 1);
  assert.equal(store.stats().noticesUnread, 1);
  store.markAllNoticesRead();
  assert.equal(store.stats().noticesUnread, 0);
});

test('gear tracks borrow, overdue and return states', () => {
  const { store } = tempStore();
  const item = store.addGear({ name: '数字示波器', borrower: '张三', dueAt: due(-2) });
  assert.equal(item.status, 'out');
  assert.equal(store.gearSummary().out, 1);
  assert.equal(store.gearSummary().overdue, 1);
  const returned = store.returnGear(item.id, { condition: '正常' });
  assert.equal(returned.status, 'returned');
  assert.equal(store.gearSummary().out, 0);
  assert.equal(store.stats().gearOverdue, 0);
});

test('mistakes dedupe by sourceKey and summarize by course', () => {
  const { store } = tempStore();
  const payload = {
    course: '工程数学', question: '下列哪个是质数', myAnswer: 'A', correctAnswer: 'C',
    source: 'chaoxing', sourceKey: 'cx:mistake:1:0'
  };
  assert.equal(store.addMistake(payload).created, true);
  assert.equal(store.addMistake(payload).created, false);
  store.addMistake({ course: '大学英语', question: 'Unit 2 选词填空', source: 'manual' });
  const summary = store.mistakeSummary();
  assert.equal(summary.total, 2);
  assert.equal(summary.courses.length, 2);
  assert.equal(store.stats().mistakes, 2);
});

/* ------------------------------------------- report-driven regression tests */

test('editing a task does not re-arm reminders that already fired', () => {
  const { store } = tempStore();
  const task = store.addTask({
    title: '编辑不应重弹', dueAt: due(1), reminderOffsets: [60, 10], source: 'manual'
  });
  store.markRemindersSent(task.id, [`o60@${task.dueAt}`]);
  const before = store.snapshot().tasks[0].remindersSent.length;
  assert.equal(before, 1);
  const updated = store.updateTask(task.id, {
    title: '改个标题', notes: '只改了备注', reminderOffsets: [60, 10]
  });
  assert.equal(updated.remindersSent.length, 1);
});

test('changing the deadline still clears sent reminders', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '改截止时间', dueAt: due(1), reminderOffsets: [60] });
  store.markRemindersSent(task.id, [`o60@${task.dueAt}`]);
  const updated = store.updateTask(task.id, { dueAt: due(3) });
  assert.equal(updated.remindersSent.length, 0);
});

test('importing the same backup twice does not duplicate tasks', () => {
  const { store } = tempStore();
  const backup = JSON.stringify({
    app: 'ClassBell',
    tasks: [
      { title: '备份任务A', dueAt: due(2), sourceKey: 'cx:work:a' },
      { title: '备份任务B', dueAt: due(3), sourceKey: 'cx:work:b' }
    ],
    settings: { sound: false, displayName: '备份用户' }
  });
  const first = store.importData(backup);
  assert.equal(first.imported, 2);
  const second = store.importData(backup);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 2);
  assert.equal(store.snapshot().tasks.length, 2);
});

test('importing a backup restores settings', () => {
  const { store } = tempStore();
  store.importData(JSON.stringify({
    app: 'ClassBell',
    tasks: [{ title: '任务X', dueAt: due(1) }],
    settings: { sound: false, displayName: '备份用户' }
  }));
  assert.equal(store.snapshot().settings.sound, false);
  assert.equal(store.snapshot().settings.displayName, '备份用户');
});

test('rejects out-of-range quiet hours and keeps the previous value', () => {
  const { store } = tempStore();
  const before = store.snapshot().settings.quietHours.start;
  store.updateSettings({ quietHours: { enabled: true, start: '99:99', end: '25:61' } });
  const after = store.snapshot().settings.quietHours;
  assert.equal(after.start, before);
  assert.equal(after.enabled, true);
});

test('boolean settings are not flipped by the string "false"', () => {
  const { store } = tempStore();
  store.updateSettings({ sound: 'false' });
  assert.equal(store.snapshot().settings.sound, false);
  store.updateSettings({ sound: false });
  assert.equal(store.snapshot().settings.sound, false);
});

/* --------------------------------------------- 重复日程（学生评审反馈） */

test('monthly recurrence keeps the anchor day instead of drifting to 28', () => {
  const { nextOccurrence } = require('../server/store');
  const anchor = { seriesStartAt: '2026-01-31T10:00:00.000Z', recurrenceDay: 31 };
  let current = { id: 't', title: '月报', dueAt: '2026-01-31T10:00:00.000Z', recurrence: 'monthly', ...anchor };
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    current = nextOccurrence(current, Date.parse('2026-01-01T00:00:00Z'));
    seen.push(current.dueAt.slice(0, 10));
  }
  // 1/31 之后应回到 3/31、5/31，而不是永远 28 号
  assert.deepEqual(seen, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('completing a long-overdue daily task schedules the next one in the future', () => {
  const { store } = tempStore();
  const task = store.addTask({
    title: '每日打卡', dueAt: due(-6), recurrence: 'daily', reminderOffsets: [10]
  });
  const result = store.completeTask(task.id);
  assert.ok(result.next, '应该生成下一期');
  assert.ok(new Date(result.next.dueAt).getTime() > Date.now(), '下一期必须晚于现在');
  assert.equal(result.next.status, 'pending');
});

test('completing an overdue weekly task also rolls into the future', () => {
  const { store } = tempStore();
  const task = store.addTask({
    title: '每周复盘', dueAt: due(-21), recurrence: 'weekly', reminderOffsets: [10]
  });
  const result = store.completeTask(task.id);
  assert.ok(result.next);
  assert.ok(new Date(result.next.dueAt).getTime() > Date.now());
});

test('a fresh recurring task keeps its own day-of-month anchor', () => {
  const { store } = tempStore();
  const task = store.addTask({
    title: '月末结算', dueAt: '2026-01-31T10:00:00.000Z', recurrence: 'monthly'
  });
  assert.equal(task.recurrenceDay, 31);
  assert.equal(task.seriesStartAt, '2026-01-31T10:00:00.000Z');
});

/* ---------------------------------------- 关闭窗口说明（用户反馈：关不掉） */

test('close hint is pending by default and stays dismissed after the first close', () => {
  const { shouldShowCloseHint } = require('../server/store');
  const { store } = tempStore();

  // 新用户：还没解释过
  assert.equal(store.snapshot().settings.closeHintShown, false);
  assert.equal(shouldShowCloseHint(store.snapshot().settings), true);

  // 第一次点 ×，宿主写回标记
  store.updateSettings({ closeHintShown: true });
  assert.equal(shouldShowCloseHint(store.snapshot().settings), false);

  // 重新加载（模拟重启）：标记必须还在，不能第二次又弹
  store.flush();
  const reopened = new Store(store.dataDir);
  assert.equal(reopened.snapshot().settings.closeHintShown, true);
  assert.equal(shouldShowCloseHint(reopened.snapshot().settings), false);
});

test('old settings files without closeHintShown still load and default to pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-store-'));
  // 模拟 1.2.x 写下的旧数据：settings 里没有 closeHintShown
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    schema: 1,
    tasks: [],
    candidates: [],
    settings: { closeToTray: true, sound: true, reminderOffsets: [60] }
  }), 'utf8');

  const store = new Store(dir);
  const settings = store.snapshot().settings;
  assert.equal(settings.closeToTray, true, '老配置不能丢');
  assert.equal(settings.closeHintShown, false);
  assert.equal(require('../server/store').shouldShowCloseHint(settings), true);
});

test('turning closeToTray off is persisted (点 × 直接退出)', () => {
  const { store } = tempStore();
  store.updateSettings({ closeToTray: false });
  assert.equal(store.snapshot().settings.closeToTray, false);
  store.flush();
  const reopened = new Store(store.dataDir);
  assert.equal(reopened.snapshot().settings.closeToTray, false);
});
