'use strict';

/**
 * 字号：三处各自独立，控件排在同一块里（1.10.3）。
 *
 * 上一版把三处绑在一个「界面大小」上；用户要的是分开调、但控件放一起。
 * 这里锁住「独立」和「并排」两件事，防止又被合并回一个。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'bridge.js'), 'utf8');
const mainCs = fs.readFileSync(path.join(repoRoot, 'desktop', 'MainForm.cs'), 'utf8');
const { Store } = require('../server/store.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'scale-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/* ------------------------------------------------------------- 设置层 */

test('the three surfaces have their own scale setting', () => {
  const store = makeStore();
  const s = store.state.settings;
  assert.equal(typeof s.uiScale, 'number', '主界面');
  assert.equal(typeof s.floatScale, 'number', '桌面浮窗');
  assert.equal(typeof s.toastScale, 'number', '提醒弹窗');
});

test('changing one scale leaves the other two alone', () => {
  const store = makeStore();
  const after = store.updateSettings({ floatScale: 1.6 });
  assert.equal(after.floatScale, 1.6);
  assert.equal(after.uiScale, 1.1, '改浮窗不该动主界面');
  assert.equal(after.toastScale, 1.1, '改浮窗不该动弹窗');

  const after2 = store.updateSettings({ toastScale: 0.9 });
  assert.equal(after2.toastScale, 0.9);
  assert.equal(after2.floatScale, 1.6, '改弹窗不该动浮窗');
});

test('only the six offered steps are accepted', () => {
  const store = makeStore();
  store.updateSettings({ floatScale: 1.4 });
  assert.equal(store.updateSettings({ floatScale: 2.5 }).floatScale, 1.4, '超范围保留上一个合法值');
  assert.equal(store.updateSettings({ toastScale: 0.3 }).toastScale, 1.1, '低于最小档回退默认');
});

/* ------------------------------------------------------------- 界面 */

test('three scale controls sit in one block, one row each', () => {
  assert.ok(html.includes('class="scale-matrix"'), '三个控件要在同一个容器里');
  const at = html.indexOf('class="scale-matrix"');
  const block = html.slice(at, at + 1200);

  for (const id of ['ui-scale', 'float-scale', 'toast-scale']) {
    assert.ok(block.includes(`id="${id}"`), `同一块里要有 ${id}`);
  }
  // 每行都有自己的标题，用户一眼能看出调的是哪儿
  assert.ok(block.includes('主界面') && block.includes('桌面浮窗') && block.includes('提醒弹窗'));
});

test('each control shows its own current value, not a shared one', () => {
  for (const id of ['ui-scale-hint', 'float-scale-hint', 'toast-scale-hint']) {
    assert.ok(html.includes(`id="${id}"`), `要有独立的数值显示 ${id}`);
  }
  assert.ok(appJs.includes("markScale('#float-scale', '#float-scale-hint'"), '浮窗单独刷自己的显示');
  assert.ok(appJs.includes("markScale('#toast-scale', '#toast-scale-hint'"), '弹窗单独刷自己的显示');
});

test('each control writes its own setting', () => {
  assert.ok(appJs.includes('buildScaleOptions(\'#ui-scale\')'));
  assert.ok(appJs.includes('buildScaleOptions(\'#float-scale\')'));
  assert.ok(appJs.includes('buildScaleOptions(\'#toast-scale\')'));
  // 浮窗/弹窗通过 target 决定写哪个键
  assert.ok(appJs.includes("target === 'float' ? 'floatScale' : 'toastScale'"));
});

/* ------------------------------------------------------------- 宿主 */

test('host keeps two separate scale values and applies the right one', () => {
  assert.ok(mainCs.includes('private float floatScaleValue'), '浮窗自己的值');
  assert.ok(mainCs.includes('private float toastScaleValue'), '弹窗自己的值');
  assert.ok(mainCs.includes('CurrentFloatScale'), '浮窗读自己的');
  assert.ok(mainCs.includes('CurrentToastScale'), '弹窗读自己的');

  // 浮窗用只浮窗的；弹窗调用只弹窗的
  assert.equal(mainCs.includes('ApplyScale(CurrentToastScale())'), false, '浮窗不能用弹窗的字号');
  assert.equal(/TrayToastForm\([^;]*CurrentFloatScale/.test(mainCs), false, '弹窗不能用浮窗的字号');
  assert.ok(mainCs.includes('ApplyScale(CurrentFloatScale())'));
  assert.equal((mainCs.match(/CurrentToastScale\(\)/g) || []).length >= 2, true, '两处弹窗都要用弹窗字号');
});

test('bridge notifies the host per surface', () => {
  assert.ok(bridgeJs.includes("host('applySurfaceScale', 'float'"), '浮窗单独通知');
  assert.ok(bridgeJs.includes("host('applySurfaceScale', 'toast'"), '弹窗单独通知');
  assert.equal(bridgeJs.includes("host('applyUiScale'"), false, '旧的合并命令要退场');

  const at = mainCs.indexOf('case "applySurfaceScale"');
  assert.ok(at > 0, '宿主要有对应命令');
  const block = mainCs.slice(at, at + 900);
  assert.ok(block.includes('"float"') && block.includes('"toast"'), '要区分作用对象');
});

test('changing a scale still takes effect immediately (no 30s wait)', () => {
  // 宿主命令里直接改值，不依赖下一轮轮询
  const at = mainCs.indexOf('case "applySurfaceScale"');
  const block = mainCs.slice(at, at + 900);
  assert.ok(block.includes('floatWindow.ApplyScale(scaleValue)'), '浮窗立刻重排');
  assert.ok(block.includes('toastScaleValue = scaleValue'), '弹窗下一次就用新值');
});