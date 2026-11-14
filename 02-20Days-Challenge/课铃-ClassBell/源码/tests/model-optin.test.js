'use strict';

/**
 * 1.8.0 任务一：模型估时默认关闭。
 *
 * 1.7.0 实测：30 题的测试题，模型和规则都算 45 分钟（完全一致）；
 * 但整批 11 条模型要 29.5 秒、吃 5~6GB 内存，规则只要 6 毫秒。
 * 一个帮用户省时间的功能，代价是让电脑变卡 —— 所以默认走规则，模型变成可选开关，
 * 而且只允许 1.5b（约 1GB），找不到就提示去 pull，不偷偷改用 7b/14b。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { Store } = require('../server/store.js');
const ollama = require('../server/ollama.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'model-'));
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

test('model estimation is off by default', () => {
  const store = makeStore();
  assert.equal(store.state.settings.useModelEstimate, false, '默认必须是关闭的');
});

test('only qwen2.5:1.5b is accepted, never a bigger model', () => {
  assert.equal(ollama.MODEL, 'qwen2.5:1.5b');
  assert.equal(ollama.hasModel(['qwen2.5:1.5b']), true);
  assert.equal(ollama.hasModel(['qwen2.5:1.5b-instruct-q4_K_M']), true, '同一模型的量化变体也算');

  // 关键：装了大模型不等于能用 —— 直接换成 7b 正是把电脑搞卡的原因
  assert.equal(ollama.hasModel(['qwen2.5:7b']), false);
  assert.equal(ollama.hasModel(['qwen2.5:14b', 'qwen2.5:7b']), false);
  assert.equal(ollama.hasModel([]), false);
});

test('missing 1.5b raises MODEL_NOT_READY with a pull hint', () => {
  const error = new ollama.ModelMissingError(['qwen2.5:7b']);
  assert.equal(error.code, 'MODEL_NOT_READY');
  assert.match(error.message, /ollama pull qwen2\.5:1\.5b/);
  assert.deepEqual(error.installed, ['qwen2.5:7b']);
});

test('one prompt carries at most 20 tasks and num_predict is 400', () => {
  assert.equal(ollama.MAX_TASKS, 20);
  assert.equal(ollama.NUM_PREDICT, 400);

  const tasks = Array.from({ length: 3 }, (_, i) => ({
    id: `t${i}`, title: `作业${i}`, course: '工程数学', questionCount: 30
  }));
  const prompt = ollama.buildPrompt(tasks);
  assert.ok(prompt.includes('JSON'), '要明确要求只输出 JSON');
  assert.ok(prompt.includes('作业0') && prompt.includes('作业2'), '每条任务都要进 prompt');
});

test('reply parsing accepts both fenced and bare JSON, and rejects garbage', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }];
  const fenced = '```json\n{"estimates":[{"i":1,"minutes":45},{"i":2,"minutes":15}]}\n```';
  const bare = '{"estimates":[{"i":1,"minutes":60}]}';

  assert.deepEqual([...ollama.parseReply(fenced, tasks)], [['a', 45], ['b', 15]]);
  assert.deepEqual([...ollama.parseReply(bare, tasks)], [['a', 60]]);
  assert.equal(ollama.parseReply('抱歉，我无法估算', tasks).size, 0);
});

test('server never asks the model while building the rule estimates', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const at = source.indexOf('async function ensureEstimates');
  assert.ok(at > 0);

  // ensureEstimates 里必须显式 useModel: false，且不能出现 ollama.askModel
  const block = source.slice(at, at + 1600);
  assert.ok(block.includes('useModel: false'), '规则阶段必须显式禁用模型');
  assert.equal(/ollama\.askModel/.test(block), false, '规则阶段不许调用模型');

  // 模型只出现在 refineEstimates 里
  const refineAt = source.indexOf('async function refineEstimates');
  assert.ok(refineAt > 0, '应该有独立的精估入口');
  assert.ok(source.slice(refineAt, refineAt + 1200).includes('ollama.askModel'));
});

test('refine route reports disabled instead of silently calling the model', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const at = source.indexOf("'/api/estimate/refine'");
  assert.ok(at > 0);
  const block = source.slice(at, at + 500);
  assert.ok(block.includes('useModelEstimate'), '要先看开关');
  assert.ok(block.includes('MODEL_DISABLED'), '开关关闭时返回明确状态，不要白等 30 秒');
});

test('settings API accepts the toggle', () => {
  const store = makeStore();
  const updated = store.updateSettings({ useModelEstimate: true });
  assert.equal(updated.useModelEstimate, true);
  const off = store.updateSettings({ useModelEstimate: false });
  assert.equal(off.useModelEstimate, false);
});
