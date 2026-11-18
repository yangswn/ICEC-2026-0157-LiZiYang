'use strict';

/**
 * 1.11.3：浮窗悬停高亮不稳。
 *
 * 根因：只有窗体重写了 OnMouseEnter/OnMouseLeave，而可见区域几乎全被 Label 盖住 ——
 *  - 光标直接落进 Label，窗体收不到 MouseEnter，不会变 100%；
 *  - 光标在两个 Label 之间移动，WinForms 会先给窗体发 MouseLeave 再发 MouseEnter，
 *    透明度在 100% 和设置值之间来回跳（看起来就是闪）。
 *
 * 修复思路：不再依赖任何 MouseEnter/Leave，改成「光标位置 + 窗口 Region」判定，
 * 并且只在状态翻转时改透明度。这几条用源码断言锁住，防止被改回去。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');

function sliceFrom(text, signature, length = 1600) {
  const at = text.indexOf(signature);
  assert.ok(at > 0, `找不到 ${signature}`);
  return text.slice(at, at + length);
}

/* ------------------------------------------------------- 判定方式 */

test('hover is driven by a timer, not by mouse enter/leave events', () => {
  assert.ok(floatCs.includes('hoverTimer'), '要有独立的悬停轮询定时器');
  const block = sliceFrom(floatCs, 'hoverTimer = new Timer');
  assert.ok(block.includes('hoverTimer.Tick += (s, e) => SyncHover();'));
  assert.ok(block.includes('hoverTimer.Start();'));
});

test('the form no longer overrides OnMouseEnter / OnMouseLeave', () => {
  assert.equal(/protected override void OnMouseEnter/.test(floatCs), false,
    '窗体级 MouseEnter 在子控件铺满时根本收不到');
  assert.equal(/protected override void OnMouseLeave/.test(floatCs), false,
    '窗体级 MouseLeave 会在子控件之间移动时误触发');
});

test('no child control is wired to hover events (adding a control must not break it)', () => {
  // 除了拖动和双击，子控件不该挂任何与透明度相关的事件
  const hookBlock = sliceFrom(floatCs, 'private void HookDrag()', 700);
  assert.ok(hookBlock.includes('MouseDown'), '拖动仍然挂 MouseDown');
  assert.equal(/MouseEnter|MouseLeave/.test(hookBlock), false,
    '子控件不允许单独处理悬停 —— 以后再加控件就会漏');
});

test('hover is judged by Region, not by the client rectangle alone', () => {
  const block = sliceFrom(floatCs, 'internal bool IsCursorInsideVisibleArea', 700);
  assert.ok(block.includes('region.IsVisible(client)'),
    '圆角是靠 Region 裁的，必须用 Region.IsVisible 判断');
  assert.ok(block.includes('ClientRectangle.Contains(client)'),
    '先用矩形做快速排除（并且 Region 可能为 null）');
  assert.ok(block.includes('return region == null || region.IsVisible(client);'));
});

/* ------------------------------------------------------- 不闪的关键 */

test('opacity only changes when the hover state actually flips', () => {
  const block = sliceFrom(floatCs, 'internal void SyncHover', 1400);
  assert.ok(block.includes('bool inside = IsCursorInsideVisibleArea();'));
  assert.ok(block.includes('if (inside == hovering) return;'),
    '状态没变就直接返回 —— 这是"内部移动不闪"的根本');
  assert.ok(block.includes('hovering = inside;'));
  assert.ok(block.includes('Opacity = 1.0;'), '进入时拉满');
  assert.ok(block.includes('Opacity = baseOpacity;'), '离开时回落到设置值');
});

test('dragging still suppresses the restore', () => {
  const block = sliceFrom(floatCs, 'internal void SyncHover', 1400);
  assert.ok(block.includes('else if (!dragging)'), '拖动中不恢复透明度');
});

test('hovering blocks SetBaseOpacity from stomping 100%', () => {
  const block = sliceFrom(floatCs, 'internal void SetBaseOpacity', 500);
  assert.ok(block.includes('!hovering'),
    '拖透明度滑杆时如果光标在浮窗上，不能让 100% 掉下来');
});

test('showing the window re-evaluates hover immediately', () => {
  const block = sliceFrom(floatCs, 'internal void ShowWindowWithoutStealingFocus', 600);
  assert.ok(block.includes('hovering = false;'), '显示时先复位悬停状态');
  assert.ok(block.includes('SyncHover();'), '再立刻按真实光标位置判定一次');
});

test('the hover timer is disposed with the form', () => {
  assert.ok(floatCs.includes('hoverTimer.Dispose'), '不漏定时器');
});

test('fade still uses the user opacity as baseline', () => {
  const block = sliceFrom(floatCs, 'private void FadeTick', 700);
  assert.ok(block.includes('baseOpacity - fadeStep'));
  assert.ok(block.includes('Opacity = baseOpacity'));
});

/* ------------------------------------------------ 探针接缝（可测性） */

test('client point source is injectable so layout logic stays testable', () => {
  assert.ok(floatCs.includes('internal Func<Point> ClientPointSource;'),
    '悬停判定要能在探针里用固定坐标驱动（不依赖真实鼠标与 DPI 换算）');
  assert.ok(floatCs.includes('ClientPointSource != null ? ClientPointSource() : PointToClient(Cursor.Position)'),
    '生产路径仍然用真实光标');
});