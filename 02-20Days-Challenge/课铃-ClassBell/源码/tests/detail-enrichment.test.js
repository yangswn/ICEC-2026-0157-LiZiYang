'use strict';

/**
 * 1.6.0 详情页补全的单元测试。
 *
 * 真实探测结论（2026-11-14，工程数学「函数」等作业）：
 *  - 详情页 = 任务里的 sourceUrl（work/phone/task-work?taskrefId=…&courseId=…&classId=…&enc_task=…）
 *  - 未提交：<h4>截止时间：11-20 23:59</h4> + <span aria-label="截止时间11月20日23时59分00秒">
 *            + <p>共包含30道题目，其中单选题14道，判断题16道。</p>
 *  - 已提交：只有成绩卡 <p>共18题，客观题18道，主观题0道</p>，整页无“截止”
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../server/chaoxing-parser.js');
const { ChaoxingService } = require('../server/chaoxing.js');
const { Store } = require('../server/store.js');

const NOW = new Date('2026-11-14T01:00:00+08:00');

/* ------------------------------------------------------------ 解析 */

const PENDING_HTML = `<!doctype html><html><body>
<div class="zwork">
  <div class="tmTimeNew">
    <span role="option"><span aria-label="开始时间11月13日08时31分00秒"></span>
      <h4 aria-hidden="true">开始时间：11-13 08:31</h4></span>
    <span role="option"><span aria-label="截止时间11月20日23时59分00秒"></span>
      <h4 aria-hidden="true">截止时间：11-20 23:59</h4></span>
  </div>
  <div class="zwork_info"><p>共包含30道题目，其中单选题14道，判断题16道。</p></div>
</div></body></html>`;

const SUBMITTED_HTML = `<!doctype html><html><body>
<div class="wid750 padTop250">
  <p class="Number">83.3<span>分</span></p>
  <div class="BtmCon"><p>共18题，客观题18道，主观题0道</p></div>
</div></body></html>`;

test('detail page (unsubmitted) yields deadline and question count', () => {
  const parsed = parser.parseWorkDetail(PENDING_HTML, NOW);
  assert.equal(parsed.questionCount, 30);
  assert.ok(parsed.dueAt, '应该解析出截止时间');
  // 11-20 23:59 北京时间 = 15:59Z
  assert.equal(parsed.dueAt, '2026-11-20T15:59:00.000Z');
  assert.equal(parsed.hasDeadlineLabel, true);
});

test('detail page (submitted) has no deadline but still gives question count', () => {
  const parsed = parser.parseWorkDetail(SUBMITTED_HTML, NOW);
  assert.equal(parsed.dueAt, null, '已提交页没有截止时间');
  assert.equal(parsed.questionCount, 18);
  assert.equal(parsed.hasDeadlineLabel, false, '页面上没有“截止”字样');
});

test('deadline across new-year boundary rolls to next year', () => {
  const html = '<h4 aria-hidden="true">截止时间：01-05 09:00</h4>';
  const parsed = parser.parseWorkDetail(html, new Date('2026-12-20T10:00:00+08:00'));
  assert.ok(parsed.dueAt.startsWith('2027-01-05'), `跨年应落到 2027，实际 ${parsed.dueAt}`);
});

test('structure change is detectable (has label, cannot parse)', () => {
  const html = '<p>截止时间：见课程通知</p>';
  const parsed = parser.parseWorkDetail(html, NOW);
  assert.equal(parsed.dueAt, null);
  assert.equal(parsed.hasDeadlineLabel, true, '应识别出“有截止标签但解析失败”');
});

/* ------------------------------------------------------- 限速与降级 */

function makeService({ fetchImpl, log = [] } = {}) {
  const telemetry = { log: (event, payload) => log.push({ event, payload }) };
  const service = new ChaoxingService({ telemetry });
  service._fetch = fetchImpl;
  return { service, log };
}

function fakeTasks(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t_${i}`,
    title: `作业 ${i}`,
    status: 'pending',
    noDeadline: true,
    dueAt: '2099-12-31T23:59:00.000Z',
    sourceUrl: `https://mooc1.chaoxing.com/work/phone/task-work?taskrefId=${1000 + i}`,
    detailFetchedAt: null,
    dueAtManual: false,
    ...extra
  }));
}

test('enrichment keeps request gap between 0.8s and 1.2s and stays serial-ish', async () => {
  const starts = [];
  const { service } = makeService({
    fetchImpl: async () => {
      starts.push(Date.now());
      return { text: PENDING_HTML };
    }
  });

  const tasks = fakeTasks(3);
  const started = Date.now();
  const { stats } = await service.enrichTaskDetails(tasks, { limit: 10, now: NOW });
  const elapsed = Date.now() - started;

  assert.equal(stats.checked, 3);
  assert.equal(stats.requests, 3);
  // 两个并发 worker，但共享 800ms 起步间隔 → 至少 2 个间隔
  assert.ok(elapsed >= 1600, `总耗时 ${elapsed}ms 应 ≥1600ms`);
  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= 700, `第 ${i} 个请求间隔 ${gap}ms 太短`);
  }
});

test('fetch failure does not set detailFetchedAt (so it retries next sync)', async () => {
  const { service, log } = makeService({
    fetchImpl: async () => { throw new Error('timeout'); }
  });

  const tasks = fakeTasks(1);
  const { stats, results } = await service.enrichTaskDetails(tasks, { limit: 10, now: NOW });

  assert.equal(stats.failed, 1);
  assert.equal(results.length, 0, '失败不应产生写入');
  assert.ok(log.some((l) => l.event === 'detail_fetch_error'));
});

test('parse miss is recorded, page still marked as fetched', async () => {
  const { service, log } = makeService({
    fetchImpl: async () => ({ text: '<p>截止时间：见课程通知</p>' })
  });

  const tasks = fakeTasks(1);
  const { stats, results } = await service.enrichTaskDetails(tasks, { limit: 10, now: NOW });

  assert.equal(stats.parseMiss, 1);
  assert.equal(results.length, 1);
  assert.ok(results[0].patch.detailFetchedAt, '解析失败也要标记已抓过，避免每轮重试');
  assert.equal(results[0].patch.dueAt, undefined);
  assert.ok(log.some((l) => l.event === 'detail_parse_miss'));
});

test('already fetched tasks are skipped (no repeated requests)', async () => {
  let calls = 0;
  const { service } = makeService({
    fetchImpl: async () => { calls += 1; return { text: PENDING_HTML }; }
  });

  const tasks = fakeTasks(3, { detailFetchedAt: '2026-11-14T00:00:00.000Z' });
  const { stats } = await service.enrichTaskDetails(tasks, { limit: 10, now: NOW });

  assert.equal(stats.checked, 0);
  assert.equal(calls, 0);
});

test('manual due dates and tasks with a real deadline are never touched', async () => {
  let calls = 0;
  const { service } = makeService({
    fetchImpl: async () => { calls += 1; return { text: PENDING_HTML }; }
  });

  const tasks = [
    ...fakeTasks(1, { dueAtManual: true }),
    ...fakeTasks(1, { noDeadline: false, dueAt: '2026-11-20T15:59:00.000Z' }),
    ...fakeTasks(1, { status: 'done' })
  ];
  const { stats } = await service.enrichTaskDetails(tasks, { limit: 10, now: NOW });

  assert.equal(stats.checked, 0);
  assert.equal(calls, 0);
});

test('limit caps one round at 40 requests', async () => {
  let calls = 0;
  const { service } = makeService({
    fetchImpl: async () => { calls += 1; return { text: SUBMITTED_HTML }; }
  });
  const tasks = fakeTasks(45);
  // 只验证条数上限，间隔设 0，避免测试跑 40 秒
  const { stats } = await service.enrichTaskDetails(tasks, { limit: 40, now: NOW, gapMs: 0 });
  assert.equal(stats.checked, 40);
  assert.equal(calls, 40);
});

/* ------------------------------------------------------------ store */

function makeStore() {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', '.test-tmp', 'store-'));
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(dir);
  return store;
}

test('applyDetailEnrichment fills an empty deadline once', () => {
  const store = makeStore();
  const task = store.addTask({ title: '空截止时间作业', noDeadline: true, source: 'chaoxing' });

  const updated = store.applyDetailEnrichment(task.id, {
    dueAt: '2026-11-20T15:59:00.000Z',
    questionCount: 30,
    fetchedAt: '2026-11-14T00:00:00.000Z'
  });

  assert.equal(updated.dueAt, '2026-11-20T15:59:00.000Z');
  assert.equal(updated.noDeadline, false);
  assert.equal(updated.questionCount, 30);
  assert.equal(updated.detailFetchedAt, '2026-11-14T00:00:00.000Z');
});

test('applyDetailEnrichment never overwrites a task that already has a deadline', () => {
  const store = makeStore();
  const task = store.addTask({
    title: '已有截止时间',
    dueAt: '2026-11-20T15:59:00.000Z',
    source: 'chaoxing'
  });

  const updated = store.applyDetailEnrichment(task.id, {
    dueAt: '2026-12-01T00:00:00.000Z',
    questionCount: 12,
    fetchedAt: '2026-11-14T00:00:00.000Z'
  });

  assert.equal(updated.dueAt, '2026-11-20T15:59:00.000Z', '已有截止时间不许改');
  assert.equal(updated.questionCount, 12, '题量仍可补');
});

test('user-edited due date is protected from sync and enrichment', () => {
  const store = makeStore();
  const task = store.addTask({
    title: '用户改过的作业',
    dueAt: '2026-11-20T15:59:00.000Z',
    source: 'chaoxing',
    sourceKey: 'cx:work:manual-protect'
  });

  // 用户手工改期
  const edited = store.updateTask(task.id, { dueAt: '2026-11-25T10:00:00.000Z' }, { manual: true });
  assert.equal(edited.dueAtManual, true, '手工改期应打标记');

  // 同步回来一个不同的时间 → 不许覆盖
  store.mergeRemote([{
    sourceKey: 'cx:work:manual-protect',
    title: '用户改过的作业',
    dueAt: '2026-12-02T15:59:00.000Z',
    remoteStatus: 0,
    type: 'work',
    sourceUrl: ''
  }], { autoAdd: false });
  assert.equal(store.state.tasks[0].dueAt, '2026-11-25T10:00:00.000Z', '同步不许覆盖手改时间');

  // 补全也不许覆盖
  store.applyDetailEnrichment(task.id, { dueAt: '2026-12-09T00:00:00.000Z' });
  assert.equal(store.state.tasks[0].dueAt, '2026-11-25T10:00:00.000Z', '补全不许覆盖手改时间');
});

test('work list status attribute marks graded work as completed', () => {
  // status=4（已批改）只显示分数、没有 <b> 文案
  const html = `
    <dl class="worksList">
      <dt class="clearfix" data="/work/phone/task-work?taskrefId=56550098" status="4">
        <div class="fl workLeft"><h3>函数</h3><p>2026-10-09</p></div>
        <span class="fr workRight score">83.3</span>
      </dt>
      <dt class="clearfix" data="/work/phone/task-work?taskrefId=58367417" status="1">
        <div class="fl workLeft"><h3>函数的单调性</h3><p>2026-11-13</p></div>
        <span class="fr workRight doWOrk"><b>做作业</b></span>
      </dt>
      <dt class="clearfix" data="/work/phone/task-work?taskrefId=57598696" status="2">
        <div class="fl workLeft"><h3>函数的连续性</h3><p>2026-10-28</p></div>
        <span class="fr workRight without">已过期</span>
      </dt>
    </dl>`;

  const rows = parser.parseWorkListHtml(html);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));

  assert.equal(byTitle['函数'].remoteStatus, 1, '已批改应算已完成');
  assert.equal(byTitle['函数的单调性'].remoteStatus, 0, '未做仍是待完成');
  assert.equal(byTitle['函数的连续性'].remoteStatus, 0, '已过期但未提交仍算待完成');
  assert.equal(byTitle['函数的连续性'].closed, true, '已过期应标记为关闭');
});
