'use strict';

/**
 * 1.7.0 估时功能：
 *  - 四级来源（history → model → rule → guess）的回退顺序
 *  - 「今晚能做多少」按预算累加，绝不超预算
 *  - 开始做 / 完成时的实际耗时记录
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const estimate = require('../server/estimate.js');
const { Store } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', '.test-tmp', 'est-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function task(over = {}) {
  return {
    id: over.id || 't_x',
    title: '作业',
    course: '工程数学',
    status: 'pending',
    dueAt: '2026-12-01T10:00:00.000Z',
    noDeadline: false,
    questionCount: null,
    ...over
  };
}

/* ------------------------------------------------------------ 规则层 */

test('rule layer: 30 questions -> 45 minutes, 1 question -> 15 minutes', () => {
  assert.equal(estimate.ruleMinutes(task({ questionCount: 30 })), 45);
  assert.equal(estimate.ruleMinutes(task({ questionCount: 1 })), 15, '1 题也要给 15 分钟的下限');
  assert.equal(estimate.ruleMinutes(task({ questionCount: 0 })), null, '没有题量就不该走规则层');
});

test('rule layer never exceeds the 180 minute ceiling', () => {
  assert.equal(estimate.ruleMinutes(task({ questionCount: 400 })), 180);
});

/* ------------------------------------------------------------ 兜底层 */

test('guess layer uses title keywords, report beats test', () => {
  assert.equal(estimate.guessMinutes(task({ title: '期末测试', questionCount: null })), 30);
  assert.equal(estimate.guessMinutes(task({ title: '实验报告', questionCount: null })), 60);
  assert.equal(estimate.guessMinutes(task({ title: '第三章 工作页', questionCount: null })), 15);
  // 「测试报告」两边都命中，按报告算（更具体的那个）
  assert.equal(estimate.guessMinutes(task({ title: '测试报告', questionCount: null })), 60);
  // 什么线索都没有 → 默认 30 分钟
  assert.equal(estimate.guessMinutes(task({ title: '随便一件事', questionCount: null })), 30);
});

/* ------------------------------------------------------------ 历史层 */

test('history needs at least 3 same-course samples in the same question bucket', () => {
  const finished = [
    task({ id: 'a', status: 'done', questionCount: 30, actualMinutes: 40 }),
    task({ id: 'b', status: 'done', questionCount: 25, actualMinutes: 50 }),
    task({ id: 'c', status: 'done', questionCount: 35, actualMinutes: 60 })
  ];
  assert.equal(estimate.historyMinutes(task({ questionCount: 28 }), finished), 50, '中位数是 50');

  const onlyTwo = finished.slice(0, 2);
  assert.equal(estimate.historyMinutes(task({ questionCount: 28 }), onlyTwo), null, '少于 3 个样本不用历史');

  const otherCourse = finished.map((t) => ({ ...t, course: '大学英语' }));
  assert.equal(estimate.historyMinutes(task({ questionCount: 28 }), otherCourse), null, '不同课程不互相参考');

  const otherBucket = finished.map((t) => ({ ...t, questionCount: 2 }));
  assert.equal(estimate.historyMinutes(task({ questionCount: 28 }), otherBucket), null, '题量不在同一区间也不参考');
});

/* ------------------------------------------------------- 四级回退顺序 */

test('estimateTasks prefers history, then model, then rule', async () => {
  const finished = [
    task({ id: 'a', status: 'done', questionCount: 30, actualMinutes: 40 }),
    task({ id: 'b', status: 'done', questionCount: 30, actualMinutes: 50 }),
    task({ id: 'c', status: 'done', questionCount: 30, actualMinutes: 60 })
  ];
  const targets = [
    task({ id: 'hist', questionCount: 30 }),
    task({ id: 'model', course: '别的课', questionCount: 30 }),
    task({ id: 'rule', course: '第三门课', questionCount: 30 })
  ];

  const asked = [];
  const map = await estimate.estimateTasks(targets, {
    finished,
    useModel: true,
    askModel: async (batch) => {
      asked.push(...batch.map((t) => t.id));
      return new Map([['model', 25]]);
    }
  });

  assert.equal(map.get('hist').source, 'history');
  assert.equal(map.get('model').source, 'model');
  assert.equal(map.get('model').minutes, 25);
  assert.equal(map.get('rule').source, 'rule');
  assert.deepEqual(asked, ['model', 'rule'], '已经能从历史算出来的不再问模型');
});

test('model failure falls back to rule for the whole batch', async () => {
  const targets = [task({ id: 'a', questionCount: 30 }), task({ id: 'b', questionCount: 1 })];
  const map = await estimate.estimateTasks(targets, {
    finished: [],
    useModel: true,
    askModel: async () => { throw new Error('ollama down'); }
  });
  assert.equal(map.get('a').source, 'rule');
  assert.equal(map.get('a').minutes, 45);
  assert.equal(map.get('b').minutes, 15);
});

test('model values out of range are discarded instead of trusted', async () => {
  const targets = [task({ id: 'a', questionCount: 30 })];
  const map = await estimate.estimateTasks(targets, {
    finished: [],
    useModel: true,
    askModel: async () => new Map([['a', 9999]])
  });
  assert.equal(map.get('a').source, 'rule', '离谱的模型值要退回规则');
  assert.equal(map.get('a').minutes, 45);
});

test('no model and no question count falls back to guess', async () => {
  const targets = [task({ id: 'a', title: '实验报告', questionCount: null })];
  const map = await estimate.estimateTasks(targets, { finished: [], useModel: false });
  assert.equal(map.get('a').source, 'guess');
  assert.equal(map.get('a').minutes, 60);
});

/* --------------------------------------------------- 今晚能做多少 */

test('tonight plan accumulates up to the budget and never exceeds it', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');
  const tasks = [
    task({ id: '1', title: '逾期A', dueAt: '2026-11-10T10:00:00.000Z' }),
    task({ id: '2', title: '今天B', dueAt: '2026-11-15T20:00:00.000Z' }),
    task({ id: '3', title: '明天C', dueAt: '2026-11-16T10:00:00.000Z' }),
    task({ id: '4', title: '长期D', noDeadline: true, dueAt: '2099-12-31T23:59:00.000Z' })
  ];
  const map = new Map([
    ['1', { minutes: 45, source: 'rule' }],
    ['2', { minutes: 60, source: 'rule' }],
    ['3', { minutes: 30, source: 'rule' }],
    ['4', { minutes: 20, source: 'guess' }]
  ]);

  const plan = estimate.planTonight(tasks, map, 120, now);
  assert.ok(plan.used <= 120, `合计 ${plan.used} 不能超预算`);
  assert.deepEqual(plan.items.map((i) => i.id), ['1', '2'],
    '45+60 已用 105，C 的 30 和 D 的 20 都塞不进 120');
  assert.equal(plan.used, 105);

  const plan2 = estimate.planTonight(tasks, map, 180, now);
  assert.ok(plan2.used <= 180);
  assert.deepEqual(plan2.items.map((i) => i.id), ['1', '2', '3', '4']);
  assert.equal(plan2.used, 155);
});

test('tonight plan puts the most overdue task first', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');
  const tasks = [
    task({ id: 'soon', title: '马上截止', dueAt: '2026-11-15T13:00:00.000Z' }),
    task({ id: 'late', title: '逾期三天', dueAt: '2026-11-12T10:00:00.000Z' })
  ];
  const map = new Map([
    ['soon', { minutes: 30, source: 'rule' }],
    ['late', { minutes: 30, source: 'rule' }]
  ]);
  const plan = estimate.planTonight(tasks, map, 60, now);
  assert.equal(plan.items[0].id, 'late', '逾期三天的要排在马上截止的前面');
});

/* ------------------------------------------- store：开工与实际耗时 */

test('startTask writes startAt and completeTask turns it into actualMinutes', () => {
  const store = makeStore();
  const created = store.addTask({ title: '计时任务', dueAt: '2026-12-01T10:00:00' });

  const started = store.startTask(created.id);
  assert.ok(started.startAt, '点开始做应写入 startAt');

  // 假装 25 分钟前开工
  store.state.tasks[0].startAt = new Date(Date.now() - 25 * 60000).toISOString();
  const result = store.completeTask(created.id);
  assert.ok(result.task.actualMinutes >= 24 && result.task.actualMinutes <= 26,
    `实际耗时应在 25 左右，实际 ${result.task.actualMinutes}`);
});

test('completing without startAt records nothing unless the user picks a range', () => {
  const store = makeStore();
  const created = store.addTask({ title: '没计时', dueAt: '2026-12-01T10:00:00' });

  // 直接完成：不推断，actualMinutes 保持空
  const done1 = store.completeTask(created.id);
  assert.equal(done1.task.actualMinutes, null, '没开工时间就不该编一个耗时出来');

  // 用户选了区间：照用
  const store2 = makeStore();
  const created2 = store2.addTask({ title: '选了区间', dueAt: '2026-12-01T10:00:00' });
  const done2 = store2.completeTask(created2.id, { actualMinutes: 45 });
  assert.equal(done2.task.actualMinutes, 45);
});

test('estimate fields persist on the task', () => {
  const store = makeStore();
  const created = store.addTask({ title: '估时任务', dueAt: '2026-12-01T10:00:00', questionCount: 30 });
  const updated = store.updateTask(created.id, {
    estimatedMinutes: 45,
    estimateSource: 'rule',
    estimateDay: '2026-11-15'
  });
  assert.equal(updated.estimatedMinutes, 45);
  assert.equal(updated.estimateSource, 'rule');
  assert.equal(updated.estimateDay, '2026-11-15');
});
