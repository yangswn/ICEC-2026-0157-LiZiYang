'use strict';

/**
 * 本机 Ollama 估时（可选功能，默认不启用）。
 *
 * 只用 qwen2.5:1.5b（约 1GB）。7b/14b 能估得更"像人"，但要 5~9GB 内存，
 * 16GB 的机器跑起来整台卡顿 —— 一个帮人省时间的功能不该有这个代价。
 * 找不到 1.5b 就明确提示去 pull，**不自动降级**用大模型。
 *
 * 一次问完全部任务（上限 20 条）：一条 prompt 要一个 JSON 数组。
 * 分批反而更慢，而且 1.5b 的输出很短，一次问完不会有输出截断问题。
 */

const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLASSBELL_OLLAMA_PORT) || 11434;
const MODEL = 'qwen2.5:1.5b';
const TIMEOUT_MS = 30000;
const MAX_TASKS = 20;
const NUM_PREDICT = 400;

class ModelMissingError extends Error {
  constructor(installed) {
    super(`没有找到 ${MODEL}。请先在终端执行：ollama pull ${MODEL}`);
    this.code = 'MODEL_NOT_READY';
    this.installed = installed || [];
  }
}

function request(pathname, { method = 'GET', body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`ollama ${pathname} -> ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new Error('ollama returned non-json')); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('ollama timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 列出已安装的模型名（去掉 :latest 方便比对）。 */
async function listModels() {
  const tags = await request('/api/tags', { timeout: 4000 });
  return (tags && Array.isArray(tags.models) ? tags.models : [])
    .map((m) => m && m.name)
    .filter(Boolean);
}

/** 1.5b 是否已安装（接受 qwen2.5:1.5b 与 qwen2.5:1.5b-xxx 这类变体）。 */
function hasModel(names, wanted = MODEL) {
  const base = wanted.toLowerCase();
  return names.some((n) => {
    const name = String(n).toLowerCase().replace(/:latest$/, '');
    return name === base || name.startsWith(base + '-');
  });
}

function buildPrompt(tasks) {
  const lines = tasks.map((t, i) => {
    const parts = [`${i + 1}. 课程：${t.course || '未知'}`, `标题：${t.title}`];
    if (t.questionCount) parts.push(`题量：${t.questionCount} 题`);
    if (t.noDeadline) parts.push('截止：无');
    else if (t.dueAt) parts.push(`截止：${String(t.dueAt).slice(0, 10)}`);
    return parts.join('｜');
  });

  return [
    '你是中国大学的助教，估算学生完成每项作业需要多少分钟。',
    '只估时间，不要排序、不要给建议。',
    '参考：客观题每题约 1.5 分钟，主观题/报告类每题约 8 分钟，打开与提交约 5 分钟。',
    '每条给一个 15 到 180 之间的整数分钟数。',
    '只输出 JSON 数组，不要解释：{"estimates":[{"i":1,"minutes":45}]}',
    '',
    ...lines
  ].join('\n');
}

/** 从模型回复里抠出 JSON（有时会包 markdown 代码块）。 */
function parseReply(text, tasks) {
  const raw = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return new Map();

  let parsed = null;
  try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch (_) { return new Map(); }

  const list = Array.isArray(parsed) ? parsed
    : (Array.isArray(parsed.estimates) ? parsed.estimates : []);
  const map = new Map();
  for (const row of list) {
    if (!row) continue;
    const index = Number(row.i ?? row.index);
    const task = Number.isFinite(index) ? tasks[index - 1] : null;
    if (!task) continue;
    const minutes = Number(row.minutes ?? row.min ?? row.m);
    if (Number.isFinite(minutes) && minutes > 0) map.set(task.id, minutes);
  }
  return map;
}

/**
 * 估一批（一次请求，最多 20 条）。
 * @param {Array} tasks
 * @returns {Promise<Map<string, number>>}
 * @throws {ModelMissingError} 没有 1.5b 时抛这个（调用方据此提示去 pull）
 */
async function askModel(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return new Map();

  const batch = tasks.slice(0, MAX_TASKS);
  const names = await listModels();
  if (!hasModel(names)) throw new ModelMissingError(names);

  const reply = await request('/api/generate', {
    method: 'POST',
    timeout: TIMEOUT_MS,
    body: {
      model: MODEL,
      prompt: buildPrompt(batch),
      stream: false,
      // 20 条 × 每条十几 token，400 够用；太小会把 JSON 截断成半截
      options: { temperature: 0.2, num_predict: NUM_PREDICT }
    }
  });

  return parseReply(reply && reply.response, batch);
}

/** 探测能不能用（只看 1.5b 在不在，不去加载模型）。 */
async function isAvailable() {
  try {
    const names = await listModels();
    return hasModel(names);
  } catch (_) {
    return false;
  }
}

module.exports = {
  askModel,
  isAvailable,
  listModels,
  hasModel,
  buildPrompt,
  parseReply,
  ModelMissingError,
  MODEL,
  TIMEOUT_MS,
  MAX_TASKS,
  NUM_PREDICT
};
