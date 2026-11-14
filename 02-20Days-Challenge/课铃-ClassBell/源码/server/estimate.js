'use strict';

/**
 * 估时：只回答「这条大概要多久」，不做排序。
 *
 * 排序交给规则（截止紧迫度），因为模型排过一次就翻车了 —— 三条待办里
 * 它挑了「18 小时后截止」而不是「已逾期三天」，和规则完全相反。
 * 估时错一点用户自己能判断，排序错一次整天都在做错事。
 *
 * 四级来源，从准到粗：
 *   history  同类任务做过 ≥3 次 → 取实际耗时中位数（最可信）
 *   model    本机 Ollama 估的
 *   rule     题量 × 每题系数
 *   guess    标题关键词 / 默认值（最粗）
 */

const MIN_MINUTES = 15;
const MAX_MINUTES = 180;
const MINUTES_PER_QUESTION = 1.5;
const DEFAULT_MINUTES = 30;
const HISTORY_MIN_SAMPLES = 3;

/** 题目数量按区间分组：20~40 题这种量级才值得互相参考。 */
function bucketOf(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n <= 5) return '1-5';
  if (n <= 19) return '6-19';
  if (n <= 40) return '20-40';
  if (n <= 80) return '41-80';
  return '80+';
}

function clampMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, n));
}

/** 中位数（偶数个取中间两个的平均，四舍五入）。 */
function median(values) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

function normalizeCourse(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 按题量算：每题 1.5 分钟，最少 15 分钟。
 * 30 题 → 45 分钟；1 题 → 15 分钟（低于 15 的题量撑不起一次完整的打开+提交）。
 */
function ruleMinutes(task) {
  const count = Number(task && task.questionCount);
  if (!Number.isFinite(count) || count <= 0) return null;
  // 我们只采到总题量，分不出客观/主观，所以按客观题的系数算 —— 偏低但可预期，
  // 用户看到"大概 45 分钟"总比看到一个编出来的数字好。
  return clampMinutes(count * MINUTES_PER_QUESTION);
}

/**
 * 按标题关键词兜底。顺序有讲究：越具体的越先匹配
 * （"测试报告"里既有测试也有报告，按报告算更贴近实际）。
 */
function guessMinutes(task) {
  const title = String((task && task.title) || '');
  if (/报告|论文|总结|汇报/.test(title)) return 60;
  if (/测试|测验|考试|quiz/i.test(title)) return 30;
  if (/工作页|作业|练习/.test(title)) return 15;

  const count = Number(task && task.questionCount);
  if (Number.isFinite(count) && count > 0) return ruleMinutes(task);
  return DEFAULT_MINUTES;
}

/**
 * 历史中位数：同一门课 + 题量区间相近的已完成任务。
 * 少于 3 个样本就不用这层 —— 2 个样本的中位数基本等于抛硬币。
 */
function historyMinutes(task, finished) {
  const course = normalizeCourse(task && task.course);
  if (!course) return null;
  const bucket = bucketOf(task && task.questionCount);

  const samples = (finished || []).filter((t) => {
    if (!t || !Number.isFinite(Number(t.actualMinutes)) || Number(t.actualMinutes) <= 0) return false;
    if (normalizeCourse(t.course) !== course) return false;
    // 题量已知就要求同一量级；题量未知的任务只能和同样未知的比
    if (bucket) return bucketOf(t.questionCount) === bucket;
    return !bucketOf(t.questionCount);
  });

  if (samples.length < HISTORY_MIN_SAMPLES) return null;
  const result = median(samples.map((t) => Number(t.actualMinutes)));
  return result ? clampMinutes(result) : null;
}

/**
 * 一次估一批：按 history → model → rule → guess 逐级回退。
 *
 * @param {Array} targets 需要估时的任务
 * @param {{finished?: Array, askModel?: Function, useModel?: boolean}} options
 *   askModel：(tasks) => Promise<Map<id, minutes>>，抛错就整批回退到规则
 * @returns {Promise<Map<string,{minutes:number,source:string}>>}
 */
async function estimateTasks(targets, options = {}) {
  const result = new Map();
  const finished = options.finished || [];
  const pending = [];

  for (const task of targets || []) {
    if (!task || !task.id) continue;
    const fromHistory = historyMinutes(task, finished);
    if (fromHistory) {
      result.set(task.id, { minutes: fromHistory, source: 'history' });
      continue;
    }
    pending.push(task);
  }

  let fromModel = new Map();
  if (pending.length && options.useModel && typeof options.askModel === 'function') {
    try {
      // 模型整批超时/报错就整批回退，不逐条重试 —— 逐条重试会让一批拖到好几分钟
      fromModel = (await options.askModel(pending)) || new Map();
    } catch (_) {
      fromModel = new Map();
    }
  }

  for (const task of pending) {
    // 模型给出 1~180 之外的值就当它没估 —— 夹到 180 等于把离谱当合理
    const rawModel = Number(fromModel.get(task.id));
    const modelValue = Number.isFinite(rawModel) && rawModel > 0 && rawModel <= MAX_MINUTES
      ? clampMinutes(rawModel)
      : null;
    if (modelValue) {
      result.set(task.id, { minutes: modelValue, source: 'model' });
      continue;
    }
    const byRule = ruleMinutes(task);
    if (byRule) {
      result.set(task.id, { minutes: byRule, source: 'rule' });
      continue;
    }
    result.set(task.id, { minutes: guessMinutes(task), source: 'guess' });
  }

  return result;
}

/** 给界面看的来源说明。 */
const SOURCE_HINT = {
  history: '按你以前做同类任务的实际耗时',
  model: '模型估的',
  rule: '按题量算',
  guess: '按标题和平均值估的'
};

/**
 * 紧迫度排序：逾期最久的排最前，其次截止时间最近的，长期任务垫底。
 * 纯规则 —— 让模型排过序，它把「18 小时后截止」放到了「已逾期三天」前面。
 */
function urgencySort(tasks, now = Date.now()) {
  const weight = (t) => {
    if (t.status === 'missed') return 0;
    if (!t.noDeadline && Date.parse(t.dueAt) < now) return 1;
    if (t.noDeadline) return 3;
    return 2;
  };
  return [...tasks].sort((a, b) => {
    const diff = weight(a) - weight(b);
    if (diff !== 0) return diff;
    if (weight(a) === 3) return String(a.title).localeCompare(String(b.title));
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  });
}

/**
 * 按预算挑出「今晚能做完的几条」。
 * 放不下的跳过而不是直接停 —— 后面可能还有更短的能塞进去，
 * 但总数绝不超预算（超了就等于告诉用户「这些能做完」然后做不完）。
 */
function planTonight(tasks, estimates, budget, now = Date.now()) {
  const limit = Math.max(MIN_MINUTES, Number(budget) || 120);
  const items = [];
  let used = 0;

  for (const task of urgencySort(tasks, now)) {
    const hit = (estimates && estimates.get(task.id)) || { minutes: DEFAULT_MINUTES, source: 'guess' };
    if (used + hit.minutes > limit) continue;
    used += hit.minutes;
    items.push({
      id: task.id,
      title: task.title,
      course: task.course || '',
      dueAt: task.noDeadline ? null : task.dueAt,
      noDeadline: Boolean(task.noDeadline),
      questionCount: task.questionCount || null,
      minutes: hit.minutes,
      source: hit.source
    });
  }

  return { budget: limit, used, items };
}

module.exports = {
  MIN_MINUTES,
  MAX_MINUTES,
  MINUTES_PER_QUESTION,
  DEFAULT_MINUTES,
  HISTORY_MIN_SAMPLES,
  SOURCE_HINT,
  bucketOf,
  clampMinutes,
  median,
  ruleMinutes,
  guessMinutes,
  historyMinutes,
  estimateTasks,
  urgencySort,
  planTonight
};
