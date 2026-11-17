'use strict';
/**
 * 提醒弹窗自适应 + 字号设置整合（1.10.2）。
 *
 * 原来的弹窗把 ClientSize 和每个 Label 的 Bounds 全部写死，标题一长就折行、
 * 折行后把下面两行挤掉；字体也写死、没有 DPI 缩放，所以不同机型表现不一样。
 * 这里锁住「尺寸按内容算」这件事，防止以后又被改回常量。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const layoutCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'ToastLayout.cs'), 'utf8');
const toastCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'TrayToastForm.cs'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');

/* ------------------------------------------------- 布局按内容算，不再写死 */

test('toast height is computed from the measured text, not a constant', () => {
  // 关键回归：原来这里是 ClientSize = new Size(392, 116)
  assert.equal(/ClientSize\s*=\s*new Size\(392,\s*116\)/.test(toastCs), false,
    '不能再用写死的客户区尺寸');
  assert.ok(toastCs.includes('ToastLayout.Compute'), '要按内容量出来的高度算');
  assert.ok(toastCs.includes('metrics.ClientHeight'), '高度来自布局结果');
});

test('layout stacks the three blocks and keeps the last one inside the window', () => {
  // 高度 = 上下内边距 + 三块文字 + 两处间距
  assert.ok(/ClientHeight\s*=\s*padTop \+ titleH \+ gapTitle \+ line1H \+ gapLines \+ line2H \+ padBottom/.test(layoutCs),
    '高度必须由三块文字相加得出');
  assert.ok(layoutCs.includes('metrics.Title.Bottom + gapTitle'), '第二块接在标题底部');
  assert.ok(layoutCs.includes('metrics.Line1.Bottom + gapLines'), '第三块接在第二块底部');
});

test('a long title that wraps to more lines gets more height', () => {
  // 量出来的高度直接用作 Label 高度，所以折行越多标签越高，不会裁字
  assert.ok(layoutCs.includes('Math.Max(titleFont.Height, titleSize.Height)'),
    '标题高度 = 实际测量高度（至少一行）');
  assert.ok(toastCs.includes('Bounds = metrics.Title'), '标题用算出来的高度');
  assert.ok(toastCs.includes('Bounds = metrics.Line2'), '第三行用算出来的位置');
});

/* ------------------------------------------------- 跟随设置与 DPI */

test('toast accepts the shared ui scale and detects DPI on its own', () => {
  assert.ok(/TrayToastForm\(\s*int lifeMs = 6000/.test(toastCs));
  assert.ok(toastCs.includes('float uiScale = 1.1f'), '要能接收「界面大小」');
  assert.ok(toastCs.includes('float dpiScale = 0f'), '要能接收 DPI 比例（0 = 自己探测）');
  assert.ok(toastCs.includes('DetectDpiScale'), '默认自己探测 DPI');

  // 像素乘 dpiScale，字号只乘 uiScale —— 和桌面浮窗同一套约定
  assert.ok(layoutCs.includes('uiScale * dpiScale'), '像素尺寸要乘 DPI 比例');
  assert.ok(/TitlePointSize \* uiScale/.test(layoutCs), '字号只乘 uiScale');
  assert.equal(/TitlePointSize \* uiScale \* dpiScale/.test(layoutCs), false,
    '字号不能再乘一次 DPI（点值本身会被 GDI+ 放大）');
});

test('the two toast call sites pass the current ui scale', () => {
  // 两处调用都要带缩放，漏一处就会出现"有时大有时小"
  const calls = mainCs.match(/new TrayToastForm\([^;]*\);/g) || [];
  assert.equal(calls.length, 2, '应该有两次弹窗调用');
  for (const call of calls) {
    assert.ok(call.includes('CurrentToastScale()'), `调用要传弹窗字号：${call.slice(0, 60)}`);
  }
});

test('window never lands outside the working area', () => {
  assert.ok(layoutCs.includes('PlaceBottomRight'), '位置要按工作区夹回');
  const at = layoutCs.indexOf('internal static Point PlaceBottomRight');
  const block = layoutCs.slice(at, at + 700);
  assert.ok(block.includes('workingArea.Top + margin'), '太高时不能算出负坐标');
  assert.ok(block.includes('workingArea.Left + margin'), '太宽时不能算出负坐标');
  assert.ok(toastCs.includes('ToastLayout.PlaceBottomRight'), '窗体要用这个定位');
});

test('toast does not double-scale itself via WinForms autoscaling', () => {
  assert.ok(toastCs.includes('AutoScaleMode.None'), '手工算缩放时不能再让 WinForms 自动缩放一次');
});

test('fonts created by the layout are disposed with the form', () => {
  // 每次弹窗都 new 两个 Font，不释放会漏 GDI 句柄
  assert.ok(toastCs.includes('protected override void Dispose(bool disposing)'), '要重写 Dispose');
  assert.ok(toastCs.includes('metrics.TitleFont.Dispose()'));
  assert.ok(toastCs.includes('metrics.LineFont.Dispose()'));
});

/* ------------------------------------------------- 设置整合（用户能看见） */

test('the three text sizes are grouped in one block, not scattered', () => {
  // 1.10.3：三处各自独立，但控件必须排在同一块里，用户能一眼看全
  assert.ok(html.includes('class="scale-matrix"'), '要有一个统一的字号区域');
  const at = html.indexOf('class="scale-matrix"');
  const block = html.slice(at, at + 1200);
  assert.ok(block.includes('id="ui-scale"'), '主界面');
  assert.ok(block.includes('id="float-scale"'), '桌面浮窗');
  assert.ok(block.includes('id="toast-scale"'), '提醒弹窗');
});

test('the float window toggle points at the float-specific size', () => {
  const at = html.indexOf('id="float-window-hint"');
  assert.ok(at > 0);
  const block = html.slice(at, at + 700);
  assert.ok(block.includes('字号'), '浮窗那栏要告诉用户字号在哪调');
  assert.ok(block.includes('单独调'), '要说明它不和主界面联动');
});