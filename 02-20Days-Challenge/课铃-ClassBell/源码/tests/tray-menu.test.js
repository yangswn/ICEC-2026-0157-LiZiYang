'use strict';

/**
 * 托盘右键修复的静态契约测试。
 *
 * NotifyIcon 的鼠标事件无法在单测里真实触发（需要 shell 的托盘宿主），
 * 所以这里锁住代码层面的两条约束，防止以后被改回去：
 *   1. 不能再用 tray.Click —— 它不区分左右键，右键会连带打开窗口把菜单挤掉；
 *   2. 必须用 MouseClick + 左键判断，且双击仍单独绑定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'MainForm.cs'), 'utf8');

test('tray does not bind the button-agnostic Click event', () => {
  // tray.Click += ... 会让右键也执行打开窗口，正是 1.6.2 修的那个 bug
  const bad = /tray\.Click\s*\+=/.test(source);
  assert.equal(bad, false, '不应再绑定 tray.Click（它不区分左右键）');
});

test('tray opens the window only on left button', () => {
  const at = source.indexOf('tray.MouseClick +=');
  assert.ok(at > 0, '必须用 MouseClick 才能拿到 MouseEventArgs.Button');

  const block = source.slice(at, at + 220);
  assert.ok(block.includes('MouseButtons.Left'),
    '右键不应打开窗口：MouseClick 里必须判断 MouseButtons.Left');
});

test('double click still opens the window', () => {
  assert.ok(/tray\.DoubleClick\s*\+=\s*\(s,\s*e\)\s*=>\s*ShowMain\(\)/.test(source),
    '双击打开窗口的惯例要保留');
});

test('ShowMain stays idempotent (double click fires MouseClick twice)', () => {
  const at = source.indexOf('private void ShowMain()');
  assert.ok(at > 0);
  const block = source.slice(at, at + 400);

  // 双击会先发两次 MouseClick，ShowMain 只能恢复/显示/激活，不能重建界面
  assert.ok(block.includes('Show()') && block.includes('Activate()'),
    'ShowMain 应只做显示与激活');
  assert.equal(/new MainForm|InitializeWebView/.test(block), false,
    'ShowMain 不能在每次点击时重建界面');
});
