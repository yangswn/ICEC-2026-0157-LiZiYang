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
    assert.ok(call.includes('CurrentUiScale()'), `调用要传当前缩放：${call.slice(0, 60)}`);
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

test('the 界面大小 setting says which surfaces it controls', () => {
  const at = html.indexOf('id="ui-scale-hint"');
  assert.ok(at > 0, '要保留当前档位提示');
  const near = html.slice(at, at + 900);
  assert.ok(near.includes('浮窗'), '要写明影响桌面浮窗');
  assert.ok(near.includes('提醒弹窗'), '要写明影响提醒弹窗');
});

test('the float window toggle says its text size follows 界面大小', () => {
  const at = html.indexOf('id="float-window-hint"');
  assert.ok(at > 0);
  const block = html.slice(at, at + 600);
  assert.ok(block.includes('界面大小'), '浮窗那栏要说明字号跟随同一个设置');
});

test('there is still exactly one place to change text size', () => {
  // 只保留一个「界面大小」控件：不要再冒出一个"弹窗字号"或"浮窗字号"
  const selects = (html.match(/id="ui-scale"/g) || []).length;
  assert.equal(selects, 1, '界面上只能有一处字号设置');
  assert.equal(html.includes('toast-scale'), false, '不要新增独立的弹窗字号设置');
  assert.equal(html.includes('float-scale'), false, '不要新增独立的浮窗字号设置');
});