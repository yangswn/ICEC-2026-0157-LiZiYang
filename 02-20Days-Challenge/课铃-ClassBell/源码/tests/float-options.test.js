'use strict';

/**
 * 浮窗显示条数（1~3）、优先级排序、透明度（1.11.0）。
 *
 * 排序规则是死规定，这里把它钉住：
 *  第一关键字 优先级降序（urgent > important > normal），
 *  第二关键字 截止时间升序。
 * 「全普通 = 纯按时间」是必须保证的行为，所以单独一条用例。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');
const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'bridge.js'), 'utf8');
const { Store } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'floatopts-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/* ============================================================ 设置层 */

test('float task count defaults to 1 and only accepts 1..3', () => {
  const store = makeStore();
  assert.equal(store.state.settings.floatTaskCount, 1);
  assert.equal(store.updateSettings({ floatTaskCount: 3 }).floatTaskCount, 3);
  assert.equal(store.updateSettings({ floatTaskCount: 2 }).floatTaskCount, 2);
  // 非法值保留上一个合法值，不会被写成 0 条
  assert.equal(store.updateSettings({ floatTaskCount: 9 }).floatTaskCount, 2);
  assert.equal(store.updateSettings({ floatTaskCount: 0 }).floatTaskCount, 2);
});

test('float opacity is continuous inside 0.30..1.00', () => {
  const store = makeStore();
  assert.equal(store.state.settings.floatOpacity, 0.92, '默认值要和旧版常亮值一致');
  assert.equal(store.updateSettings({ floatOpacity: 0.73 }).floatOpacity, 0.73, '连续值要原样保存');
  assert.equal(store.updateSettings({ floatOpacity: 0.55 }).floatOpacity, 0.55);
  assert.equal(store.updateSettings({ floatOpacity: 0.1 }).floatOpacity, 0.3, '低于下限夹到 0.30');
  assert.equal(store.updateSettings({ floatOpacity: 1.5 }).floatOpacity, 1, '高于 1 夹到 1');
});

/* ============================================================ 排序 */

test('sorting is priority desc then due asc, in one comparator', () => {
  const at = mainCs.indexOf('private static List<FloatWindow.TaskInfo> ComputeFloatTasks');
  assert.ok(at > 0, '要有 ComputeFloatTasks');
  const block = mainCs.slice(at, at + 5200);

  assert.ok(block.includes('PriorityRank(b.Key.Priority).CompareTo(PriorityRank(a.Key.Priority))'),
    '第一关键字：优先级降序');
  assert.ok(block.includes('a.Value.CompareTo(b.Value)'), '第二关键字：截止时间升序');
  assert.ok(block.includes('byPriority != 0 ? byPriority : a.Value.CompareTo(b.Value)'),
    '两个关键字要在同一个比较器里');
});

test('the old "upcoming first, else overdue" rule is gone', () => {
  // 旧规则会挑两个候选再二选一，新规则只排序取前 N，不允许两套混用
  assert.equal(mainCs.includes('earliestOverdue'), false, '旧的过期兜底逻辑要彻底删掉');
  assert.equal(mainCs.includes('private static FloatWindow.TaskInfo ComputeNextTask'), false,
    '旧函数要退场');
});

test('priority rank: urgent > important > normal > unknown', () => {
  const at = mainCs.indexOf('private static int PriorityRank');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 400);
  assert.ok(/case "urgent": return 2;/.test(block));
  assert.ok(/case "important": return 1;/.test(block));
  assert.ok(/default: return 0;/.test(block), '未知优先级按普通处理');
});

test('overdue tasks are not special-cased in ordering', () => {
  // 排序里不该再出现「未过期优先」这类判断
  const at = mainCs.indexOf('private static List<FloatWindow.TaskInfo> ComputeFloatTasks');
  const block = mainCs.slice(at, at + 2200);
  assert.equal(/due\s*>=\s*now/.test(block), false, '不能按"是否过期"分支');
  assert.equal(/overdue/i.test(block.split('// 已过期任务')[0].split('Overdue = ')[0]), false);
});

/* ============================================================ 浮窗 */

test('float window supports 1..3 rows and grows with the count', () => {
  assert.ok(floatCs.includes('private const int BaseHeight = 84'), '1 条时沿用旧基准高度');
  assert.ok(floatCs.includes('private const int ExtraRowStride = 28'), '每多一条多一行高度');
  assert.ok(floatCs.includes('BaseHeight + (count - 1) * ExtraRowStride'), '高度随条数线性增长');
  assert.ok(floatCs.includes('internal void SetTaskCount(int count)'), '条数要能运行时改');
});

test('float window accepts a list of tasks, not just one', () => {
  assert.ok(floatCs.includes('internal void SetTasks(IList<TaskInfo> tasks)'));
  assert.ok(mainCs.includes('ComputeFloatTasks(stateNode, floatTaskCountValue)'));
  assert.ok(mainCs.includes('floatWindow.SetTasks(list)'));
});

test('the top row is visually stronger than the rest', () => {
  const at = floatCs.indexOf('internal void SetTasks(IList<TaskInfo> tasks)');
  assert.ok(at > 0);
  // 第一行粗体 + 更大字号，其余行常规字号
  assert.ok(/RebuildFont\(titleLabels\[0\], 10\.5F \* scale, FontStyle\.Bold\)/.test(floatCs), '第一条加粗');
  assert.ok(/RebuildFont\(titleLabels\[i\], 9F \* scale, FontStyle\.Regular\)/.test(floatCs), '其余常规');
});

test('priority drives colour, and normal is still readable ink (not grey)', () => {
  assert.ok(floatCs.includes('case "urgent": return LateColor;'));
  assert.ok(floatCs.includes('case "important": return GoldColor;'));
  assert.ok(floatCs.includes('default: return InkColor;'), '普通用墨色，不用灰，保证看得清');
});

test('opacity floor is documented and enforced at 0.30', () => {
  assert.ok(floatCs.includes('internal const double MinOpacity = 0.30'));
  // 注释里要写清为什么是 0.30
  assert.ok(/理由：浮窗是米白纸面/.test(floatCs), '下限要有理由');
  const at = floatCs.indexOf('internal void SetBaseOpacity');
  const block = floatCs.slice(at, at + 400);
  assert.ok(block.includes('Math.Max(MinOpacity'), '设置时夹到下限');
});

test('fade uses the user opacity as its baseline, not a hard-coded 0.92', () => {
  const at = floatCs.indexOf('private void FadeTick');
  assert.ok(at > 0);
  const block = floatCs.slice(at, at + 700);
  assert.ok(block.includes('baseOpacity - fadeStep'), '淡出从用户设置的值往下减');
  assert.ok(block.includes('Opacity = baseOpacity'), '淡完复位到用户设置的值');
  assert.equal(/IdleOpacity/.test(floatCs), false, '不能再有写死的 0.92 常量');
});

/* ============================================================ 四层贯通 */

test('settings reach the host and apply immediately', () => {
  assert.ok(bridgeJs.includes("host('applyFloatOptions'"), '前端改完要通知宿主');
  const at = mainCs.indexOf('case "applyFloatOptions"');
  assert.ok(at > 0, '宿主要有 applyFloatOptions');
  const block = mainCs.slice(at, at + 2600);
  assert.ok(block.includes('floatWindow.SetTaskCount(wantCount)'), '条数立刻生效');
  assert.ok(block.includes('floatWindow.SetBaseOpacity(wantOpacity)'), '透明度立刻生效');
  assert.ok(block.includes('SyncFloatWindow(latestStateNode)'), '条数变了要重排');
});

test('poll also reads the two settings (covers editing data.json directly)', () => {
  assert.ok(mainCs.includes('polledCount'));
  assert.ok(mainCs.includes('floatTaskCountValue = polledCount'));
  assert.ok(mainCs.includes('floatOpacityValue = polledOpacity'));
});

test('the settings UI has count buttons and an opacity slider in the same block', () => {
  assert.ok(html.includes('id="float-count"'), '条数控件');
  assert.ok(html.includes('id="float-opacity"'), '透明度滑杆');
  const at = html.indexOf('id="float-count"');
  const block = html.slice(Math.max(0, at - 1200), at + 800);
  assert.ok(block.includes('id="ui-scale"'), '要和字号那块放一起，不另开页');
  // 滑杆是连续值：min/max/step 都在，且 step=1（按 1% 调）
  assert.ok(/id="float-opacity"[^>]*min="30"/.test(html));
  assert.ok(/id="float-opacity"[^>]*max="100"/.test(html));
  assert.ok(/id="float-opacity"[^>]*step="1"/.test(html));
});

test('renderer reads, writes and echoes both values', () => {
  assert.ok(appJs.includes('function renderFloatOptions'));
  assert.ok(appJs.includes('function currentFloatTaskCount'));
  assert.ok(appJs.includes('function currentFloatOpacity'));
  assert.ok(appJs.includes('saveFloatOptions({ floatTaskCount'), '条数写回');
  assert.ok(appJs.includes('floatOpacity: Math.round(percent) / 100'), '透明度按 1% 粒度写回');
});

/* ====================================================== 主界面排序不受影响 */

test('main task list sorting is untouched', () => {
  const appText = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(appText.includes('taskListSorted'), '主界面列表排序函数还在');
  // 浮窗排序只加在宿主（C#），没有顺手改前端列表
  assert.equal(/function taskListSorted[\s\S]{0,400}priorityRank/.test(appText), false,
    '主界面列表排序不该因为这次改动而加优先级');
});