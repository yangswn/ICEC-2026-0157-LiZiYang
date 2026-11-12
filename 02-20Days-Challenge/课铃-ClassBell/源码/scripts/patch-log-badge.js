'use strict';
/**
 * 修复：日志页“结果”列仍然把 403 显示成红色“异常”。
 *
 * 1.1.3/1.2.1 只改了事件名和错误计数，但结果列是 `e.ok ? 正常 : 异常`，
 * 所以同学看到的还是一屏红色“异常”。这里改为三态：
 *   正常 / 已恢复（备用通道成功）/ 异常
 * 并且“只看异常”过滤掉已恢复的条目。
 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ------------------------------------------------------------------ app.js */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');

  const fromFilter = '  const visible = App.logsErrorOnly ? recent.filter((e) => e.ok === false) : recent;';
  const toFilter = [
    '  // 已恢复（例如主接口 403 但备用通道成功）不算异常，避免整屏红字吓人',
    '  const visible = App.logsErrorOnly',
    '    ? recent.filter((e) => e.ok === false && !(e.meta && e.meta.recovered))',
    '    : recent;'
  ].join('\n');
  if (s.includes(fromFilter)) { s = s.replace(fromFilter, toFilter); done.push('filter excludes recovered'); }
  else console.log('MISS: filter');

  const fromRow = [
    '    const note = e.error || meta || \'—\';',
    '    return `<tr>',
    '      <td class="muted-cell">${esc((e.local || \'\').slice(5))}</td>',
    '      <td><span class="event-name">${esc(label)}</span></td>',
    '      <td>${e.ok ? \'<span class="ok-badge">正常</span>\' : \'<span class="err-badge">异常</span>\'}</td>'
  ].join('\n');

  const toRow = [
    '    const recovered = Boolean(e.meta && e.meta.recovered);',
    '    // 三态展示：正常 / 已恢复（备用成功）/ 异常',
    "    const badge = e.ok",
    "      ? '<span class=\"ok-badge\">正常</span>'",
    "      : (recovered",
    "        ? '<span class=\"recover-badge\">已恢复</span>'",
    "        : '<span class=\"err-badge\">异常</span>');",
    "    const note = recovered ? `${e.error || 'HTTP_403'}（备用通道已成功）` : (e.error || meta || '—');",
    '    return `<tr>',
    '      <td class="muted-cell">${esc((e.local || \'\').slice(5))}</td>',
    '      <td><span class="event-name">${esc(label)}</span></td>',
    '      <td>${badge}</td>'
  ].join('\n');

  if (s.includes(fromRow)) { s = s.replace(fromRow, toRow); done.push('result badge three-state'); }
  else console.log('MISS: row');

  fs.writeFileSync(p, s, 'utf8');
}

/* ------------------------------------------------------------------- css */
{
  const p = root + 'src/renderer/styles.css';
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('.recover-badge')) {
    s += [
      '',
      '/* 日志结果三态：已恢复用中性色，不用红色 */',
      '.recover-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #f4eddc; color: #8a6b2f; font-size: 10.5px; font-weight: 600; }',
      ''
    ].join('\n');
    fs.writeFileSync(p, s, 'utf8');
    done.push('recover badge css');
  }
}

console.log('applied:', done.join(', '));
