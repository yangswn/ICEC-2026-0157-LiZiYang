'use strict';

/**
 * 1.6.3 回归：每月重复任务改期后，下一期必须落在「新月份的下一月」。
 *
 * 缺陷：seriesStartAt 改期时不重置，仍停在系列最初那个月，
 * nextOccurrence 的 monthDiff 变负数后被 Math.max(0, …) 夹成 0，
 * 于是从旧月份数一个月 —— 11 月改到 9 月，下一期算成 12 月。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Store, nextOccurrence, normalizeTask } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', '.test-tmp', 'd163-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/** 固定参考时刻，避免用例随真实日期漂移。 */
const after = (iso) => Date.parse(iso);

test('monthly: moving the due date to an earlier month keeps the next period adjacent', () => {
  const store = makeStore();
  const task = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });
  assert.equal(task.seriesStartAt, task.dueAt, '新建时起始月就是本期');

  const moved = store.updateTask(task.id, { dueAt: '2026-09-15T10:00:00' });
  assert.ok(moved.dueAt.startsWith('2026-09-15'));
  assert.equal(moved.seriesStartAt, moved.dueAt, '改期后起始月要跟着走');

  const next = nextOccurrence(moved, after('2026-09-16T00:00:00'));
  assert.ok(next, '应能算出下一期');
  assert.ok(next.dueAt.startsWith('2026-10-15'),
    `11 月改到 9 月，下一期应是 10 月，实际 ${next.dueAt}`);
});

test('monthly: moving to a later month rolls into next year correctly', () => {
  const store = makeStore();
  const task = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });

  const moved = store.updateTask(task.id, { dueAt: '2026-12-15T10:00:00' });
  const next = nextOccurrence(moved, after('2026-12-16T00:00:00'));
  assert.ok(next.dueAt.startsWith('2027-01-15'),
    `11 月改到 12 月，下一期应是次年 1 月，实际 ${next.dueAt}`);
});

test('monthly: editing only the title keeps the original month sequence', () => {
  const store = makeStore();
  const task = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });

  const renamed = store.updateTask(task.id, { title: '改个名字' });
  assert.equal(renamed.seriesStartAt, task.seriesStartAt, '只改标题不该动起始月');

  const next = nextOccurrence(renamed, after('2026-11-16T00:00:00'));
  assert.ok(next.dueAt.startsWith('2026-12-15'),
    `只改标题，下一期仍是 12 月，实际 ${next.dueAt}`);
});

test('weekly: still advances by 7 days after a due-date edit', () => {
  const store = makeStore();
  const task = store.addTask({ title: '每周', dueAt: '2026-11-15T10:00:00', recurrence: 'weekly' });

  const moved = store.updateTask(task.id, { dueAt: '2026-11-18T10:00:00' });
  const next = nextOccurrence(moved, after('2026-11-19T00:00:00'));
  assert.ok(next.dueAt.startsWith('2026-11-25'),
    `每周应 +7 天，实际 ${next.dueAt}`);
});

test('explicit seriesStartAt from the caller is never overwritten', () => {
  const base = {
    title: 'x',
    dueAt: '2026-11-15T02:00:00.000Z',
    seriesStartAt: '2026-11-15T02:00:00.000Z',
    recurrence: 'monthly'
  };
  const merged = normalizeTask({
    title: 'x',
    dueAt: '2026-09-15T10:00:00',
    recurrence: 'monthly',
    seriesStartAt: '2026-01-01T00:00:00.000Z'
  }, base);
  assert.equal(merged.seriesStartAt, '2026-01-01T00:00:00.000Z',
    '显式传入的 seriesStartAt 优先');
});

test('monthly anchor day and series start move together (1.6.1 + 1.6.3 combined)', () => {
  const store = makeStore();
  const task = store.addTask({ title: '月度', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });

  // 同时改月份和日号：22 号、9 月
  const moved = store.updateTask(task.id, { dueAt: '2026-09-22T10:00:00' });
  assert.ok(moved.seriesStartAt.startsWith('2026-09-22'), '起始月要跟到 9 月');
  assert.equal(moved.recurrenceDay, 22, '锚点日要跟到 22 号');

  const next = nextOccurrence(moved, after('2026-09-23T00:00:00'));
  assert.ok(next.dueAt.startsWith('2026-10-22'), `下一期应是 10 月 22 日，实际 ${next.dueAt}`);
  assert.equal(next.recurrenceDay, 22, '锚点日要传下去');
});
