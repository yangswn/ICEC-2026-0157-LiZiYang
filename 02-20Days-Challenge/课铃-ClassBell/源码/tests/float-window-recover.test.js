'use strict';
/**
 * 1.9.1：浮窗隐藏后的恢复入口 + 隐藏必须是真的隐藏。
 *
 * 核心是分清两个状态：
 *   settings.floatWindow  是否启用（长期偏好，写盘）
 *   floatHiddenByUser     这次不想看（临时，只在本次运行内有效，不写盘）
 */
const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..');

const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'bridge.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
const store = require('../server/store.js');

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------- 隐藏 = 真的隐藏 */

test('manual hide is a runtime-only flag, never written to settings', () => {
  assert.ok(mainCs.includes('private bool floatHiddenByUser'), '要有一个运行时字段');
  assert.ok(floatCs.includes('owner.HideFloatWindow'), '右键隐藏走 HideFloatWindow');

  // 这个标记不能进设置白名单，也不能有默认值 —— 它只在本次运行内有效
  const storeSrc = fs.readFileSync(path.join(repoRoot, 'server', 'store.js'), 'utf8');
  assert.equal(storeSrc.includes('floatHiddenByUser'), false, '临时隐藏不写盘');
});

test('poll never reopens a window the user hid', () => {
  const at = mainCs.indexOf('private void SyncFloatWindow');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 900);

  assert.ok(block.includes('floatHiddenByUser'), '同步时必须先看这个标记');
  // 关键：两个条件都要判，只判 floatWindowEnabled 就是上一版的 bug
  assert.ok(/!\s*floatWindowEnabled\s*\|\|\s*floatHiddenByUser/.test(block),
    '必须是「未启用 或 用户隐藏过」才不显示');
});

test('showing the float clears the manual-hide flag', () => {
  const at = mainCs.indexOf('internal void ShowFloatWindow');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 700);
  assert.ok(block.includes('floatHiddenByUser = false'), '重新显示要清标记');
  assert.ok(block.includes('ResolveFloatPosition'), '要回到记住的位置');
});

/* --------------------------------------------- 恢复入口 */

test('tray menu has a checkable 桌面浮窗 item', () => {
  assert.ok(mainCs.includes('new ToolStripMenuItem("桌面浮窗")'), '托盘菜单要有这一项');
  assert.ok(/CheckOnClick\s*=\s*true/.test(mainCs), '要能勾选');

  // 放在「打开课铃」后面（用户第一直觉就是去托盘找）
  const openAt = mainCs.indexOf('menu.Items.Add("打开课铃');
  const itemAt = mainCs.indexOf('new ToolStripMenuItem("桌面浮窗")');
  assert.ok(openAt > 0 && itemAt > openAt, '应排在「打开课铃」之后');
});

test('tray toggle applies immediately and persists the preference', () => {
  const at = mainCs.indexOf('floatTrayItem.CheckedChanged');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 900);
  assert.ok(block.includes('ShowFloatWindow(true)'), '勾上要立刻显示并写回设置');
  assert.ok(block.includes('PersistFloatWindowSetting(false)'), '取消要立刻写回设置');
  assert.ok(block.includes('floatWindow.Hide()'), '取消要立刻隐藏');
});

test('settings switch reaches the host immediately', () => {
  // 前端：改设置时通知宿主
  assert.ok(bridgeJs.includes("host('applyFloatWindow'"), '前端要立刻通知宿主');
  // 宿主：有对应命令，且立刻显示/隐藏，不等轮询
  const at = mainCs.indexOf('case "applyFloatWindow"');
  assert.ok(at > 0, '宿主要有 applyFloatWindow 命令');
  const block = mainCs.slice(at, at + 700);
  assert.ok(block.includes('ShowFloatWindow(false)'), '打开要立刻显示');
  assert.ok(block.includes('floatWindow.Hide()'), '关闭要立刻隐藏');
});

test('tray and settings stay in sync', () => {
  assert.ok(mainCs.includes('SyncFloatTrayCheck'), '要有一个同步勾选状态的方法');
  const at = mainCs.indexOf('private void SyncFloatTrayCheck');
  const block = mainCs.slice(at, at + 300);
  assert.ok(block.includes('floatTrayItem.Checked'), '同步的是托盘勾选');
  // 轮询里也要刷一次，设置页改的才会反映到托盘
  const pollAt = mainCs.indexOf('private async Task PollStatusAsync');
  assert.ok(mainCs.slice(pollAt, pollAt + 2600).includes('SyncFloatTrayCheck'), '轮询里要同步托盘勾选');
});

/* --------------------------------------------- 用户提示 */

test('hiding the float tells the user how to bring it back', () => {
  const at = mainCs.indexOf('private void ShowFloatHiddenToast');
  assert.ok(at > 0);
  const block = mainCs.slice(at, at + 700);
  assert.ok(block.includes('浮窗已隐藏'), '标题要直说');
  assert.ok(block.includes('托盘'), '要说明去托盘找');
  assert.ok(/4000/.test(block), '4 秒后自己消失');
});

test('settings page explains the fullscreen behaviour', () => {
  assert.ok(html.includes('id="float-window-hint"'), '要有那行小字');
  const at = html.indexOf('id="float-window-hint"');
  const block = html.slice(at, at + 400);
  assert.ok(block.includes('全屏'), '要提到全屏');
  assert.ok(block.includes('自动隐藏'), '要说明会自动隐藏');
});

/* --------------------------------------------- 设置层不变的部分 */

test('floatWindow setting keeps its default and sanitisation', () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'float191-'));
  fs.mkdirSync(dir, { recursive: true });
  const s = new store.Store(dir);
  assert.equal(s.state.settings.floatWindow, true);
  assert.equal(s.updateSettings({ floatWindow: false }).floatWindow, false);
  assert.equal(s.updateSettings({ floatWindowPos: '700,420' }).floatWindowPos, '700,420');
});