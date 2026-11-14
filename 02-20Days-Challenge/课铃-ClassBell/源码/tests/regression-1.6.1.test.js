'use strict';

/**
 * 1.6.1 三个缺陷的回归测试：
 *  1) 非法日期（2026-02-30）不许被 JS 静默进位，必须报错；
 *  2) addTask(null/数组/字符串) 不许 500；
 *  3) 月度重复任务改 dueAt 后，下一期必须用新的日号；只改标题则保持原日号。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Store, nextOccurrence } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', '.test-tmp', 'd161-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/* -------------------------------------------------- 缺陷 1：非法日期 */

test('invalid calendar date is rejected instead of silently rolling forward', () => {
  const store = makeStore();
  for (const dueAt of ['2026-02-30T10:00:00', '2026-04-31T08:00:00', '2026-02-29']) {
    let caught = null;
    try {
      store.addTask({ title: '非法日期', dueAt });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${dueAt} 应该报错`);
    assert.equal(caught.code, 'INVALID_DATE', `${dueAt} 的错误码应为 INVALID_DATE`);
    assert.ok(caught.message.includes(dueAt), '错误信息应包含原始输入');
  }
  assert.equal(store.state.tasks.length, 0, '非法日期不应落库');
});

test('valid dates are unaffected', () => {
  const store = makeStore();
  const leap = store.addTask({ title: '闰年', dueAt: '2028-02-29T10:00:00' });
  assert.ok(leap.dueAt.startsWith('2028-02-29'));

  const normal = store.addTask({ title: '普通', dueAt: '2026-02-28T10:00:00' });
  assert.ok(normal.dueAt.startsWith('2026-02-28'));

  const monthly = store.addTask({ title: '每月', dueAt: '2026-12-31T23:00:00', recurrence: 'monthly' });
  assert.ok(monthly.dueAt.startsWith('2026-12-31'));
});

test('invalid date on update is rejected and leaves the task unchanged', () => {
  const store = makeStore();
  const task = store.addTask({ title: '原任务', dueAt: '2026-03-10T10:00:00' });
  let caught = null;
  try {
    store.updateTask(task.id, { dueAt: '2026-02-30T10:00:00' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'INVALID_DATE');
  assert.equal(store.state.tasks[0].dueAt, task.dueAt, '原截止时间不能被改动');
});

test('ISO strings with timezone and timestamps keep working', () => {
  const store = makeStore();
  const iso = store.addTask({ title: '带时区', dueAt: '2026-11-20T23:59:00.000Z' });
  assert.equal(iso.dueAt, '2026-11-20T23:59:00.000Z');

  const epoch = store.addTask({ title: '时间戳', dueAt: 1795000000000 });
  assert.ok(epoch.dueAt.startsWith('2026-'));
});

/* -------------------------------------------------- 缺陷 2：null body */

test('addTask rejects null, arrays and primitives with INVALID_INPUT', () => {
  const store = makeStore();
  for (const input of [null, undefined, [], ['x'], 'string', 42, true]) {
    let caught = null;
    try {
      store.addTask(input);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${JSON.stringify(input)} 应该报错`);
    assert.equal(caught.code, 'INVALID_INPUT', `${JSON.stringify(input)} 的错误码应为 INVALID_INPUT`);
    assert.ok(!caught.message.includes('Cannot read properties'), '不应再出现 TypeError 文案');
  }
  assert.equal(store.state.tasks.length, 0);
});

/* --------------------------------- 缺陷 3：月度重复改日期后下一期日号 */

test('monthly task: changing due date moves the anchor day for future periods', () => {
  const store = makeStore();
  const task = store.addTask({
    title: '每月作业',
    dueAt: '2026-11-15T10:00:00',
    recurrence: 'monthly'
  });
  assert.equal(task.recurrenceDay, 15);

  const updated = store.updateTask(task.id, { dueAt: '2026-11-20T10:00:00' }, { manual: true });
  assert.equal(updated.recurrenceDay, 20, '锚点日应跟随新的截止日');
  assert.ok(updated.dueAt.startsWith('2026-11-20'));

  const next = nextOccurrence(updated, Date.parse('2026-11-21T00:00:00'));
  assert.ok(next, '应能算出下一期');
  assert.ok(next.dueAt.startsWith('2026-12-20'), `下一期应为 12 月 20 日，实际 ${next.dueAt}`);
  assert.equal(next.recurrenceDay, 20);
});

test('monthly task: editing only the title keeps the original anchor day', () => {
  const store = makeStore();
  const task = store.addTask({
    title: '每月作业',
    dueAt: '2026-11-15T10:00:00',
    recurrence: 'monthly'
  });

  const renamed = store.updateTask(task.id, { title: '改了名字' });
  assert.equal(renamed.recurrenceDay, 15, '只改标题不该动锚点日');

  const next = nextOccurrence(renamed, Date.parse('2026-11-21T00:00:00'));
  assert.ok(next.dueAt.startsWith('2026-12-15'), `下一期仍是 15 日，实际 ${next.dueAt}`);
});

test('monthly task: editing notes/status keeps the anchor day', () => {
  const store = makeStore();
  const task = store.addTask({
    title: '每月作业',
    dueAt: '2026-11-15T10:00:00',
    recurrence: 'monthly'
  });

  const noted = store.updateTask(task.id, { notes: '只改备注' });
  assert.equal(noted.recurrenceDay, 15);

  const completed = store.completeTask(task.id);
  const next = completed.next;
  assert.ok(next, '重复任务完成后应生成下一期');
  assert.ok(next.dueAt.startsWith('2026-12-15'), `下一期仍是 15 日，实际 ${next.dueAt}`);
});

test('non-monthly recurrence keeps its own day arithmetic', () => {
  const store = makeStore();
  const weekly = store.addTask({
    title: '每周任务',
    dueAt: '2026-11-15T10:00:00',
    recurrence: 'weekly'
  });
  const moved = store.updateTask(weekly.id, { dueAt: '2026-11-18T10:00:00' }, { manual: true });
  const next = nextOccurrence(moved, Date.parse('2026-11-19T00:00:00'));
  assert.ok(next.dueAt.startsWith('2026-11-25'), `每周应 +7 天，实际 ${next.dueAt}`);
});
