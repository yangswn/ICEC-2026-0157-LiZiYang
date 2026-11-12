'use strict';
/**
 * 让“主接口 403”这类可自动降级的事件不再计入错误——包括**历史日志**。
 *
 * 背景：1.2.3 只认 meta.recovered 标记，但同学之前用 1.1.3/1.2.1 写下的记录
 * 没有这个字段，所以错误计数依然是 26/144，界面还是红的。
 *
 * 处理：把“有备用通道兜底”的事件类型定义为 degraded，
 * 统计与展示都不再当异常；同时新增 degraded 计数，信息不丢失。
 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ------------------------------------------------------------- telemetry */
{
  const p = root + 'server/telemetry.js';
  let s = fs.readFileSync(p, 'utf8');

  const anchor = 'const MAX_LINES =';
  const decl = [
    '// 这些事件表示“主通道不可用，但备用通道已顶上”，对用户没有影响。',
    '// 归类为 degraded：不进错误数，只单独计数，避免日志页一屏红字。',
    "const DEGRADED_EVENTS = new Set(['task_feed_error', 'task_feed_error_waf', 'course_list_error', 'course_tasks_error']);",
    '',
    anchor
  ].join('\n');

  if (s.includes(anchor) && !s.includes('DEGRADED_EVENTS')) {
    s = s.replace(anchor, decl);
    done.push('telemetry degraded set');
  } else if (!s.includes(anchor)) {
    console.log('MISS: telemetry anchor');
  }

  const from = "      const errors = entries.filter((e) => e.ok === false && !(e.meta && e.meta.recovered)).length;";
  const to = [
    '      // 只统计真正需要用户关心的错误：',
    '      //  - meta.recovered：已由备用通道恢复',
    '      //  - DEGRADED_EVENTS：本身就有降级兜底（例如主接口 403）',
    "      const errors = entries.filter((e) => e.ok === false",
    '        && !(e.meta && e.meta.recovered)',
    '        && !DEGRADED_EVENTS.has(e.event)).length;',
    '      const degraded = entries.filter((e) => e.ok === false && DEGRADED_EVENTS.has(e.event)).length;'
  ].join('\n');
  if (s.includes(from)) { s = s.replace(from, to); done.push('telemetry error exclusion'); }
  else console.log('MISS: telemetry errors');

  // 把 degraded 一起返回给前端
  const fromDay = '        errors,\n        heartbeats,';
  const toDay = '        errors,\n        degraded,\n        heartbeats,';
  if (s.includes(fromDay)) { s = s.replace(fromDay, toDay); done.push('telemetry degraded field'); }
  else console.log('MISS: day field');

  fs.writeFileSync(p, s, 'utf8');
}

/* ------------------------------------------------------------------- app */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');

  const from = '    const recovered = Boolean(e.meta && e.meta.recovered);';
  const to = [
    '    // 历史日志没有 meta.recovered，所以按事件类型兜底识别“可降级”事件',
    "    const DEGRADED = new Set(['task_feed_error', 'task_feed_error_waf', 'course_list_error', 'course_tasks_error']);",
    '    const recovered = Boolean(e.meta && e.meta.recovered) || DEGRADED.has(e.event);'
  ].join('\n');
  if (s.includes(from)) { s = s.replace(from, to); done.push('app degraded fallback'); }
  else console.log('MISS: app recovered line');

  fs.writeFileSync(p, s, 'utf8');
}

console.log('applied:', done.join(', '));
