'use strict';
/**
 * 修复重复日程的两个缺陷（学生评审反馈）：
 *   1. 每月重复的日期漂移：1/31 → 2/28 之后永远变成 28 号，回不到 31 号。
 *   2. 补完一条已过期很久的重复任务后，新一期直接又是“已逾期”。
 *
 * 做法：
 *   - 任务上新增 recurrenceDay（每月重复的锚点日，1..31）与 seriesStartAt（系列首期日期）；
 *   - 每月重复始终用“系列首期月份 + N 个月”+ 锚点日（当月不足则取月末）计算，避免逐月漂移；
 *   - 生成下一期时向前滚动，直到落在“现在”之后，最多滚动 MAX_ROLL 次防止死循环。
 */
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/store.js';
let s = fs.readFileSync(p, 'utf8');

const oldNext = `function nextOccurrence(task) {
  const d = new Date(task.dueAt);
  if (task.recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (task.recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (task.recurrence === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const max = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, max));
  } else {
    return null;
  }
  return {
    ...task,
    id: uid('t_'),
    dueAt: d.toISOString(),
    status: 'pending',
    completedAt: null,
    completedBy: '',
    remindersSent: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seriesId: task.seriesId || task.id
  };
}`;

const newNext = `const RECURRENCE_ROLL_LIMIT = 6000;

/** 某个自然月的天数（用下个月第 0 天反推，自动处理闰年）。 */
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 取“系列首期”落在哪个月。老数据没有 seriesStartAt 时退回当前 dueAt，
 * 这样升级后新建的重复任务不会再漂移。
 */
function seriesAnchor(task) {
  const raw = task.seriesStartAt || task.dueAt;
  const start = new Date(raw);
  const anchorDay = Math.max(1, Math.min(31, safeInt(task.recurrenceDay, start.getDate())));
  return { start, anchorDay };
}

/**
 * 计算下一期时间。
 * @param {object} task 需要 recurrence/dueAt/seriesStartAt/recurrenceDay
 * @param {number} [now] 参考时间，默认当前时刻；用于把过期很久的任务滚到未来
 */
function nextOccurrence(task, now = Date.now()) {
  if (!task || !['daily', 'weekly', 'monthly'].includes(task.recurrence)) return null;
  const base = new Date(task.dueAt);
  if (Number.isNaN(base.getTime())) return null;

  /** 把候选时间往后滚，直到晚于 now；每月重复用锚点日重新计算，避免漂移。 */
  let candidate = null;
  if (task.recurrence === 'monthly') {
    const { start, anchorDay } = seriesAnchor(task);
    // 已经产生的期数：从系列首期月份数到当前期所在月份
    const monthDiff = (base.getFullYear() - start.getFullYear()) * 12 + (base.getMonth() - start.getMonth());
    let step = Math.max(0, monthDiff) + 1;
    for (let i = 0; i < RECURRENCE_ROLL_LIMIT; i += 1) {
      const monthIndex = start.getMonth() + step;
      const year = start.getFullYear() + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      // 始终从锚点日取值：1/31 → 2/28 → 3/31，不会永久卡在 28 号
      const day = Math.min(anchorDay, daysInMonth(year, month));
      const next = new Date(start);
      next.setFullYear(year, month, day);
      candidate = next;
      if (next.getTime() > now) break;
      step += 1;
    }
  } else {
    const stepDays = task.recurrence === 'daily' ? 1 : 7;
    const next = new Date(base);
    next.setDate(next.getDate() + stepDays);
    // 补完一条过期任务时，可能连续几期都已过去，逐期滚到今天之后
    let guard = 0;
    while (next.getTime() <= now && guard < RECURRENCE_ROLL_LIMIT) {
      next.setDate(next.getDate() + stepDays);
      guard += 1;
    }
    candidate = next;
  }

  if (!candidate || Number.isNaN(candidate.getTime())) return null;
  return {
    ...task,
    id: uid('t_'),
    dueAt: candidate.toISOString(),
    status: 'pending',
    completedAt: null,
    completedBy: '',
    remindersSent: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seriesId: task.seriesId || task.id,
    // 系列首期与锚点日随每一期继续向下传递，保证后续计算仍以首期为基准
    seriesStartAt: task.seriesStartAt || task.dueAt,
    recurrenceDay: task.recurrenceDay || new Date(task.dueAt).getDate()
  };
}`;

if (!s.includes(oldNext)) throw new Error('nextOccurrence block not found');
s = s.replace(oldNext, newNext);

/* normalizeTask: 保存锚点日与系列首期，老任务自动补齐 */
const fieldFrom = `    recurrence,
    seriesId: cleanText(input.seriesId ?? base.seriesId, 80) || '',`;
const fieldTo = `    recurrence,
    seriesId: cleanText(input.seriesId ?? base.seriesId, 80) || '',
    // 重复日程的锚点：每月固定在这一天（31 号在小月自动取月末），
    // seriesStartAt 是系列首期，用于避免“1/31 → 2/28 → 3/28”的日期漂移。
    recurrenceDay: (() => {
      const fallback = due.getDate();
      const raw = safeInt(input.recurrenceDay ?? base.recurrenceDay, fallback);
      return Math.max(1, Math.min(31, raw || fallback));
    })(),
    seriesStartAt: cleanText(input.seriesStartAt ?? base.seriesStartAt, 40)
      || (recurrence !== 'none' ? due.toISOString() : ''),`;

if (!s.includes(fieldFrom)) throw new Error('normalizeTask field anchor not found');
s = s.replace(fieldFrom, fieldTo);

/* completeTask: 生成下一期时把“现在”传进去，过期任务会滚到今天之后 */
const completeFrom = `    if (existing.recurrence !== 'none') {
      const draft = nextOccurrence(existing);`;
const completeTo = `    if (existing.recurrence !== 'none') {
      // 传 now：补完一条过期好几天的重复任务时，下一期要落在今天之后，
      // 而不是刚生成就又是“已逾期”。
      const draft = nextOccurrence(existing, Date.now());`;
if (!s.includes(completeFrom)) throw new Error('completeTask anchor not found');
s = s.replace(completeFrom, completeTo);

fs.writeFileSync(p, s, 'utf8');
console.log('recurrence engine rewritten');
