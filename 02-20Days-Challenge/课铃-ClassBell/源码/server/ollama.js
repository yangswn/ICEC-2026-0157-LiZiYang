'use strict';

/**
 * 本机 Ollama 估时。
 *
 * 只问时间，不问顺序 —— 让模型排过序，它把「已逾期三天」排在「18 小时后截止」后面，
 * 和规则完全相反。估时错了用户自己能看出来，排序错了整天都在做错事。
 *
 * 整批一次请求 + 30 秒硬超时：一条一条问会慢到没法用。
 * 任何失败都抛错，由调用方整批回退到规则，不在这里做逐条降级。
 */

const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLASSBELL_OLLAMA_PORT) || 11434;
const TIMEOUT_MS = 30000;

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

/** 找一个能用的模型：优先 qwen，其次第一个已安装的。 */
async function pickModel() {
  const tags = await request('/api/tags', { timeout: 4000 });
  const names = (tags && Array.isArray(tags.models) ? tags.models : [])
    .map((m) => m && m.name)
    .filter(Boolean);
  if (!names.length) return null;
  return names.find((n) => /qwen/i.test(n)) || names[0];
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
    '你是中国大学的助教，正在估算学生完成每项作业需要多少分钟。',
    '只估算时间，不要判断顺序、不要排序、不要给建议。',
    '参考：客观题每题约 1.5 分钟，主观题/报告类每题约 8 分钟，打开和提交约 5 分钟。',
    `每条给一个 15 到 180 之间的整数分钟数。只输出 JSON：{"estimates":[{"i":1,"minutes":45}]}`,
    '',
    ...lines
  ].join('\n');
}

/** 从模型回复里抽出 JSON（模型有时会包一层 markdown 代码块）。 */
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
    const index = Number(row.i ?? row.index ?? row.id);
    const task = Number.isFinite(index) ? tasks[index - 1] : null;
    if (!task) continue;
    const minutes = Number(row.minutes ?? row.min ?? row.m);
    if (Number.isFinite(minutes) && minutes > 0) map.set(task.id, minutes);
  }
  return map;
}

/** 每次请求最多带几条：太多会让单次推理超过总预算。 */
const CHUNK_SIZE = 5;

/**
 * 让模型估一批任务（内部按 CHUNK_SIZE 分批，共用 30 秒总预算）。
 * @param {Array} tasks
 * @returns {Promise<Map<string, number>>} 拿到多少算多少；一条都没拿到才抛错
 */
async function askModel(tasks, options = {}) {
  if (!Array.isArray(tasks) || !tasks.length) return new Map();

  const model = options.model || await pickModel();
  if (!model) throw new Error('ollama has no model installed');

  const deadline = Date.now() + TIMEOUT_MS;
  const merged = new Map();

  for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
    const chunk = tasks.slice(i, i + CHUNK_SIZE);
    const remaining = deadline - Date.now();
    // 剩下的时间不够问一批了，就到这儿 —— 已经拿到的仍然有用
    if (remaining < 4000) break;

    try {
      const reply = await request('/api/generate', {
        method: 'POST',
        timeout: Math.min(remaining, TIMEOUT_MS),
        body: {
          model,
          prompt: buildPrompt(chunk),
          stream: false,
          options: { temperature: 0.2 }
        }
      });
      const part = parseReply(reply && reply.response, chunk);
      for (const [id, minutes] of part) merged.set(id, minutes);
    } catch (_) {
      // 这一批超时或返回不可用：继续下一批没有意义（时间也不够了）
      break;
    }
  }

  if (!merged.size) throw new Error('ollama reply had no usable estimates');
  return merged;
}

/** 探测本机有没有可用的 Ollama（不阻塞太久）。 */
async function isAvailable() {
  try {
    const model = await pickModel();
    return Boolean(model);
  } catch (_) {
    return false;
  }
}

module.exports = { askModel, isAvailable, pickModel, parseReply, buildPrompt, TIMEOUT_MS, CHUNK_SIZE };
