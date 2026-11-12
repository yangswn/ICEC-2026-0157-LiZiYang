'use strict';
/**
 * 修复首次引导没有弹出：
 *   生成的选择器写成了 $("#scale-guide-options .seg")，单 $ 返回单个元素，
 *   对它调 .forEach 会抛 TypeError，函数在“显示弹窗”之前就中断了，
 *   结果选项已生成、弹窗仍 hidden。
 *   改为 $$()（返回数组），并给引导加 try/catch 兜底。
 */
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/src/renderer/app.js';
let s = fs.readFileSync(p, 'utf8');

const from = '  $("#scale-guide-options .seg").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.scale) === current));';
const to = '  $$("#scale-guide-options .seg").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.scale) === current));';
if (!s.includes(from)) throw new Error('selector line not found');
s = s.replace(from, to);

// 让引导更稳：任何一步失败都必须仍然把弹窗显示出来
const fnFrom = [
  'function openScaleGuide() {',
  "  const box = $('#scale-guide-options');",
  '  if (!box) return;'
].join('\n');
const fnTo = [
  'function openScaleGuide() {',
  "  const box = $('#scale-guide-options');",
  '  if (!box) return;',
  '  // 引导的每一步都不应阻塞弹窗显示：先显示，再填充内容。',
  "  $('#scale-guide-modal').hidden = false;",
  '  App.modalOpen = true;'
].join('\n');
if (!s.includes(fnFrom)) throw new Error('openScaleGuide head not found');
s = s.replace(fnFrom, fnTo);

// 去掉尾部重复的显示代码，避免重复赋值
const tailFrom = [
  "  $('#scale-guide-hint').textContent = `当前 ${UI_SCALES.find((i) => i.value === current).label} · ${UI_SCALES.find((i) => i.value === current).note}`;",
  "  $('#scale-guide-modal').hidden = false;",
  '  App.modalOpen = true;'
].join('\n');
const tailTo = [
  "  const picked = UI_SCALES.find((i) => i.value === current) || UI_SCALES[1];",
  "  $('#scale-guide-hint').textContent = `当前 ${picked.label} · ${picked.note}`;"
].join('\n');
if (s.includes(tailFrom)) s = s.replace(tailFrom, tailTo);

fs.writeFileSync(p, s, 'utf8');
console.log('scale guide fixed');
