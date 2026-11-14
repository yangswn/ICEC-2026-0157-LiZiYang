'use strict';

/**
 * 1.8.1：模型开关的交互不能把「用户表达了意愿」当成错误来报。
 *
 * 之前拨开关会同时弹：绿色「已开启」+ 红色「没有找到 qwen2.5:1.5b」；
 * 之后每次点预算还会再弹一次红色。这里锁住三条约束：
 *   1. 拨开关不弹任何 toast；
 *   2. 没模型时点预算静默跳过，不弹错误；
 *   3. 状态改用常驻静态行 + 复制安装命令。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
const ollama = require('../server/ollama.js');

/** 取某个函数的完整文本（从 function 定义到下一个顶层 function 之前）。 */
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 10);
  const nextAsync = source.indexOf('\nasync function ', start + 10);
  const candidates = [next, nextAsync].filter((i) => i > 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test('toggling the switch never shows a toast', () => {
  const start = app.indexOf("$('#set-model-estimate').addEventListener");
  assert.ok(start > 0, '找不到开关的事件处理器');

  const block = app.slice(start, start + 700);
  assert.equal(/toast\(/.test(block), false, '拨开关不能弹 toast（成功和失败都不该弹）');
  assert.ok(block.includes('renderModelStatus'), '拨开关后要刷新状态行');
});

test('missing model is not reported as an error on the normal path', () => {
  const refine = sliceFunction(app, 'refineTonight');
  assert.ok(refine.includes('MODEL_NOT_READY'), '要识别这个状态码');

  // 关键：MODEL_NOT_READY / MODEL_DISABLED 分支里不许出现 toast
  const branchAt = refine.indexOf("result.code === 'MODEL_NOT_READY'");
  assert.ok(branchAt > 0);
  const branch = refine.slice(branchAt, branchAt + 320);
  assert.equal(/toast\(/.test(branch), false, '没装模型时点预算不该弹提示');
});

test('status is a static row under the switch, not a toast', () => {
  assert.ok(html.includes('id="model-estimate-status"'), '要有常驻的状态行');
  assert.ok(html.includes('model-status'), '状态行要有自己的样式类');

  // 状态行文案：就绪 / 未检测到
  assert.ok(app.includes('已就绪') || app.includes('✓'), '就绪状态要有明确文案');
  assert.ok(app.includes('未检测到'), '缺模型要显示「未检测到」');
});

test('copy button copies the pull command for 1.5b', () => {
  assert.ok(app.includes('复制安装命令'), '要有复制按钮');
  assert.ok(app.includes('copyPullCommand'), '要有复制实现');
  assert.ok(app.includes('ollama pull qwen2.5:1.5b'), '复制的内容必须是 1.5b 的 pull 命令');
  assert.ok(app.includes('已复制'), '复制成功要给一句轻提示');
});

test('description text reflects the 1.5b footprint, not 7B', () => {
  // 1.8.0 已经只用 1.5b（约 1GB），不能再写 7B 的 5GB
  assert.equal(html.includes('5GB 以上内存'), false, '不该再写 5GB（那是 7B 的大小）');
  assert.ok(html.includes('1GB'), '应写约 1GB');
  assert.ok(html.includes('qwen2.5:1.5b'), '要点名 1.5b');
});

test('status endpoint reports availability without loading the model', async () => {
  const info = await ollama.status();
  assert.equal(typeof info.available, 'boolean');
  assert.equal(info.model, 'qwen2.5:1.5b');
  assert.equal(info.pullCommand, 'ollama pull qwen2.5:1.5b');
  assert.ok(Array.isArray(info.installed));
});