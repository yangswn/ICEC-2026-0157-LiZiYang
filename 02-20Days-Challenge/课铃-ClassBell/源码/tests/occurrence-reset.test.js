'use strict';

/**
 * 1.9.2：重复任务生成下一期时，不能继承上一期的「做完了」状态。
 *
 * 之前 nextOccurrence() 用 `...task` 复制再手写重置几个字段，
 * 漏了 1.7.0 新增的 startAt / actualMinutes：
 *   - 下一期一创建就带「已开始做」的时间 → 界面显示「进行中」
 *   - 下一期带着上一期的耗时 → 污染估时的历史层（同一份数据被当成多次样本）
 *
 * 现在改成集中的 OCCURRENCE_RESET 表，这里锁住三件事：
 *   1. 表里的每个 key，新一期都等于表里的值；
 *   2. 上一期的开工/耗时确实被清掉；
 *   3. seriesStartAt 仍按 1.6.3 的规则走（别把上次修的弄坏）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { Store, nextOccurrence, normalizeTask, OCCURRENCE_RESET } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'occ-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/** 造一条"上一期"：已完成、有开工时间与实际耗时、还有估时。 */
function finishedMonthly(over = {}) {
  return {
    id: 't_prev',
    title: '每月作业',
    course: '工程数学',
    category: 'homework',
    priority: 'normal',
    dueAt: '2026-11-15T02:00:00.000Z',
    noDeadline: false,
    notes: '',
    status: 'done',
    completedAt: '2026-11-15T03:00:00.000Z',
    completedBy: 'user',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-15T03:00:00.000Z',
    reminderOffsets: [60],
    remindersSent: ['o60@2026-11-15T02:00:00.000Z'],
    recurrence: 'monthly',
    seriesId: '',
    recurrenceDay: 15,
    seriesStartAt: '2026-11-15T02:00:00.000Z',
    startAt: '2026-11-15T02:10:00.000Z',
    actualMinutes: 50,
    estimatedMinutes: 45,
    estimateSource: 'rule',
    estimateDay: '2026-11-15',
    source: 'manual',
    sourceKey: '',
    sourceUrl: '',
    remoteStatus: 0,
    lastSeenAt: '',
    completedBy_legacy: '',
    questionCount: 30,
    detailFetchedAt: '2026-11-14T00:00:00.000Z',
    dueAtManual: false,
    ...over
  };
}

/* --------------------------------------------------- 核心：字段被清空 */

test('next occurrence clears started-at and actual minutes', () => {
  const prev = finishedMonthly();
  const draft = nextOccurrence(prev, Date.parse('2026-11-16T00:00:00Z'));
  assert.ok(draft, '应该生成下一期');

  const next = normalizeTask(draft, draft);
  assert.equal(next.startAt, null, '下一期不能带开工时间（否则界面显示进行中）');
  assert.equal(next.actualMinutes, null, '下一期不能带上一期的实际耗时');
  assert.equal(next.estimatedMinutes, null, '新一期要重新估');
  assert.equal(next.estimateSource, null);
  assert.equal(next.estimateDay, null);
  assert.equal(next.status, 'pending');
  assert.equal(next.completedAt, null);
  assert.equal(next.completedBy, '');
  assert.deepEqual(next.remindersSent, []);
});

test('every key in OCCURRENCE_RESET is applied to the new occurrence', () => {
  const prev = finishedMonthly();
  const draft = nextOccurrence(prev, Date.parse('2026-11-16T00:00:00Z'));
  const next = normalizeTask(draft, draft);

  for (const [key, value] of Object.entries(OCCURRENCE_RESET)) {
    assert.deepEqual(next[key], value, `字段 ${key} 应等于重置表里的值`);
  }
});

test('OCCURRENCE_RESET never contains seriesStartAt', () => {
  // 1.6.3 修的是"改期后从哪个月开始算"，靠 normalizeTask 的 dueChanged 决定。
  // 放进重置表会把那次修复破坏掉。
  assert.equal('seriesStartAt' in OCCURRENCE_RESET, false);
});

/* ------------------------------------------- 端到端：完成一条重复任务 */

test('completing a started monthly task produces a clean next period', async () => {
  const store = makeStore();
  const created = await store.addTask({
    title: '每月作业',
    dueAt: '2026-11-15T10:00:00',
    recurrence: 'monthly',
    questionCount: 30
  });

  store.startTask(created.id);
  // 假装 50 分钟前开工
  const task = store.state.tasks.find((t) => t.id === created.id);
  task.startAt = new Date(Date.now() - 50 * 60000).toISOString();

  const result = store.completeTask(created.id);
  assert.ok(result.next, '重复任务完成后应生成下一期');
  assert.equal(result.task.actualMinutes >= 49 && result.task.actualMinutes <= 51, true,
    `这一期应记下约 50 分钟，实际 ${result.task.actualMinutes}`);

  assert.equal(result.next.status, 'pending');
  assert.equal(result.next.startAt, null, '下一期不能是"进行中"');
  assert.equal(result.next.actualMinutes, null, '下一期不能带上次的耗时');

  // 历史样本只能有一个（这一期），下一期不能凑数
  const withActual = store.state.tasks.filter((t) => Number.isFinite(Number(t.actualMinutes)) && t.actualMinutes > 0);
  assert.equal(withActual.length, 1, '历史样本不应该被新一期复制出来');
});

/* ---------------------------------------- 别把 1.6.3 / 1.6.1 修坏 */

test('seriesStartAt still moves when a monthly task is rescheduled', () => {
  const store = makeStore();
  const created = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });

  const moved = store.updateTask(created.id, { dueAt: '2026-09-15T10:00:00' });
  assert.ok(moved.seriesStartAt.startsWith('2026-09-15'), '改期后起始月要跟着走');

  const next = nextOccurrence(moved, Date.parse('2026-09-16T00:00:00Z'));
  assert.ok(next.dueAt.startsWith('2026-10-15'), `下一期应是 10 月，实际 ${next.dueAt}`);
});

test('anchor day still travels with each period', () => {
  const store = makeStore();
  const created = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });

  const moved = store.updateTask(created.id, { dueAt: '2026-11-20T10:00:00' });
  assert.equal(moved.recurrenceDay, 20);

  const result = store.completeTask(created.id);
  assert.ok(result.next, '应生成下一期');
  assert.ok(result.next.dueAt.startsWith('2026-12-20'), `下一期应为 12 月 20 日，实际 ${result.next.dueAt}`);
  assert.equal(result.next.recurrenceDay, 20);
});