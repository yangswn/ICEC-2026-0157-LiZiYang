'use strict';

/**
 * 1.11.1：透明度滑杆拖动时浮窗实时跟手。
 *
 * 核心是把两条路分开：
 *   - input  → 预览（只推宿主，不写设置、不写盘、不广播）
 *   - change → 落盘（走 updateSettings，重启后仍然生效）
 *
 * 这里锁住「预览不落盘」这件事，否则以后有人图省事把 input 也接上
 * saveFloatOptions，就又回到"拖一下写一次 data.json"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'bridge.js'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');
const floatCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'FloatWindow.cs'), 'utf8');

/** 取出某个函数/方法的源码片段（从签名到下一个顶层右括号）。 */
function sliceFrom(text, signature, length = 1400) {
  const at = text.indexOf(signature);
  assert.ok(at > 0, `找不到 ${signature}`);
  return text.slice(at, at + length);
}

/* ------------------------------------------------------- 预览通道 */

test('bridge exposes a preview channel that does not write settings', () => {
  const block = sliceFrom(bridgeJs, 'previewFloatOpacity:', 220);
  assert.ok(block.includes("host('applyFloatOptions', null, value)"),
    '预览要走宿主消息，count 传 null 表示不变');
  assert.equal(block.includes('request(POST'), false, '预览不能走 /api/settings');
  assert.equal(block.includes('updateSettings'), false, '预览不能复用 updateSettings');
});

test('dragging previews, releasing persists', () => {
  // 精确切出两个 handler：input 从自己开始到 change 开始之前
  const inputAt = appJs.indexOf("$('#float-opacity').addEventListener('input'");
  const changeAt = appJs.indexOf("$('#float-opacity').addEventListener('change'");
  assert.ok(inputAt > 0 && changeAt > inputAt, '两个 handler 都要在');
  const inputBlock = appJs.slice(inputAt, changeAt);
  const changeBlock = appJs.slice(changeAt, changeAt + 320);

  assert.ok(inputBlock.includes('scheduleOpacityPreview'), 'input 要触发预览');
  assert.equal(inputBlock.includes('saveFloatOptions'), false, 'input 阶段不许落盘');
  assert.ok(changeBlock.includes('saveFloatOptions'), 'change 要落盘');
  assert.equal(changeBlock.includes('scheduleOpacityPreview'), false, 'change 不再需要预览');
});

test('preview is coalesced per animation frame and deduped', () => {
  const block = sliceFrom(appJs, 'function scheduleOpacityPreview', 900);
  assert.ok(block.includes('requestAnimationFrame'), '按帧合并高频 input');
  assert.ok(block.includes('opacityPreviewFrame !== null'), '同一帧只排一次');
  assert.ok(block.includes('value === opacityPreviewSent'), '同一个值不重复发');
  assert.ok(block.includes('api.previewFloatOpacity'), '实际调用预览通道');
});

test('releasing resets the preview dedupe so the same value can be previewed again', () => {
  const block = sliceFrom(appJs, 'function saveFloatOptions', 420);
  assert.ok(block.includes('opacityPreviewSent = Math.round'), '落盘后要同步预览判重');
});

/* ------------------------------------------------------- 宿主侧 */

test('preview does not relayout when the task count is unchanged', () => {
  const block = sliceFrom(mainCs, 'case "applyFloatOptions"', 2600);
  assert.ok(block.includes('bool countChanged = wantCount != floatTaskCountValue'));
  assert.ok(block.includes('if (countChanged) SyncFloatWindow(latestStateNode);'),
    '条数没变就别重排——拖动时每帧重排会白烧 CPU');
  assert.ok(block.includes('if (countChanged) floatWindow.SetTaskCount(wantCount);'));
});

test('float window is raised to front during preview without stealing focus', () => {
  assert.ok(mainCs.includes('floatWindow.KeepOnTopWithoutFocus()'), '拖动时要把浮窗提到最前');
  const block = sliceFrom(floatCs, 'internal void KeepOnTopWithoutFocus', 400);
  assert.ok(block.includes('SetWindowPos'), '用 SetWindowPos 改 z 序');
  assert.ok(block.includes('SWP_NOACTIVATE'), '绝不能激活窗口');
  assert.equal(/\.Activate\(\)/.test(floatCs), false, '浮窗里始终不许调 Activate()');
});

test('opacity preview still goes through the documented floor', () => {
  // 宿主仍然把值夹到 0.30~1.00，预览不能绕过下限
  const block = sliceFrom(mainCs, 'case "applyFloatOptions"', 2600);
  assert.ok(block.includes('FloatWindow.MinOpacity'), '下限校验还在');
});

/* ------------------------------------------------------- 其它路径不受影响 */

test('count buttons still persist immediately (they are discrete, one click)', () => {
  const block = sliceFrom(appJs, "$('#float-count').addEventListener('click'", 320);
  assert.ok(block.includes('saveFloatOptions({ floatTaskCount'), '条数是点击事件，直接落盘');
});

test('fade still uses the user opacity as baseline', () => {
  const block = sliceFrom(floatCs, 'private void FadeTick', 700);
  assert.ok(block.includes('baseOpacity - fadeStep'), '淡出基线仍是用户设置值');
});