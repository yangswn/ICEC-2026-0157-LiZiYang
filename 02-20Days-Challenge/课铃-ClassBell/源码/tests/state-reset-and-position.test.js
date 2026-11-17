'use strict';

/**
 * 1.9.3：两处同类遗漏。
 *
 *  一、restoreTask 把任务改回待完成时，没清 startAt / actualMinutes。
 *      这是「状态重置」这条链上漏掉的第二个入口 —— 1.9.2 只修了 nextOccurrence。
 *      这里除了测 restoreTask，还要遍历所有会把 status 变成 pending 的路径。
 *
 *  二、floatWindowPos 两端都要限范围，且 C# 端不能用 Math.Abs(int.MinValue)。
 *      C# 的解析已经抽到 desktop/PositionParse.cs，这里用 csc 编一份真跑一遍。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const {
  Store,
  nextOccurrence,
  normalizeTask,
  PENDING_STATE_RESET
} = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'p193-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/** 造一条"做完了"的任务：有开工时间、实际耗时、估时。 */
function doneTask(store, over = {}) {
  const created = store.addTask({
    title: '线性代数作业',
    course: '工程数学',
    dueAt: '2026-12-01T10:00:00',
    questionCount: 20
  });
  const task = store.state.tasks.find((t) => t.id === created.id);
  task.startAt = new Date(Date.now() - 40 * 60000).toISOString();
  task.estimatedMinutes = 35;
  task.estimateSource = 'rule';
  task.estimateDay = '2026-11-17';
  const result = store.completeTask(created.id);
  return { id: created.id, done: result.task, ...over };
}

/* ============================================================ 一、回退 */

test('restoreTask clears started-at, actual minutes and estimates', () => {
  const store = makeStore();
  const { id, done } = doneTask(store);
  assert.ok(done.startAt, '前置：完成后应保留开工时间');
  assert.ok(done.actualMinutes > 0, '前置：完成后应记下实际耗时');

  const back = store.restoreTask(id);
  assert.equal(back.status, 'pending');
  assert.equal(back.startAt, null, '改回待完成不能还带着开工时间（否则界面显示进行中）');
  assert.equal(back.actualMinutes, null, '改回待完成不能还带着实际耗时');
  assert.equal(back.estimatedMinutes, null, '要重新估');
  assert.equal(back.estimateSource, null);
  assert.equal(back.estimateDay, null);
  assert.equal(back.completedAt, null);
  assert.equal(back.completedBy, '');
  assert.deepEqual(back.remindersSent, []);
});

test('restoreTask does not leave a phantom history sample', () => {
  const store = makeStore();
  const { id } = doneTask(store);
  const before = store.state.tasks.filter((t) => Number.isFinite(Number(t.actualMinutes)) && t.actualMinutes > 0).length;
  assert.equal(before, 1);

  store.restoreTask(id);
  const after = store.state.tasks.filter((t) => Number.isFinite(Number(t.actualMinutes)) && t.actualMinutes > 0).length;
  assert.equal(after, 0, '改回待完成后不该再有耗时样本（否则历史层被污染）');
});

/*
 * 遍历所有会把 status 变成 pending 的路径。
 * 排查结论（server/*.js）：
 *   1. nextOccurrence()            —— 生成新一期
 *   2. restoreTask()               —— 走 updateTask 的 pending 分支
 *   3. updateTask({status:'pending'}) —— 通用 PATCH，编辑弹窗也会命中同一分支
 *   4. 学习通同步只做 pending → done/missed，不会反向
 * 所以真正要覆盖的是 1/2/3 三条。
 */
test('every path that sets status back to pending clears the same fields', () => {
  const store = makeStore();

  /* 路径 A：restoreTask */
  {
    const { id } = doneTask(store);
    const back = store.restoreTask(id);
    for (const [key, value] of Object.entries(PENDING_STATE_RESET)) {
      assert.deepEqual(back[key], value, `restoreTask 之后 ${key} 应重置`);
    }
  }

  /* 路径 B：通用 updateTask（编辑弹窗直接 PATCH status） */
  {
    const { id } = doneTask(store);
    const back = store.updateTask(id, { status: 'pending' });
    for (const [key, value] of Object.entries(PENDING_STATE_RESET)) {
      assert.deepEqual(back[key], value, `updateTask 之后 ${key} 应重置`);
    }
  }

  /* 路径 C：nextOccurrence 生成下一期 */
  {
    const created = store.addTask({ title: '每月作业', dueAt: '2026-11-15T10:00:00', recurrence: 'monthly' });
    const task = store.state.tasks.find((t) => t.id === created.id);
    task.startAt = new Date().toISOString();
    task.actualMinutes = 45;
    const draft = nextOccurrence(task, Date.parse('2026-11-16T00:00:00Z'));
    const next = normalizeTask(draft, draft);
    for (const [key, value] of Object.entries(PENDING_STATE_RESET)) {
      assert.deepEqual(next[key], value, `nextOccurrence 之后 ${key} 应重置`);
    }
  }
});

test('editing a task that is already pending keeps its started-at', () => {
  // 反例保护：编辑弹窗对一条进行中的任务保存时也会带 status:'pending'，
  // 那种情况不是"状态转换"，不该把开工时间抹掉。
  const store = makeStore();
  const created = store.addTask({ title: '进行中的任务', dueAt: '2026-12-01T10:00:00' });
  store.startTask(created.id);
  const startedAt = store.state.tasks.find((t) => t.id === created.id).startAt;
  assert.ok(startedAt);

  const edited = store.updateTask(created.id, { status: 'pending', title: '改了标题' });
  assert.equal(edited.title, '改了标题');
  assert.equal(edited.startAt, startedAt, '本来就在进行中，编辑不该清掉开工时间');
});

test('PENDING_STATE_RESET is what nextOccurrence uses', () => {
  // 两张表必须同源，否则下次又会漏一处
  const s = fs.readFileSync(path.join(repoRoot, 'server', 'store.js'), 'utf8');
  assert.ok(s.includes('const OCCURRENCE_RESET = { ...PENDING_STATE_RESET };'),
    'OCCURRENCE_RESET 应复用 PENDING_STATE_RESET，而不是各写一份');
  assert.equal('seriesStartAt' in PENDING_STATE_RESET, false, 'seriesStartAt 不进重置表');
});

/* ========================================================== 二、位置 */

const posCases = [
  ['999999,999999', ''],
  ['-2147483648,0', ''],
  ['500000,-500000', ''],
  ['abc', ''],
  ['1,2,3', ''],
  ['', ''],
  ['120, 340', '120,340'],
  ['999,999', '999,999'],
  ['100000,100000', '100000,100000']
];

for (const [input, expected] of posCases) {
  test(`settings store sanitises floatWindowPos ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
    const store = makeStore();
    assert.equal(store.updateSettings({ floatWindowPos: input }).floatWindowPos, expected);
  });
}

test('floatWindowPos null clears to empty', () => {
  const store = makeStore();
  assert.equal(store.updateSettings({ floatWindowPos: null }).floatWindowPos, '');
});

/* -------------------------------- C# 解析：真的编译并跑一遍 */

const csc = ['C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'].find((p) => fs.existsSync(p));

test('C# PositionParse survives int.MinValue and range violations', { skip: csc ? false : 'csc.exe 不可用' }, () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'csparse-'));
  const driver = path.join(dir, 'Driver.cs');
  const src = path.join(repoRoot, 'desktop', 'PositionParse.cs');

  fs.writeFileSync(driver, [
    'using System;',
    'using System.Drawing;',
    'using ClassBell;',
    '',
    'internal static class Driver',
    '{',
    '    private static int Main(string[] args)',
    '    {',
    '        Point p;',
    '        // arg[0] 是待解析的字符串；输出 "ok:x,y" 或 "bad"',
    '        bool ok = PositionParse.TryParse(args.Length > 0 ? args[0] : null, out p);',
    '        Console.Write(ok ? ("ok:" + p.X + "," + p.Y) : "bad");',
    '        return 0;',
    '    }',
    '}'
  ].join('\r\n'), 'utf8');

  const exe = path.join(dir, 'parse.exe');
  execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, src, driver], { stdio: 'pipe' });

  const run = (arg) => execFileSync(exe, [arg], { encoding: 'utf8' }).trim();

  // 关键回归：int.MinValue 的绝对值超 int 上限，Math.Abs 写法会直接崩。
  assert.equal(run('-2147483648,0'), 'bad', 'int.MinValue 不能抛异常，应当当作解析失败');
  assert.equal(run('2147483647,0'), 'bad', 'int.MaxValue 超出范围');
  assert.equal(run('999999,999999'), 'bad');
  assert.equal(run('500000,-500000'), 'bad');
  assert.equal(run('abc'), 'bad');
  assert.equal(run('1,2,3'), 'bad');
  assert.equal(run(''), 'bad');

  // 正常值照常解析
  assert.equal(run('120,340'), 'ok:120,340');
  assert.equal(run('-100000,-100000'), 'ok:-100000,-100000');
  assert.equal(run('100000,100000'), 'ok:100000,100000');
  assert.equal(run('999,999'), 'ok:999,999');
});