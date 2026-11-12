'use strict';
/**
 * 修复：字号引导每次启动都弹。
 *
 * 真因：课铃的本地服务每次启动都监听 **随机端口**，页面源是 http://127.0.0.1:<随机端口>。
 * localStorage 按“源（含端口）”隔离，端口一变就等于换了一个存储空间，
 * 所以 campus:scaleGuideDone / campus:uiScale / campus:lastPage 全都读不回来。
 *
 * 修法：这些“界面偏好”改存到服务端数据文件（settings），端口无关，重启仍在。
 * localStorage 只留作首次迁移的兼容来源。
 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ------------------------------------------------------------------ store */
{
  const p = root + 'server/store.js';
  let s = fs.readFileSync(p, 'utf8');

  const fromDefaults = `    displayName: '',
    firstRun: true`;
  const toDefaults = `    displayName: '',
    firstRun: true,
    // 界面偏好存这里而不是 localStorage：本地服务端口每次启动都变，
    // localStorage 按源隔离会“丢”，导致字号引导每次启动都弹。
    uiScale: 1.1,
    scaleGuideDone: false,
    lastPage: 'dashboard'`;
  if (s.includes(fromDefaults)) { s = s.replace(fromDefaults, toDefaults); done.push('settings defaults'); }
  else console.log('MISS: defaults');

  const fromAllowed = `      'autoAddFromChaoxing', 'sound', 'quietHours', 'logMirrorDir',
      'displayName', 'firstRun', 'reminderOffsets'
    ];`;
  const toAllowed = `      'autoAddFromChaoxing', 'sound', 'quietHours', 'logMirrorDir',
      'displayName', 'firstRun', 'reminderOffsets',
      'uiScale', 'scaleGuideDone', 'lastPage'
    ];`;
  if (s.includes(fromAllowed)) { s = s.replace(fromAllowed, toAllowed); done.push('settings allowlist'); }
  else console.log('MISS: allowlist');

  const fromBranch = `      } else if (key === 'logMirrorDir' || key === 'displayName') {
        next[key] = cleanText(patch[key], 500);`;
  const toBranch = `      } else if (key === 'uiScale') {
        // 只接受界面里提供的 6 档，避免脏值把页面缩坏
        const allowedScales = [0.9, 1, 1.1, 1.25, 1.4, 1.6];
        const value = Number(patch.uiScale);
        next.uiScale = allowedScales.includes(value) ? value : (next.uiScale || 1.1);
      } else if (key === 'lastPage') {
        const allowedPages = ['dashboard', 'tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'];
        const value = cleanText(patch.lastPage, 20);
        next.lastPage = allowedPages.includes(value) ? value : (next.lastPage || 'dashboard');
      } else if (key === 'logMirrorDir' || key === 'displayName') {
        next[key] = cleanText(patch[key], 500);`;
  if (s.includes(fromBranch)) { s = s.replace(fromBranch, toBranch); done.push('settings validation'); }
  else console.log('MISS: branch');

  fs.writeFileSync(p, s, 'utf8');
}

/* ----------------------------------------------------------------- app.js */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');

  /* 1) 当前缩放：以服务端 settings 为准 */
  const fromCurrent = `function currentUiScale() {
  const raw = Number(localStorage.getItem('campus:uiScale') || DEFAULT_UI_SCALE);
  return UI_SCALES.some((item) => item.value === raw) ? raw : DEFAULT_UI_SCALE;
}`;
  const toCurrent = `function currentUiScale() {
  // 服务端 settings 是唯一可信来源（端口无关）；
  // localStorage 仅在旧版本迁移时作为回退。
  const fromServer = App.state && App.state.settings ? Number(App.state.settings.uiScale) : NaN;
  const raw = Number.isFinite(fromServer) && fromServer > 0
    ? fromServer
    : Number(localStorage.getItem('campus:uiScale') || DEFAULT_UI_SCALE);
  return UI_SCALES.some((item) => item.value === raw) ? raw : DEFAULT_UI_SCALE;
}`;
  if (s.includes(fromCurrent)) { s = s.replace(fromCurrent, toCurrent); done.push('currentUiScale server-first'); }
  else console.log('MISS: currentUiScale');

  /* 2) setUiScale 持久化到服务端 */
  const fromSet = `function setUiScale(scale) {
  const value = UI_SCALES.some((item) => item.value === Number(scale)) ? Number(scale) : DEFAULT_UI_SCALE;
  applyUiScale(value);
  try { localStorage.setItem('campus:uiScale', String(value)); } catch (_) { /* ignore */ }
}`;
  const toSet = `function setUiScale(scale) {
  const value = UI_SCALES.some((item) => item.value === Number(scale)) ? Number(scale) : DEFAULT_UI_SCALE;
  applyUiScale(value);
  // 双写：服务端保证重启后仍生效；localStorage 只作即时缓存
  try { localStorage.setItem('campus:uiScale', String(value)); } catch (_) { /* ignore */ }
  if (App.state && App.state.settings) App.state.settings.uiScale = value;
  api.updateSettings({ uiScale: value }).catch(() => { /* 离线时忽略 */ });
}`;
  if (s.includes(fromSet)) { s = s.replace(fromSet, toSet); done.push('setUiScale persists'); }
  else console.log('MISS: setUiScale');

  /* 3) 引导是否已看过：看服务端设置 */
  const fromPending = `function scaleGuidePending() {
  try { return localStorage.getItem('campus:scaleGuideDone') !== '1'; } catch (_) { return false; }
}`;
  const toPending = `function scaleGuidePending() {
  // 注意：不要只依赖 localStorage —— 本地服务端口每次启动都变，源一变存储就丢。
  const fromServer = App.state && App.state.settings ? App.state.settings.scaleGuideDone : false;
  if (fromServer) return false;
  try { return localStorage.getItem('campus:scaleGuideDone') !== '1'; } catch (_) { return true; }
}`;
  if (s.includes(fromPending)) { s = s.replace(fromPending, toPending); done.push('scaleGuidePending server-first'); }
  else console.log('MISS: scaleGuidePending');

  /* 4) 关闭引导时写服务端 */
  const fromClose = `function closeScaleGuide() {
  $('#scale-guide-modal').hidden = true;
  App.modalOpen = false;
  try { localStorage.setItem('campus:scaleGuideDone', '1'); } catch (_) { /* ignore */ }
}`;
  const toClose = `function closeScaleGuide() {
  $('#scale-guide-modal').hidden = true;
  App.modalOpen = false;
  try { localStorage.setItem('campus:scaleGuideDone', '1'); } catch (_) { /* ignore */ }
  if (App.state && App.state.settings) App.state.settings.scaleGuideDone = true;
  api.updateSettings({ scaleGuideDone: true }).catch(() => { /* 离线时忽略 */ });
}`;
  if (s.includes(fromClose)) { s = s.replace(fromClose, toClose); done.push('closeScaleGuide persists'); }
  else console.log('MISS: closeScaleGuide');

  /* 5) 上次页面也存服务端 */
  const fromPage = `    try { localStorage.setItem('campus:lastPage', page); } catch (_) { /* ignore */ }`;
  const toPage = `    try { localStorage.setItem('campus:lastPage', page); } catch (_) { /* ignore */ }
    if (App.state && App.state.settings) App.state.settings.lastPage = page;
    api.updateSettings({ lastPage: page }).catch(() => { /* ignore */ });`;
  if (s.includes(fromPage)) { s = s.replace(fromPage, toPage); done.push('lastPage persists'); }
  else console.log('MISS: lastPage');

  /* 6) 启动恢复上次页面：服务端优先 */
  const fromBootPage = `      const savedPage = localStorage.getItem('campus:lastPage');
      if (['tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'].includes(savedPage)) setPage(savedPage);`;
  const toBootPage = `      const serverPage = App.state.settings && App.state.settings.lastPage;
      const savedPage = serverPage || localStorage.getItem('campus:lastPage');
      if (['tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'].includes(savedPage)) setPage(savedPage);`;
  if (s.includes(fromBootPage)) { s = s.replace(fromBootPage, toBootPage); done.push('boot page server-first'); }
  else console.log('MISS: boot page');

  fs.writeFileSync(p, s, 'utf8');
}

console.log('applied:', done.join(', '));
