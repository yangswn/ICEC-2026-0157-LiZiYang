'use strict';
/** 首次打开时弹出“界面大小”引导，让用户当场把字调到清楚为止。 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ---------------------------------------------------------------- HTML */
{
  const p = root + 'src/renderer/index.html';
  let s = fs.readFileSync(p, 'utf8');
  const anchor = '  <div class="modal-overlay" id="notice-modal" hidden>';
  const modal = [
    '  <div class="modal-overlay" id="scale-guide-modal" hidden>',
    '    <div class="modal modal-small scale-guide" role="dialog" aria-modal="true" aria-labelledby="scale-guide-title">',
    '      <div class="modal-head">',
    '        <div><span class="modal-eyebrow">第一次使用</span><h2 id="scale-guide-title">先把字调到看得清</h2></div>',
    '      </div>',
    '      <div class="scale-guide-body">',
    '        <p class="scale-guide-tip">不同电脑的缩放比例不一样，字可能偏小或发虚。选一个你觉得清楚的大小，随时可以在「偏好设置 → 界面大小」里改。</p>',
    '        <div class="segmented scale-guide-options" id="scale-guide-options"></div>',
    '        <p class="field-note" id="scale-guide-hint">当前 标准 · 100%</p>',
    '        <div class="scale-guide-demo">',
    '          <strong>示例任务：工程数学作业</strong>',
    '          <span>截止 11/14 23:59 · 还有 3 天</span>',
    '        </div>',
    '      </div>',
    '      <div class="modal-foot">',
    '        <button type="button" class="btn btn-primary" id="scale-guide-done">就用这个大小</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '',
    anchor
  ].join('\n');
  if (s.includes(anchor)) { s = s.replace(anchor, modal); fs.writeFileSync(p, s, 'utf8'); done.push('scale guide html'); }
  else console.log('MISS: notice modal anchor');
}

/* ----------------------------------------------------------------- CSS */
{
  const p = root + 'src/renderer/styles.css';
  let s = fs.readFileSync(p, 'utf8');
  s += [
    '',
    '/* 首次使用：界面大小引导 */',
    '.scale-guide-body { padding: 4px 2px 0; }',
    '.scale-guide-tip { margin: 0 0 14px; font-size: 12px; line-height: 1.7; color: var(--ink-soft); }',
    '.scale-guide-options { display: flex; flex-wrap: wrap; gap: 8px; }',
    '.scale-guide-options .seg { min-width: 66px; padding: 9px 12px; font-size: 12px; }',
    '.scale-guide-demo { margin-top: 16px; padding: 12px 14px; border: 1px dashed #ddd6c5; border-radius: 10px; background: #fbf8ef; }',
    '.scale-guide-demo strong { display: block; font-size: 13px; color: var(--ink); }',
    '.scale-guide-demo span { display: block; margin-top: 5px; font-size: 11px; color: var(--muted); }',
    ''
  ].join('\n');
  fs.writeFileSync(p, s, 'utf8');
  done.push('scale guide css');
}

/* ------------------------------------------------------------------ JS */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');

  // 引导用的选择器：复用 UI_SCALES，但不复用设置页那组按钮的 id
  const helperAnchor = 'function setUiScale(scale) {';
  const helpers = [
    '/** 首次使用引导：把“界面大小”摆在第一屏，避免用户以为页面糊或字太小。 */',
    'function scaleGuidePending() {',
    "  try { return localStorage.getItem('campus:scaleGuideDone') !== '1'; } catch (_) { return false; }",
    '}',
    '',
    'function openScaleGuide() {',
    "  const box = $('#scale-guide-options');",
    '  if (!box) return;',
    '  box.innerHTML = UI_SCALES',
    '    .map((item) => `<button class="seg" data-scale="${item.value}">${item.label}</button>`)',
    "    .join('');",
    '  const current = currentUiScale();',
    '  $$("#scale-guide-options .seg").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.scale) === current));',
    "  $('#scale-guide-hint').textContent = `当前 ${UI_SCALES.find((i) => i.value === current).label} · ${UI_SCALES.find((i) => i.value === current).note}`;",
    "  $('#scale-guide-modal').hidden = false;",
    '  App.modalOpen = true;',
    '}',
    '',
    'function closeScaleGuide() {',
    "  $('#scale-guide-modal').hidden = true;",
    '  App.modalOpen = false;',
    "  try { localStorage.setItem('campus:scaleGuideDone', '1'); } catch (_) { /* ignore */ }",
    '}',
    '',
    helperAnchor
  ].join('\n');
  if (s.includes(helperAnchor)) { s = s.replace(helperAnchor, helpers); done.push('scale guide helpers'); }
  else console.log('MISS: setUiScale anchor');

  // 事件绑定
  const bindAnchor = "  $('#btn-open-settings').addEventListener('click', () => setPage('settings'));";
  const bind = [
    bindAnchor,
    "  $('#scale-guide-options').addEventListener('click', (event) => {",
    "    const btn = event.target.closest('.seg');",
    '    if (!btn) return;',
    '    setUiScale(btn.dataset.scale);',
    "    const note = UI_SCALES.find((i) => i.value === Number(btn.dataset.scale));",
    "    $('#scale-guide-hint').textContent = `当前 ${note.label} · ${note.note}`;",
    '  });',
    "  $('#scale-guide-done').addEventListener('click', closeScaleGuide);"
  ].join('\n');
  if (s.includes(bindAnchor)) { s = s.replace(bindAnchor, bind); done.push('scale guide bindings'); }
  else console.log('MISS: settings button anchor');

  // 首屏展示：boot 结束时判断
  const bootAnchor = '    document.body.classList.remove(\'boot-hidden\');';
  const boot = [
    "    // 第一次打开先引导调字号：默认 100% 渲染最清晰，用户可当场放大",
    '    if (scaleGuidePending()) setTimeout(openScaleGuide, 320);',
    bootAnchor
  ].join('\n');
  if (s.includes(bootAnchor)) { s = s.replace(bootAnchor, boot); done.push('scale guide on boot'); }
  else console.log('MISS: boot anchor');

  // Esc 关闭
  const escAnchor = "      if (!$('#notice-modal').hidden) { closeNoticeModal(); return; }";
  const esc = [
    "      if (!$('#scale-guide-modal').hidden) { closeScaleGuide(); return; }",
    escAnchor
  ].join('\n');
  if (s.includes(escAnchor)) { s = s.replace(escAnchor, esc); done.push('scale guide esc'); }
  else console.log('MISS: esc anchor');

  fs.writeFileSync(p, s, 'utf8');
}

console.log('applied:', done.join(', '));
