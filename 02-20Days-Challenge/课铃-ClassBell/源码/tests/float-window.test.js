'use strict';

/**
 * 1.9.0 桌面浮窗。
 *
 * 浮窗本身是 WinForms 窗口，没法在 node 里跑起来，
 * 所以这里锁两件事：
 *  1) 设置层的行为（默认开、位置清洗、开关）；
 *  2) C# 里的关键约束（无边框/置顶/不抢焦点/全屏让路/双击/菜单项），
 *     防止以后被改回去 —— 这些每一条都是验收清单上的项。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { Store } = require('../server/store.js');

const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'float-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/* ------------------------------------------------------------ 设置层 */

test('float window is on by default', () => {
  const store = makeStore();
  assert.equal(store.state.settings.floatWindow, true);
  assert.equal(store.state.settings.floatWindowPos, '');
});

test('float position round-trips as "x,y" and rejects junk', () => {
  const store = makeStore();

  assert.equal(store.updateSettings({ floatWindowPos: '120, 340' }).floatWindowPos, '120,340');
  assert.equal(store.updateSettings({ floatWindowPos: '-8,12' }).floatWindowPos, '-8,12');

  // 脏值不能被当成"设过了"，否则浮窗会跑到屏幕外回不来
  assert.equal(store.updateSettings({ floatWindowPos: 'abc' }).floatWindowPos, '');
  assert.equal(store.updateSettings({ floatWindowPos: '12' }).floatWindowPos, '');
  assert.equal(store.updateSettings({ floatWindowPos: '1,2,3' }).floatWindowPos, '');
});

test('float window toggle is persisted', () => {
  const store = makeStore();
  assert.equal(store.updateSettings({ floatWindow: false }).floatWindow, false);
  assert.equal(store.updateSettings({ floatWindow: true }).floatWindow, true);
});

/* ------------------------------------------------------ C# 约束（外观） */

test('float window is borderless, topmost and stays off the taskbar', () => {
  assert.ok(floatCs.includes('FormBorderStyle = FormBorderStyle.None'), '要无边框');
  assert.ok(floatCs.includes('TopMost = true'), '要置顶');
  assert.ok(floatCs.includes('ShowInTaskbar = false'), '不能占任务栏');
});

test('float window is translucent and turns opaque on hover', () => {
  assert.ok(/IdleOpacity\s*=\s*0\.92/.test(floatCs), '平时 92% 半透明');
  assert.ok(/Opacity\s*=\s*1\.0/.test(floatCs), '鼠标移上去要变不透明');
  assert.ok(floatCs.includes('OnMouseEnter') && floatCs.includes('OnMouseLeave'));
});

test('size follows UI scale and DPI', () => {
  assert.ok(floatCs.includes('BaseWidth = 300') && floatCs.includes('BaseHeight = 84'), '基准 300×84');
  // 像素尺寸乘 uiScale，字号只乘 uiScale（点值由 GDI+ 按 DPI 放大）
  assert.ok(floatCs.includes('scale * dpiScale'), '像素尺寸要乘 DPI 比例');
  assert.ok(floatCs.includes('DetectDpiScale'), '要探测 DPI');
});

/* -------------------------------------------------- C# 约束（不抢焦点） */

test('float window never activates itself', () => {
  assert.ok(floatCs.includes('ShowWithoutActivation'), '必须重写 ShowWithoutActivation');
  assert.ok(floatCs.includes('WS_EX_NOACTIVATE'), '要带 WS_EX_NOACTIVATE');
  // 任何地方都不许调 Activate()
  assert.equal(/\.Activate\(\)/.test(floatCs), false, '浮窗里不能调 Activate()');
  // 菜单需要焦点时才临时打开，关掉要还原
  assert.ok(floatCs.includes('AllowActivation(false)'), '菜单关掉后要恢复不抢焦点');
});

/* ---------------------------------------------------- C# 约束（全屏） */

test('full screen apps make the float hide and it comes back afterwards', () => {
  assert.ok(floatCs.includes('IsFullscreenForeground'), '要有全屏检测');
  assert.ok(floatCs.includes('hiddenForFullscreen'), '要记住是因为全屏才藏的');
  assert.ok(/GetForegroundWindow|MonitorFromWindow/.test(floatCs), '用前台窗口 + 显示器矩形判断');
  assert.ok(floatCs.includes('SyncFullscreen'), '要定时检查');
});

/* -------------------------------------------------- C# 约束（交互） */

test('drag saves the position only after the mouse is released', () => {
  assert.ok(floatCs.includes('EndDrag'), '松手才收尾');
  assert.ok(floatCs.includes('SaveFloatWindowPosition'), '松手要记位置');
  assert.ok(floatCs.includes('ClampToVisible'), '要夹回可视区域');
});

test('position falls back to the primary corner when it lands off-screen', () => {
  assert.ok(floatCs.includes('IsPointOnAnyScreen'), '要判断位置还在不在任何屏幕上');
  assert.ok(floatCs.includes('DefaultPosition'), '回落到默认角');
  assert.ok(/EdgeMargin\s*=\s*24/.test(floatCs), '距边缘 24px');
});

test('double click opens the main window (multiple reliable paths)', () => {
  // 系统双击事件 + Clicks>=2 + 自己数时间，三条路任一命中都能打开
  assert.ok(floatCs.includes('OpenMain'), '要有打开主窗口的入口');
  assert.ok(floatCs.includes('e.Clicks >= 2'), '用 Clicks 判定');
  assert.ok(floatCs.includes('WM_LBUTTONDBLCLK'), '也认双击消息');
});

test('context menu has the three required items', () => {
  for (const label of ['打开课铃', '设置', '隐藏浮窗']) {
    assert.ok(floatCs.includes(label), `菜单要有「${label}」`);
  }
  // 子控件不继承窗体菜单，必须逐个挂
  assert.ok(floatCs.includes('titleLabel.ContextMenuStrip'), 'Label 也要挂菜单');
});

test('no pending task shows a message then fades out', () => {
  assert.ok(floatCs.includes('今天没有待办'), '要有空状态文案');
  assert.ok(/Interval = 3000/.test(floatCs), '先显示 3 秒再淡出');
  assert.ok(floatCs.includes('FadeTick'), '要有淡出');
});

/* ------------------------------------------------ C# 约束（宿主接线） */

test('host picks the same "next task" as the renderer', () => {
  const at = mainCs.indexOf('private static FloatWindow.TaskInfo ComputeNextTask');
  assert.ok(at > 0, '要有 ComputeNextTask');
  const block = mainCs.slice(at, at + 2600);
  assert.ok(block.includes('"pending"'), '只看待完成');
  assert.ok(block.includes('noDeadline'), '跳过长期任务');
  assert.ok(block.includes('best ?? earliestOverdue'), '优先未过期，其次最早逾期');

  // 渲染层 nextPendingTask() 用的也是这套规则
  const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(appJs.includes('nextPendingTask'), '渲染层有同样的规则');
});

test('float window refreshes on the existing 30 second poll', () => {
  const at = mainCs.indexOf('private async Task PollStatusAsync');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 2200);
  assert.ok(block.includes('SyncFloatWindow'), '30 秒轮询里要推一次下一项');
  assert.ok(/Interval = 30000/.test(mainCs), '轮询周期是 30 秒');
});