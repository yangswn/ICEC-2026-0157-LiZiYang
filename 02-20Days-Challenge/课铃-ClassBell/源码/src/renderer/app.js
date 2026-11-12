'use strict';

/* ==========================================================================
   课铃 ClassBell — renderer
   ========================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.campus;

const App = {
  state: null,
  stats: null,
  meta: null,
  auth: null,
  logs: null,
  page: 'dashboard',
  filters: { status: 'pending', q: '', category: 'all' },
  editingId: null,
  webviewInitialized: false,
  webviewLoading: false,
  syncInFlight: false,
  authChecking: false,
  loginSyncTriggered: false,
  nextTask: null,
  confirmResolver: null,
  logsLoaded: false,
  modalOpen: false,
  lastPageView: '',
  logsErrorOnly: false,
  noticeOpen: new Set(),
  mistakeFilter: 'all'
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const CATEGORY_LABEL = { homework: '作业', exam: '考试', schedule: '日程', other: '其他' };
const UI_SCALES = [
  { value: 0.9, label: '小', note: '90%' },
  { value: 1, label: '标准', note: '100%' },
  { value: 1.1, label: '大', note: '110%' },
  { value: 1.25, label: '特大', note: '125%' },
  { value: 1.4, label: '超大', note: '140%' },
  { value: 1.6, label: '巨大', note: '160%' }
];
const DEFAULT_UI_SCALE = 1.1;
const PRIORITY_LABEL = { normal: '普通', important: '重要', urgent: '紧急' };
const NOTICE_KIND_LABEL = { assignment: '作业', exam: '考试', gear: '器材', notice: '通知', system: '系统' };
const EVENT_LABEL = {
  app_start: '应用启动',
  app_stop: '应用退出',
  heartbeat: '运行心跳',
  page_view: '页面访问',
  sync_start: '开始同步',
  sync_complete: '接口同步完成',
  sync_merge: '合并识别结果',
  deadline_enrichment: '补全截止时间',
  sync_failed: '同步失败',
  task_feed_error: '主接口 403（已用备用读取）',
  course_list_error: '课程列表异常',
  course_tasks_error: '课程任务异常',
  task_feed_error_waf: '接口验证拦截',
  page_scan: '页面扫描',
  page_scan_error: '页面扫描失败',
  page_scan_merged: '扫描结果入库',
  task_added: '新增任务',
  task_updated: '更新任务',
  task_deleted: '删除任务',
  task_completed: '完成任务',
  task_restored: '恢复任务',
  reminder_fired: '触发提醒',
  reminder_action: '提醒操作耗时',
  reminder_done: '提醒中完成',
  reminder_snoozed: '稍后提醒',
  reminder_dismissed: '关闭提醒',
  reminder_open_task: '从提醒打开',
  reminder_preview: '测试弹窗',
  settings_updated: '更新设置',
  webview_load_error: '学习通页面加载失败',
  renderer_crashed: '界面进程异常',
  webview_crashed: '学习通窗口异常',
  autolaunch_error: '开机自启设置失败',
  log_mirror_error: '日志镜像失败',
  logs_exported: '导出日志',
  data_exported: '导出数据',
  data_imported: '导入数据',
  uncaught_exception: '未捕获异常',
  unhandled_rejection: '未处理异步异常',
  'task_feed_error_waf': '接口验证拦截'
};

/* ------------------------------------------------------------------ utils */

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isSameDay(a, b) {
  return dateKey(a) === dateKey(b);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysFromToday(date) {
  return Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
}

function fmtTime(date) {
  const d = new Date(date);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtMonthDay(date) {
  const d = new Date(date);
  return `${MONTHS[d.getMonth()]}${d.getDate()}日`;
}

function fmtDateFull(date) {
  const d = new Date(date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function dayLabel(date) {
  const diff = daysFromToday(date);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  if (diff < 0) return `${fmtMonthDay(date)}`;
  return `${WEEKDAYS[new Date(date).getDay()]} · ${fmtMonthDay(date)}`;
}

function groupLabel(date) {
  const diff = daysFromToday(date);
  if (diff === 0) return `今天 · ${MONTHS[new Date(date).getMonth()]}${new Date(date).getDate()}日`;
  if (diff === 1) return `明天 · ${MONTHS[new Date(date).getMonth()]}${new Date(date).getDate()}日`;
  return `${WEEKDAYS[new Date(date).getDay()]} · ${fmtMonthDay(date)}`;
}

function dueChip(task) {
  if (task.status === 'missed') {
    return { text: '已错过', sub: '无法补交', cls: 'missed' };
  }
  if (task.noDeadline) {
    return { text: task.status === 'done' ? '已完成' : '长期任务', sub: task.status === 'done' ? '无截止时间' : '完成前一直保留', cls: 'nodue' };
  }
  const d = new Date(task.dueAt);
  const now = Date.now();
  if (task.status === 'done') {
    return { text: '已完成', sub: fmtMonthDay(d), cls: '' };
  }
  const diff = daysFromToday(d);
  const late = d.getTime() < now;
  if (late) {
    const hours = Math.max(1, Math.floor((now - d.getTime()) / 3600000));
    const text = diff <= -1 ? `已逾期 ${Math.abs(diff)} 天` : `已逾期 ${hours} 小时`;
    return { text, sub: `截止 ${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`, cls: 'overdue' };
  }
  let day;
  if (diff === 0) day = '今天';
  else if (diff === 1) day = '明天';
  else if (diff === 2) day = '后天';
  else day = `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
  const soon = d.getTime() - now < 6 * 3600 * 1000;
  return { text: `${day} ${fmtTime(d)}`, sub: `${PRIORITY_LABEL[task.priority] || '普通'}优先级`, cls: soon ? 'soon' : '' };
}

function countdownText(target, { compact = false } = {}) {
  if (!target) return '—';
  const diff = new Date(target).getTime() - Date.now();
  const late = diff < 0;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  let core;
  if (days >= 1) core = `${days} 天 ${pad2(hours)}:${pad2(minutes)}`;
  else if (hours >= 1) core = `${hours} 小时 ${pad2(minutes)} 分`;
  else if (minutes >= 1) core = `${minutes} 分 ${pad2(seconds)} 秒`;
  else core = `${seconds} 秒`;
  return `${late ? '已超时 ' : ''}${core}`;
}

function relativeSince(iso) {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 45000) return '刚刚';
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.round(diff / 86400000)} 天前`;
  return fmtMonthDay(iso);
}

function toLocalInput(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function taskListSorted(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    if (a.status === 'done') {
      return new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt);
    }
    return new Date(a.dueAt) - new Date(b.dueAt);
  });
}

function pendingTasks() {
  if (!App.state) return [];
  return taskListSorted(App.state.tasks.filter((t) => t.status === 'pending'));
}

function nextPendingTask() {
  const list = pendingTasks().filter((t) => !t.noDeadline);
  // Prefer what is still ahead; only fall back to a missed deadline when
  // nothing upcoming is left.
  return list.find((t) => new Date(t.dueAt).getTime() >= Date.now()) || list[0] || null;
}

function pendingUpcoming() {
  const now = Date.now();
  const list = pendingTasks();
  const future = list
    .filter((t) => !t.noDeadline && new Date(t.dueAt).getTime() >= now)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const longTerm = list.filter((t) => t.noDeadline);
  const past = list
    .filter((t) => !t.noDeadline && new Date(t.dueAt).getTime() < now)
    .sort((a, b) => new Date(b.dueAt) - new Date(a.dueAt));
  return [...future, ...longTerm, ...past];
}

function summarizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

function toast(message, type = 'info', duration = 2800) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const icon = type === 'error' ? 'i-x' : (type === 'success' ? 'i-check' : 'i-bell');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<svg><use href="#${icon}"/></svg><span>${esc(message)}</span>`;
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

/* ------------------------------------------------------------- boot/state */

async function boot() {
  try {
    const payload = await api.bootstrap();
    App.state = payload.state;
    App.stats = payload.stats;
    App.meta = payload.meta;
    App.auth = payload.auth;
    App.logs = payload.logs;
    mountLogsInSettings();
    applySavedUiScale();
    applyMeta();
    renderAll();
    bindEvents();
    initWebview();
    loadLogs();
    startTicker();
    syncAutoScanUi();
    if (autoScanEnabled()) startAutoScan();
    setInterval(() => {
      if (App.page === 'integration') checkAuth(false);
    }, 6000);
    setInterval(() => {
      if (App.page !== 'integration') checkAuth(false);
    }, 12000);
    if (App.auth && App.auth.loggedIn && App.state.settings.autoSync) {
      setTimeout(() => checkAuth(true), 2500);
    }
    const params = new URLSearchParams(location.search);
    const initialPage = params.get('page');
    if (['dashboard', 'tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'].includes(initialPage)) {
      setPage(initialPage);
    } else {
      const serverPage = App.state.settings && App.state.settings.lastPage;
      const savedPage = serverPage || localStorage.getItem('campus:lastPage');
      if (['tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'].includes(savedPage)) setPage(savedPage);
    }
    if (params.get('open') === 'task') {
      setTimeout(() => openTaskModal(), 360);
    }
    // 第一次打开先引导调字号：默认 100% 渲染最清晰，用户可当场放大
    if (scaleGuidePending()) setTimeout(openScaleGuide, 320);
    document.body.classList.remove('boot-hidden');
  } catch (error) {
    console.error(error);
    document.body.classList.remove('boot-hidden');
    toast(`启动失败：${error.message || error}`, 'error', 8000);
  }
}

function applyMeta() {
  if (!App.meta) return;
  $('#foot-version').textContent = `v${App.meta.version}`;
  $('#about-version').textContent = `v${App.meta.version}`;
  $('#set-data-dir').textContent = App.meta.dataDir;
  $('#set-data-dir').title = App.meta.dataDir;
}

function applyPayload(payload) {
  if (!payload) return;
  App.state = payload.state;
  App.stats = payload.stats;
  App.meta = { ...(App.meta || {}), ...(payload.meta || {}) };
  applyMeta();
  renderAll();
}

function startTicker() {
  setInterval(() => {
    updateCountdowns();
    if (App.page === 'dashboard') updateHeroCountdownOnly();
  }, 1000);
}

function updateCountdowns() {
  const task = App.nextTask;
  const sideTime = $('#side-next-time');
  const sideTitle = $('#side-next-title');
  if (!task) {
    sideTime.textContent = '暂无待办';
    sideTime.classList.remove('overdue');
    const longTerm = pendingTasks().find((t) => t.noDeadline);
    sideTitle.textContent = longTerm ? '长期任务：' + longTerm.title : '新建一项日程，或连接学习通。';
    return;
  }
  const late = new Date(task.dueAt).getTime() < Date.now();
  sideTime.textContent = late ? `逾期 ${countdownText(task.dueAt).replace('已超时 ', '')}` : countdownText(task.dueAt);
  sideTime.classList.toggle('overdue', late);
  sideTitle.textContent = task.title;
}

function updateHeroCountdownOnly() {
  if (!App.nextTask) return;
  const el = $('#hero-countdown');
  if (!el) return;
  if (App.nextTask.noDeadline) {
    el.textContent = '无截止时间';
    el.classList.remove('overdue');
    return;
  }
  const late = new Date(App.nextTask.dueAt).getTime() < Date.now();
  el.textContent = countdownText(App.nextTask.dueAt);
  el.classList.toggle('overdue', late);
}

/* --------------------------------------------------------------- rendering */

function renderAll() {
  if (!App.state) return;
  if (!App.stats) App.stats = { pending: 0, today: 0, week: 0, done: 0, overdue: 0 };
  renderTitlebar();
  renderSidebar();
  renderDashboard();
  renderTasks();
  renderIntegration();
  renderNotices();
  renderGear();
  renderMistakes();
  renderSettings();
  renderLogs();
  renderWelcome();
}

function renderWelcome() {
  const card = $('#welcome-card');
  if (!card) return;
  card.hidden = !App.state.settings.firstRun;
}

function renderTitlebar() {
  const box = $('#titlebar-status');
  const text = $('#titlebar-status-text');
  if (!box || !text) return;
  box.classList.remove('online', 'busy', 'error');
  if (App.syncInFlight) {
    box.classList.add('busy');
    text.textContent = '正在同步学习通…';
    return;
  }
  const sync = App.state.sync || {};
  if (App.auth && App.auth.loggedIn) {
    if (sync.lastResult === 'error') {
      box.classList.add('error');
      text.textContent = '学习通同步异常';
    } else {
      box.classList.add('online');
      text.textContent = sync.lastSyncAt ? `学习通已连接 · ${relativeSince(sync.lastSyncAt)}同步` : '学习通已连接';
    }
  } else {
    text.textContent = '本地模式 · 手动记录日程';
  }
}

function renderSidebar() {
  const stats = App.stats;
  $('#nav-badge').textContent = stats.pending > 0 ? String(stats.pending) : '';
  const dot = $('#nav-cx-dot');
  dot.hidden = !(App.auth && App.auth.loggedIn);
  const setBadge = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = value > 0 ? String(value) : '';
  };
  setBadge('#nav-notice-badge', Number(stats.noticesUnread || 0));
  setBadge('#nav-gear-badge', Number(stats.gearOverdue || 0));
  setBadge('#nav-mistake-badge', 0);
  App.nextTask = nextPendingTask();
  updateCountdowns();
}

function renderDashboard() {
  const now = new Date();
  $('#dash-date').textContent = `${fmtDateFull(now)} · ${WEEKDAYS[now.getDay()]}`;
  const hour = now.getHours();
  const name = App.state.settings.displayName ? `，${App.state.settings.displayName}` : '';
  let title = '今天，稳一点。';
  if (hour < 6) title = '夜深了，明天再稳一点。';
  else if (hour < 11) title = '早上好，今天稳一点。';
  else if (hour < 14) title = '中午好，按节奏来。';
  else if (hour < 18) title = '下午好，一件件来。';
  else title = '晚上好，把今天收好。';
  $('#dash-title').textContent = title.replace('。', `${name}。`).replace(`${name}${name}`, name);
  const pending = pendingTasks();
  const nextTimed = App.nextTask || pending.find((t) => !t.noDeadline);
  const overdueOnly = nextTimed && new Date(nextTimed.dueAt).getTime() < Date.now();
  $('#dash-sub').textContent = pending.length
    ? (nextTimed
      ? (overdueOnly
        ? `还有 ${pending.length} 项待完成，接下来的都还没有截止时间；已过期的已放到列表末尾。`
        : `还有 ${pending.length} 项待完成，最近一项在 ${dayLabel(nextTimed.dueAt)} ${fmtTime(nextTimed.dueAt)}。`)
      : `还有 ${pending.length} 项长期任务，完成即可，不设截止时间。`)
    : '目前没有待办。可以新建日程，或连接学习通自动同步。';

  $('#stat-pending').textContent = App.stats.pending;
  $('#stat-today').textContent = App.stats.today;
  $('#stat-week').textContent = App.stats.week;
  $('#stat-done').textContent = App.stats.done;
  const missed = App.state.tasks.filter((t) => t.status === 'missed');
  const missedBanner = $('#missed-banner');
  if (missedBanner) {
    missedBanner.hidden = missed.length === 0;
    const num = $('#missed-num');
    if (num) num.textContent = String(missed.length);
  }

  renderHero();
  renderUpcoming();
  renderWeekChart();
  renderCxMini();
}

function renderHero() {
  const task = App.nextTask;
  const actions = $('#hero-actions');
  const countdown = $('#hero-countdown');
  if (!task) {
    const longTermCount = pendingTasks().filter((t) => t.noDeadline).length;
    $('#hero-kicker').textContent = longTermCount ? '长期任务' : '下一项截止';
    countdown.textContent = longTermCount ? '无截止时间' : '今天没有截止';
    countdown.classList.add('empty');
    countdown.classList.remove('overdue');
    $('#hero-title').textContent = longTermCount ? `还有 ${longTermCount} 项长期任务` : '把空出来的时间，留给重要的事。';
    $('#hero-meta').textContent = longTermCount ? '这些作业没有截止时间，完成一项就勾掉一项。' : '新建一项日程，或连接学习通自动识别作业与考试。';
    $('#hero-date').textContent = `${fmtMonthDay(new Date())} · ${WEEKDAYS[new Date().getDay()]}`;
    actions.innerHTML = `<button class="btn btn-gold btn-small" data-act="add">新建日程</button><button class="btn btn-light btn-small" data-goto="tasks">查看长期任务</button>`;
    return;
  }
  const late = new Date(task.dueAt).getTime() < Date.now();
  countdown.classList.remove('empty');
  countdown.classList.toggle('overdue', late);
  $('#hero-kicker').textContent = late ? '这一项已经超过截止时间' : '距离下一项截止';
  countdown.textContent = countdownText(task.dueAt);
  $('#hero-title').textContent = task.title;
  $('#hero-meta').innerHTML = `${esc(task.course || '未填写课程')}<span class="dot"></span>${esc(CATEGORY_LABEL[task.category] || '任务')}<span class="dot"></span>${esc(fmtDateFull(task.dueAt))} ${esc(fmtTime(task.dueAt))}`;
  $('#hero-date').textContent = `${fmtMonthDay(task.dueAt)} · ${WEEKDAYS[new Date(task.dueAt).getDay()]} · ${fmtTime(task.dueAt)}`;
  actions.innerHTML = `
    <button class="btn btn-light btn-small" data-act="edit" data-id="${esc(task.id)}">查看详情</button>
    <button class="btn btn-gold btn-small" data-act="complete" data-id="${esc(task.id)}">标记完成</button>
  `;
}

function renderUpcoming() {
  const container = $('#upcoming-list');
  const tasks = pendingUpcoming().slice(0, 5);
  if (!tasks.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:34px 16px 36px">
        <div class="empty-mark"><svg><use href="#i-calendar"/></svg></div>
        <strong>日历是空的</strong>
        <p>新建第一项日程，或者从学习通同步作业。</p>
        <button class="btn btn-soft btn-small" data-act="add">新建日程</button>
      </div>`;
    return;
  }
  container.innerHTML = tasks.map((task) => {
    const d = task.noDeadline ? null : new Date(task.dueAt);
    const late = d ? d.getTime() < Date.now() : false;
    const chip = dueChip(task);
    return `
      <div class="upcoming-item" data-act="edit" data-id="${esc(task.id)}">
        <div class="upcoming-date"><strong>${d ? pad2(d.getDate()) : '∞'}</strong><span>${d ? MONTHS[d.getMonth()] : '长期'}</span></div>
        <div class="upcoming-main">
          <div class="upcoming-title">${esc(task.title)}</div>
          <div class="upcoming-meta">
            <span class="priority-mark ${esc(task.priority)}"></span>
            <span>${esc(task.course || CATEGORY_LABEL[task.category])}</span>
            <span class="dot"></span>
            <span>${esc(CATEGORY_LABEL[task.category] || '任务')}</span>
            ${task.source === 'chaoxing' ? '<span class="dot"></span><span>学习通</span>' : ''}
          </div>
        </div>
        <div class="upcoming-due ${late ? 'overdue' : ''}">${esc(chip.text)}</div>
      </div>`;
  }).join('');
}

function renderWeekChart() {
  const container = $('#week-chart');
  const today = startOfDay(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const count = App.state.tasks.filter((t) => t.status === 'pending' && !t.noDeadline && dateKey(t.dueAt) === dateKey(d)).length;
    days.push({ d, count });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  container.innerHTML = days.map((item, i) => {
    const height = item.count ? Math.max(9, Math.round((item.count / max) * 88)) : 4;
    return `
      <div class="week-col ${i === 0 ? 'today' : ''} ${item.count ? 'has-tasks' : ''}">
        <div class="week-bar-wrap"><div class="week-bar" style="height:${height}%">${item.count ? `<span class="week-count">${item.count}</span>` : ''}</div></div>
        <div class="week-label">${i === 0 ? '今天' : WEEKDAYS[item.d.getDay()].slice(1)}<br>${item.d.getMonth() + 1}/${item.d.getDate()}</div>
      </div>`;
  }).join('');
}

function renderCxMini() {
  const auth = App.auth;
  const sync = App.state.sync || {};
  const logged = Boolean(auth && auth.loggedIn);
  $('#cx-mini-status').textContent = logged
    ? (sync.lastResult === 'error' ? '同步遇到问题，点击查看' : '已连接，自动识别作业')
    : '尚未连接';
  const pill = $('#cx-mini-pill');
  pill.textContent = logged ? (sync.lastResult === 'error' ? '异常' : '已连接') : '离线';
  pill.className = `pill ${logged ? (sync.lastResult === 'error' ? 'error' : 'online') : ''}`;
  $('#cx-mini-last').textContent = relativeSince(sync.lastSyncAt);
  $('#cx-mini-count').textContent = `${sync.recognized || 0} 项`;
  $('#cx-mini-btn').textContent = logged ? '立即同步' : '去连接';
}

function renderTasks() {
  const list = $('#task-list');
  const all = App.state.tasks || [];
  const pending = all.filter((t) => t.status === 'pending');
  $('#count-pending').textContent = String(pending.length);
  $('#count-done').textContent = String(all.filter((t) => t.status === 'done').length);
  const missedCount = all.filter((t) => t.status === 'missed').length;
  const missedCountEl = $('#count-missed');
  if (missedCountEl) missedCountEl.textContent = String(missedCount);

  $$('#status-tabs .seg').forEach((btn) => btn.classList.toggle('active', btn.dataset.status === App.filters.status));

  let tasks = all;
  if (App.filters.status !== 'all') tasks = tasks.filter((t) => t.status === App.filters.status);
  if (App.filters.category !== 'all') tasks = tasks.filter((t) => t.category === App.filters.category);
  const q = App.filters.q.trim().toLowerCase();
  if (q) tasks = tasks.filter((t) => `${t.title} ${t.course}`.toLowerCase().includes(q));

  const now = Date.now();
  const overdueCount = pending.filter((t) => !t.noDeadline && new Date(t.dueAt).getTime() < now).length;
  $('#task-summary').innerHTML = `共 <strong>${tasks.length}</strong> 项 · 待完成 <strong>${pending.length}</strong> 项${missedCount ? ` · <span style="color:var(--coral)">已错过 ${missedCount} 项</span>` : ''}${overdueCount ? ` · <span style="color:var(--coral)">已逾期 ${overdueCount} 项</span>` : ''}`;

  if (!tasks.length) {
    list.innerHTML = `
      <div class="panel">
        <div class="empty-state">
          <div class="empty-mark"><svg><use href="#i-list"/></svg></div>
          <strong>${App.filters.q ? '没有找到匹配的任务' : (App.filters.status === 'done' ? '还没有完成的任务' : '没有待办事项')}</strong>
          <p>${App.filters.q ? '换个关键词，或清空筛选。' : '新建一项日程，或者连接学习通自动识别。'}</p>
          <button class="btn btn-soft btn-small" data-act="add">新建日程</button>
        </div>
      </div>`;
    return;
  }

  const groups = new Map();
  for (const task of taskListSorted(tasks)) {
    let key;
    if (task.status === 'done') key = 'done';
    else if (task.status === 'missed') key = 'missed';
    else if (task.noDeadline) key = 'nodeadline';
    else if (new Date(task.dueAt).getTime() < now) key = 'overdue';
    else key = dateKey(task.dueAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  const rank = (key) => {
    if (key === 'missed') return 90;
    if (key === 'overdue') return 80;
    if (key === 'nodeadline') return 70;
    if (key === 'done') return 100;
    return 0;
  };
  // Upcoming days first (soonest on top); everything already gone last, so the
  // list opens on what still matters instead of on history.
  const order = [...groups.keys()].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    if (rank(a) !== 0) return 0;
    return a.localeCompare(b);
  });

  list.innerHTML = order.map((key) => {
    const rows = groups.get(key);
    let head;
    if (key === 'missed') head = '已错过 · 无法补交';
    else if (key === 'overdue') head = '已逾期';
    else if (key === 'done') head = '已完成';
    else if (key === 'nodeadline') head = '长期任务 · 无截止时间';
    else head = groupLabel(new Date(`${key}T12:00:00`));
    return `
      <div class="task-group">
        <div class="task-group-head ${key === 'overdue' ? 'overdue' : ''}">
          <h3>${esc(head)}</h3><span class="group-count">${rows.length}</span><span class="group-line"></span>
        </div>
        ${rows.map(taskRowHTML).join('')}
      </div>`;
  }).join('');
}

function taskRowHTML(task) {
  const due = dueChip(task);
  const isDone = task.status === 'done';
  const isMissed = task.status === 'missed';
  return `
    <div class="task-row ${isDone ? 'done' : ''} ${isMissed ? 'missed' : ''}" data-id="${esc(task.id)}">
      <button class="task-check" data-act="toggle" data-id="${esc(task.id)}" ${isMissed ? 'disabled' : ''} title="${isMissed ? '已错过，无法补交' : (isDone ? '恢复为待完成' : '标记完成')}" aria-label="${isMissed ? '已错过' : (isDone ? '恢复为待完成' : '标记完成')}"><svg><use href="#i-check"/></svg></button>
      <div class="task-main" data-act="edit" data-id="${esc(task.id)}">
        <div class="task-title-line">
          <span class="priority-mark ${esc(task.priority)}"></span>
          <span class="task-title">${esc(task.title)}</span>
          ${task.source === 'chaoxing' ? '<span class="source-tag cx">学习通</span>' : '<span class="source-tag">手动</span>'}
          ${task.recurrence && task.recurrence !== 'none' ? '<span class="repeat-tag">重复</span>' : ''}
        </div>
        <div class="task-meta">
          <span class="task-course">${esc(task.course || '未填写课程')}</span>
          <span class="dot"></span>
          <span>${esc(CATEGORY_LABEL[task.category] || '任务')}</span>
          ${task.notes ? '<span class="dot"></span><span>有备注</span>' : ''}
        </div>
      </div>
      <div class="task-due ${due.cls}">${esc(due.text)}<small>${esc(due.sub)}</small></div>
      <div class="task-actions">
        <button class="task-action" data-act="edit" data-id="${esc(task.id)}" title="编辑" aria-label="编辑"><svg><use href="#i-edit"/></svg></button>
        <button class="task-action danger" data-act="delete" data-id="${esc(task.id)}" title="删除" aria-label="删除"><svg><use href="#i-trash"/></svg></button>
      </div>
    </div>`;
}

/* ------------------------------------------------- notices / gear / mistakes */

function fmtWhen(iso) {
  if (!iso) return '未设置';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未设置';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function noticeRowHTML(notice) {
  const open = App.noticeOpen.has(notice.id);
  const chipClass = notice.source === 'chaoxing' ? 'cx' : (notice.kind === 'gear' ? 'gear' : '');
  return `
    <div class="notice-item ${notice.read ? '' : 'unread'}" data-id="${esc(notice.id)}">
      <span class="notice-dot"></span>
      <div>
        <div class="notice-title" data-act="toggle-notice" data-id="${esc(notice.id)}">${esc(notice.title)}</div>
        <div class="notice-meta">
          <span class="notice-chip ${chipClass}">${esc(NOTICE_KIND_LABEL[notice.kind] || '通知')}</span>
          ${notice.course ? `<span>${esc(notice.course)}</span>` : ''}
          <span>·</span>
          <span>${esc(relativeSince(notice.publishedAt))}</span>
          ${notice.source === 'chaoxing' ? '<span class="notice-chip cx">学习通</span>' : '<span class="notice-chip">本地</span>'}
        </div>
        ${open && notice.body ? `<div class="notice-body">${esc(notice.body)}</div>` : ''}
      </div>
      <div class="notice-actions">
        <button class="mini-btn" data-act="read-notice" data-id="${esc(notice.id)}">${notice.read ? '标为未读' : '标为已读'}</button>
        <button class="task-action danger" data-act="delete-notice" data-id="${esc(notice.id)}" title="删除" aria-label="删除"><svg><use href="#i-trash"/></svg></button>
      </div>
    </div>`;
}

function renderNotices() {
  const list = App.state.notices || [];
  const container = $('#notice-list');
  if (!container) return;
  $('#notice-unread').textContent = String(list.filter((n) => !n.read).length);
  $('#notice-total').textContent = String(list.length);
  const lastExtract = App.state.notices.find((n) => n.source === 'chaoxing');
  $('#notice-last').textContent = lastExtract ? relativeSince(lastExtract.publishedAt) : '—';
  container.innerHTML = list.length
    ? list.map(noticeRowHTML).join('')
    : '<div class="empty-row">还没有通知。点“从学习通提取”，或手动添加一条。</div>';
}

function gearSorted() {
  const now = Date.now();
  const list = [...(App.state.gear || [])];
  const weight = (item) => {
    if (item.status === 'returned') return 2;
    return item.dueAt && new Date(item.dueAt).getTime() < now ? 0 : 1;
  };
  return list.sort((a, b) => {
    const diff = weight(a) - weight(b);
    if (diff !== 0) return diff;
    if (a.status === 'returned') return new Date(b.returnedAt || b.updatedAt) - new Date(a.returnedAt || a.updatedAt);
    return new Date(a.dueAt || a.borrowedAt) - new Date(b.dueAt || b.borrowedAt);
  });
}

function gearRowHTML(item) {
  const now = Date.now();
  const overdue = item.status === 'out' && item.dueAt && new Date(item.dueAt).getTime() < now;
  const stateClass = item.status === 'returned' ? 'returned' : (overdue ? 'overdue' : 'out');
  let stateText = '已归还';
  if (item.status === 'out') {
    stateText = overdue ? `逾期 ${Math.max(1, Math.floor((now - new Date(item.dueAt).getTime()) / 86400000))} 天` : '借出中';
  }
  return `
    <div class="gear-row" data-id="${esc(item.id)}">
      <div class="gear-main">
        <div class="gear-name">${esc(item.name)}${item.code ? ` · ${esc(item.code)}` : ''}</div>
        <div class="gear-meta">
          <span>${esc(item.borrower || '借用人未填')}</span>
          <span>·</span><span>借于 ${esc(fmtWhen(item.borrowedAt))}</span>
          <span>·</span><span>应还 ${esc(item.dueAt ? fmtWhen(item.dueAt) : '未设置')}</span>
          ${item.returnedAt ? `<span>·</span><span>还于 ${esc(fmtWhen(item.returnedAt))}</span>` : ''}
          ${item.note ? `<span>·</span><span>${esc(item.note)}</span>` : ''}
        </div>
      </div>
      <div class="gear-state ${stateClass}">${esc(stateText)}</div>
      <div class="gear-actions">
        ${item.status === 'out' ? `<button class="mini-btn" data-act="return-gear" data-id="${esc(item.id)}">归还</button>` : ''}
        <button class="task-action" data-act="edit-gear" data-id="${esc(item.id)}" title="编辑" aria-label="编辑"><svg><use href="#i-edit"/></svg></button>
        <button class="task-action danger" data-act="delete-gear" data-id="${esc(item.id)}" title="删除" aria-label="删除"><svg><use href="#i-trash"/></svg></button>
      </div>
    </div>`;
}

function renderGear() {
  const container = $('#gear-list');
  if (!container) return;
  const list = App.state.gear || [];
  const now = Date.now();
  const out = list.filter((g) => g.status === 'out');
  $('#gear-out').textContent = String(out.length);
  $('#gear-overdue').textContent = String(out.filter((g) => g.dueAt && new Date(g.dueAt).getTime() < now).length);
  $('#gear-returned').textContent = String(list.filter((g) => g.status === 'returned').length);
  container.innerHTML = list.length
    ? gearSorted().map(gearRowHTML).join('')
    : '<div class="empty-row">还没有登记器材。点“登记借出”记录第一件。</div>';
}

function mistakeCardHTML(item) {
  return `
    <div class="mistake-card" data-id="${esc(item.id)}">
      <div class="mistake-head">
        <span class="mistake-course">${esc(item.course || '未分课程')}</span>
        ${item.title ? `<span class="mistake-src">${esc(item.title)}</span>` : ''}
        <span class="mistake-src">· ${esc(relativeSince(item.wrongAt))}</span>
        <span class="notice-chip ${item.source === 'chaoxing' ? 'cx' : ''}">${item.source === 'chaoxing' ? '自动归档' : '手动记录'}</span>
        <span style="margin-left:auto"></span>
        <button class="task-action" data-act="edit-mistake" data-id="${esc(item.id)}" title="编辑" aria-label="编辑"><svg><use href="#i-edit"/></svg></button>
        <button class="task-action danger" data-act="delete-mistake" data-id="${esc(item.id)}" title="删除" aria-label="删除"><svg><use href="#i-trash"/></svg></button>
      </div>
      <div class="mistake-q">${esc(item.question)}</div>
      <div class="mistake-answers">
        <div class="answer-box wrong"><span>我的答案</span>${esc(item.myAnswer || '未记录')}</div>
        <div class="answer-box right"><span>正确答案</span>${esc(item.correctAnswer || '未记录')}</div>
      </div>
      ${item.analysis ? `<div class="mistake-note"><strong>错题原因</strong>${esc(item.analysis)}</div>` : ''}
      ${item.tags && item.tags.length ? `<div class="mistake-tags">${item.tags.map((t) => `<span class="mistake-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function renderMistakes() {
  const container = $('#mistake-list');
  if (!container) return;
  const list = App.state.mistakes || [];
  const courses = [...new Set(list.map((m) => m.course).filter(Boolean))];
  const select = $('#mistake-filter');
  if (select) {
    const current = App.mistakeFilter;
    select.innerHTML = '<option value="all">全部课程</option>'
      + courses.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    select.value = courses.includes(current) ? current : 'all';
    App.mistakeFilter = select.value;
  }
  const visible = App.mistakeFilter === 'all' ? list : list.filter((m) => m.course === App.mistakeFilter);
  $('#mistake-total').textContent = String(list.length);
  const week = 7 * 86400000;
  $('#mistake-week').textContent = String(list.filter((m) => Date.now() - new Date(m.wrongAt).getTime() <= week).length);
  $('#mistake-courses').textContent = String(courses.length);
  container.innerHTML = visible.length
    ? visible.map(mistakeCardHTML).join('')
    : '<div class="empty-row">还没有错题。可点“从学习通归档”读取已批阅作业，或手动补录。</div>';
}

function renderIntegration() {
  const auth = App.auth;
  const sync = App.state.sync || {};
  const logged = Boolean(auth && auth.loggedIn);
  const account = sync.accountLabel || (auth && auth.name) || '未登录';
  $('#cx-account').textContent = logged ? account : '未登录';
  $('#cx-login-hint').textContent = logged ? '账号信息仅保存在本机浏览器分区' : '在左侧窗口扫码或输入账号';
  $('#cx-avatar').textContent = logged ? (account.slice(0, 1) || '学') : '学';
  $('#cx-last-sync').textContent = relativeSince(sync.lastSyncAt);
  $('#cx-last-count').textContent = `${sync.recognized || 0} 项`;
  $('#cx-course-count').textContent = `${sync.courses || 0} 门`;
  $('#set-auto-sync-inline').checked = Boolean(App.state.settings.autoSync);
  $('#set-auto-add-inline').checked = Boolean(App.state.settings.autoAddFromChaoxing);

  const pill = $('#cx-status-pill');
  if (App.syncInFlight) {
    pill.className = 'sync-status-pill busy';
    pill.innerHTML = '<span class="dot"></span>正在读取学习通…';
  } else if (logged && sync.lastResult === 'error') {
    pill.className = 'sync-status-pill error';
    pill.innerHTML = `<span class="dot"></span>${esc(sync.error || '同步异常')}`;
  } else if (logged) {
    pill.className = 'sync-status-pill online';
    pill.innerHTML = '<span class="dot"></span>已登录 · 可以同步';
  } else {
    pill.className = 'sync-status-pill';
    pill.innerHTML = '<span class="dot"></span>等待登录';
  }
  updateSyncButtons();

  const candidates = App.state.candidates || [];
  $('#candidate-count').textContent = String(candidates.length);
  const list = $('#candidate-list');
  if (!candidates.length) {
    list.innerHTML = '<div class="candidate-empty">暂时没有待确认项。<br>识别到作业标题但缺少截止时间时，会出现在这里。</div>';
  } else {
    list.innerHTML = candidates.slice(0, 8).map((c) => `
      <div class="candidate-item">
        <div class="candidate-title" title="${esc(c.title)}">${esc(c.title)}</div>
        <div class="candidate-meta">
          <span>${esc(c.course || (c.type === 'exam' ? '考试' : '作业'))} · ${esc(c.reason === 'no_deadline' ? '缺少截止时间' : '未自动加入')}</span>
          <span class="candidate-actions">
            <button data-act="candidate-add" data-id="${esc(c.id)}">设为日程</button>
            <button class="dismiss" data-act="candidate-dismiss" data-id="${esc(c.id)}">忽略</button>
          </span>
        </div>
      </div>`).join('');
  }
}

function updateSyncButtons() {
  const busy = App.syncInFlight;
  ['#btn-cx-sync', '#cx-sync-btn', '#btn-sync-top'].forEach((sel) => {
    const btn = $(sel);
    if (!btn) return;
    btn.disabled = busy;
    const span = btn.querySelector('span');
    if (span) span.textContent = busy ? '同步中…' : (sel === '#cx-sync-btn' ? '同步作业与考试' : '立即同步');
  });
  const scan = $('#cx-scan-btn');
  if (scan) scan.disabled = busy;
}

function renderSettings() {
  const s = App.state.settings;
  const setCheck = (id, value) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.checked = Boolean(value);
  };
  setCheck('#set-auto-sync-inline', s.autoSync);
  setCheck('#set-auto-add-inline', s.autoAddFromChaoxing);
  setCheck('#set-sound', s.sound);
  setCheck('#set-quiet', s.quietHours && s.quietHours.enabled);
  setCheck('#set-auto-launch', s.autoLaunch);
  setCheck('#set-close-tray', s.closeToTray);
  setCheck('#set-auto-sync', s.autoSync);
  setCheck('#set-auto-add', s.autoAddFromChaoxing);
  const interval = $('#set-sync-interval');
  if (interval && document.activeElement !== interval) interval.value = String(s.autoSyncIntervalMin || 30);
  $('#quiet-row').hidden = !(s.quietHours && s.quietHours.enabled);
  const qs = $('#quiet-start');
  const qe = $('#quiet-end');
  if (qs && document.activeElement !== qs) qs.value = (s.quietHours && s.quietHours.start) || '23:00';
  if (qe && document.activeElement !== qe) qe.value = (s.quietHours && s.quietHours.end) || '07:00';

  const offsets = new Set(s.reminderOffsets || []);
  $$('#reminder-offset-chips input').forEach((input) => { input.checked = offsets.has(Number(input.value)); });

  const mirror = s.logMirrorDir
    ? `${s.logMirrorDir.replace(/[\\/]$/, '')}${/process_logs$/i.test(s.logMirrorDir) ? '' : '\\process_logs'}`
    : '未设置';
  $('#set-mirror-dir').textContent = mirror;
  $('#set-mirror-dir').title = mirror;
}

function renderLogs() {
  if (!App.logs) return;
  const logs = App.logs;
  const days = logs.days || [];
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].hasData) streak += 1;
    else break;
  }
  $('#log-days').textContent = String(streak);
  $('#log-today').textContent = String((logs.today && logs.today.events) || 0);
  $('#log-errors').textContent = String((logs.totals && logs.totals.errors) || 0);
  $('#log-syncs').textContent = String((logs.totals && logs.totals.syncs) || 0);
  $('#log-session').textContent = `会话 ${String(logs.session || '').slice(0, 8)}`;
  $('#log-local-path').textContent = logs.logDir || '—';
  $('#log-local-path').title = logs.logDir || '';
  $('#log-mirror-path').textContent = logs.mirrorDir || '未设置';
  $('#log-mirror-path').title = logs.mirrorDir || '';

  const max = Math.max(1, ...days.map((d) => d.events));
  $('#log-chart').innerHTML = days.map((d, i) => {
    const height = d.events ? Math.max(10, Math.round((d.events / max) * 88)) : 4;
    return `
      <div class="log-col ${d.errors ? 'has-errors' : ''} ${i === days.length - 1 ? 'today' : ''}">
        <div class="log-bar-wrap"><div class="log-bar" style="height:${height}%">${d.events ? `<span class="log-bar-value">${d.events}</span>` : ''}</div></div>
        <div class="log-col-label"><strong>${esc(d.label)}</strong>${esc(d.weekday)}${d.hasData ? '' : '<br>无记录'}</div>
      </div>`;
  }).join('');

  const recent = logs.recent || [];
  // 已恢复（例如主接口 403 但备用通道成功）不算异常，避免整屏红字吓人
  const visible = App.logsErrorOnly
    ? recent.filter((e) => e.ok === false && !(e.meta && e.meta.recovered))
    : recent;
  const body = $('#event-body');
  if (!visible.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-cell">${App.logsErrorOnly ? '没有异常事件' : '今天还没有运行事件'}</td></tr>`;
    return;
  }
  body.innerHTML = visible.map((e) => {
    const label = EVENT_LABEL[e.event] || e.event;
    const meta = summarizeMeta(e.meta);
    // 历史日志没有 meta.recovered，所以按事件类型兜底识别“可降级”事件
    const DEGRADED = new Set(['task_feed_error', 'task_feed_error_waf', 'course_list_error', 'course_tasks_error']);
    const recovered = Boolean(e.meta && e.meta.recovered) || DEGRADED.has(e.event);
    // 三态展示：正常 / 已恢复（备用成功）/ 异常
    const badge = e.ok
      ? '<span class="ok-badge">正常</span>'
      : (recovered
        ? '<span class="recover-badge">已恢复</span>'
        : '<span class="err-badge">异常</span>');
    const note = recovered ? `${e.error || 'HTTP_403'}（备用通道已成功）` : (e.error || meta || '—');
    return `<tr>
      <td class="muted-cell">${esc((e.local || '').slice(5))}</td>
      <td><span class="event-name">${esc(label)}</span></td>
      <td>${badge}</td>
      <td class="muted-cell">${e.duration_ms ? `${e.duration_ms} ms` : '—'}</td>
      <td class="${e.error ? 'error-text' : 'muted-cell'}" title="${esc(note)}">${esc(note)}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------- logs */

async function loadLogs() {
  try {
    App.logs = await api.logSummary();
    App.logsLoaded = true;
    renderLogs();
  } catch (error) {
    toast(`日志读取失败：${error.message || error}`, 'error');
  }
}

/* ---------------------------------------------------------- integration UI */

function initWebview() {
  if (App.webviewInitialized) return;
  const wv = $('#cx-webview');
  App.webviewInitialized = true;
  if (!wv) {
    updateAddress();
    return;
  }
  const target = App.auth && App.auth.loggedIn
    ? (App.meta.homeUrl || 'https://i.chaoxing.com/')
    : (App.meta.loginUrl || 'https://passport2.chaoxing.com/login');

  wv.addEventListener('did-start-loading', () => {
    App.webviewLoading = true;
    $('#cx-loading').hidden = false;
    updateAddress();
  });
  wv.addEventListener('did-stop-loading', () => {
    App.webviewLoading = false;
    $('#cx-loading').hidden = true;
    updateAddress();
    checkAuth(true);
  });
  wv.addEventListener('dom-ready', () => {
    updateAddress();
  });
  wv.addEventListener('did-navigate', updateAddress);
  wv.addEventListener('did-navigate-in-page', updateAddress);
  wv.addEventListener('did-fail-load', (event) => {
    App.webviewLoading = false;
    $('#cx-loading').hidden = true;
    if (event.isMainFrame === false || event.errorCode === -3) return;
    toast(`学习通页面加载失败（${event.errorCode || ''}）`, 'error', 4200);
  });
  wv.addEventListener('page-title-updated', () => updateAddress());
  try {
    wv.setAttribute('src', target);
  } catch (_) {
    wv.src = target;
  }
  updateAddress();
}

function updateAddress() {
  const wv = $('#cx-webview');
  const el = $('#cx-address');
  if (!el) return;
  if (!wv) {
    el.textContent = '学习通登录 · 独立安全窗口';
    return;
  }
  let url = '';
  try { url = wv.getURL(); } catch (_) { url = ''; }
  if (!url) url = wv.getAttribute('src') || '';
  if (!url || url === 'about:blank') {
    el.textContent = '正在打开学习通…';
    return;
  }
  el.textContent = url.replace(/^https?:\/\//, '').slice(0, 110);
  el.title = url;
}

async function checkAuth(triggerSync = false) {
  if (App.authChecking) return;
  App.authChecking = true;
  try {
    const auth = await api.cxStatus();
    const wasLogged = Boolean(App.auth && App.auth.loggedIn);
    App.auth = auth;
    renderTitlebar();
    renderIntegration();
    renderSidebar();
    renderDashboard();
    if (auth.loggedIn && !wasLogged) {
      toast('已检测到学习通登录，准备同步作业。', 'success');
    }
    if (auth.loggedIn && triggerSync && !App.loginSyncTriggered && App.state.settings.autoSync) {
      App.loginSyncTriggered = true;
      const last = App.state.sync.lastAttemptAt ? new Date(App.state.sync.lastAttemptAt).getTime() : 0;
      if (Date.now() - last > 5 * 60000) {
        setTimeout(() => syncNow({ silent: true }), 900);
      }
    }
    if (!auth.loggedIn) App.loginSyncTriggered = false;
  } catch (error) {
    console.error(error);
  } finally {
    App.authChecking = false;
  }
}

async function syncNow({ silent = false } = {}) {
  if (App.syncInFlight) return;
  if (!App.auth || !App.auth.loggedIn) {
    setPage('integration');
    try {
      App.auth = await api.cxStatus();
      renderIntegration();
    } catch (_) { /* ignore */ }
    if (!App.auth || !App.auth.loggedIn) {
      toast('请先打开学习通登录窗口完成登录。', 'info', 3600);
      api.openLogin().catch(() => {});
      return;
    }
  }
  App.syncInFlight = true;
  renderTitlebar();
  renderIntegration();
  updateSyncButtons();
  try {
    const result = await api.cxSync();
    if (result && result.ok) {
      const payload = await api.getState();
      applyPayload(payload);
      if (!silent) toast(result.message || '同步完成', 'success', 3600);
      if (result.merge && result.merge.missed) {
        toast(`有 ${result.merge.missed} 项作业已经错过，无法补交。下次截止前 24 小时先交。`, 'error', 6200);
      }
      App.loginSyncTriggered = true;
      await loadLogs();
    } else {
      if (!silent) toast((result && result.message) || '同步失败，请稍后重试', 'error', 5200);
    }
  } catch (error) {
    if (!silent) toast(`同步失败：${error.message || error}`, 'error', 5000);
  } finally {
    App.syncInFlight = false;
    renderTitlebar();
    renderIntegration();
    updateSyncButtons();
    try { App.auth = await api.cxStatus(); } catch (_) { /* ignore */ }
    renderDashboard();
  }
}

async function scanPage() {
  if (App.syncInFlight) return;
  App.syncInFlight = true;
  updateSyncButtons();
  try {
    const result = await api.cxScanPage();
    const count = (result.rows || []).length;
    const added = result.merged ? result.merged.added : 0;
    if (count) toast(`扫描到 ${count} 条候选，新增 ${added} 项日程。`, 'success', 4200);
    else toast('当前页面没有识别到作业或待办条目。可在课程作业页再试。', 'info', 4200);
    applyPayload(await api.getState());
    await loadLogs();
  } catch (error) {
    toast(`页面扫描失败：${error.message || error}`, 'error', 4200);
  } finally {
    App.syncInFlight = false;
    updateSyncButtons();
  }
}

/* ------------------------------------------------------------------ modal */

function openTaskModal(task = null, candidate = null) {
  const modal = $('#task-modal');
  const form = $('#task-form');
  form.reset();
  $('#task-form-error').hidden = true;
  $('#task-delete').hidden = true;
  $('#task-id').value = '';
  $('#task-no-deadline').checked = false;
  $('#task-due').disabled = false;
  $('#task-source-key').value = '';
  $('#task-source-url').value = '';
  App.editingId = null;

  if (task) {
    App.editingId = task.id;
    $('#task-modal-eyebrow').textContent = '编辑';
    $('#task-modal-title').textContent = '编辑日程';
    $('#task-id').value = task.id;
    $('#task-title').value = task.title;
    $('#task-course').value = task.course || '';
    $('#task-no-deadline').checked = Boolean(task.noDeadline);
    $('#task-due').value = task.noDeadline ? '' : toLocalInput(task.dueAt);
    $('#task-due').disabled = Boolean(task.noDeadline);
    setRadio('task-category', task.category);
    setRadio('task-priority', task.priority);
    $('#task-recurrence').value = task.recurrence || 'none';
    $('#task-notes').value = task.notes || '';
    $('#task-source-key').value = task.sourceKey || '';
    $('#task-source-url').value = task.sourceUrl || '';
    setOffsets('#task-offset-chips', task.reminderOffsets || []);
    $('#task-delete').hidden = false;
    $('#task-save').textContent = '保存修改';
  } else {
    $('#task-modal-eyebrow').textContent = candidate ? '识别结果' : '新建';
    $('#task-modal-title').textContent = candidate ? '补全并加入日程' : '新建日程';
    const defaultDue = new Date();
    defaultDue.setSeconds(0, 0);
    defaultDue.setMinutes(0);
    defaultDue.setHours(defaultDue.getHours() + 1);
    if (defaultDue.getHours() < 8) defaultDue.setHours(9);
    const candidateNoDue = Boolean(candidate && !candidate.dueAt);
    $('#task-no-deadline').checked = candidateNoDue;
    $('#task-due').disabled = candidateNoDue;
    $('#task-due').value = candidateNoDue ? '' : (candidate ? '' : toLocalInput(defaultDue));
    setRadio('task-category', candidate && candidate.type === 'exam' ? 'exam' : 'homework');
    setRadio('task-priority', 'normal');
    setOffsets('#task-offset-chips', App.state.settings.reminderOffsets || [60, 10]);
    $('#task-recurrence').value = 'none';
    if (candidate) {
      $('#task-title').value = candidate.title || '';
      $('#task-course').value = candidate.course || '';
      $('#task-source-key').value = candidate.sourceKey || '';
      $('#task-source-url').value = candidate.sourceUrl || '';
      $('#task-save').textContent = '加入日程';
    } else {
      $('#task-save').textContent = '保存日程';
    }
  }

  modal.hidden = false;
  App.modalOpen = true;
  setTimeout(() => {
    if (candidate) $('#task-due').focus();
    else $('#task-title').focus();
  }, 80);
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
  if (input) input.checked = true;
}

function getRadio(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : '';
}

function setOffsets(selector, offsets) {
  const set = new Set((offsets || []).map(Number));
  $$(`${selector} input`).forEach((input) => { input.checked = set.has(Number(input.value)); });
}

function getOffsets(selector) {
  return $$(`${selector} input:checked`).map((input) => Number(input.value)).filter((n) => Number.isFinite(n));
}

function closeTaskModal() {
  $('#task-modal').hidden = true;
  App.modalOpen = false;
  App.editingId = null;
}

function showFormError(message) {
  const el = $('#task-form-error');
  el.textContent = message;
  el.hidden = false;
}

async function saveTask(event) {
  event.preventDefault();
  const title = $('#task-title').value.trim();
  const dueValue = $('#task-due').value;
  const noDeadline = $('#task-no-deadline').checked;
  const dueAt = noDeadline ? null : fromLocalInput(dueValue);
  if (!title) { showFormError('请填写任务标题。'); $('#task-title').focus(); return; }
  if (!noDeadline && !dueAt) { showFormError('请选择截止时间，或勾选“无截止时间”。'); $('#task-due').focus(); return; }
  const offsets = getOffsets('#task-offset-chips');
  const payload = {
    title,
    course: $('#task-course').value.trim(),
    dueAt,
    noDeadline,
    category: getRadio('task-category') || 'homework',
    priority: getRadio('task-priority') || 'normal',
    recurrence: $('#task-recurrence').value || 'none',
    notes: $('#task-notes').value.trim(),
    reminderOffsets: offsets,
    source: $('#task-source-key').value ? 'chaoxing' : 'manual',
    sourceKey: $('#task-source-key').value || '',
    sourceUrl: $('#task-source-url').value || ''
  };
  try {
    if (App.editingId) {
      await api.updateTask(App.editingId, payload);
      toast('日程已更新。', 'success');
    } else {
      await api.addTask(payload);
      toast('已加入日程，提醒会按设置触发。', 'success');
      if (payload.sourceKey) {
        const candidate = (App.state.candidates || []).find((c) => c.sourceKey === payload.sourceKey);
        if (candidate) await api.dismissCandidate(candidate.id);
      }
    }
    closeTaskModal();
    applyPayload(await api.getState());
    loadLogs();
  } catch (error) {
    showFormError(error.message || '保存失败，请稍后重试。');
  }
}

async function quitApp() {
  const ok = await confirmAction({
    title: '终止课铃？',
    text: '课铃和本地服务会立即关闭，之后不会再提醒，直到你重新打开。',
    okText: '终止运行',
    icon: 'i-power'
  });
  if (!ok) return;
  try { await api.quit(); } catch (_) { /* host exits */ }
}

function confirmAction({ title, text, okText = '确认', danger = true, icon = 'i-trash' }) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okText;
    $('#confirm-ok').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('#confirm-icon').innerHTML = `<svg><use href="#${icon}"/></svg>`;
    $('#confirm-modal').hidden = false;
    App.modalOpen = true;
    App.confirmResolver = resolve;
    setTimeout(() => $('#confirm-ok').focus(), 60);
  });
}

function resolveConfirm(value) {
  $('#confirm-modal').hidden = true;
  App.modalOpen = false;
  if (App.confirmResolver) {
    const fn = App.confirmResolver;
    App.confirmResolver = null;
    fn(value);
  }
}

/* --------------------------------------------------------------- page nav */

function mountLogsInSettings() {
  const logsPage = $('#page-logs');
  const settingsPage = $('#page-settings');
  if (!logsPage || !settingsPage || logsPage.parentElement === settingsPage) return;
  logsPage.classList.remove('page');
  logsPage.classList.add('settings-log-section');
  settingsPage.appendChild(logsPage);
}

function buildUiScaleOptions() {
  const box = $('#ui-scale');
  if (!box) return;
  if (!box.dataset.built) {
    box.innerHTML = UI_SCALES
      .map((item) => `<button class="seg" data-scale="${item.value}" title="${item.note}">${item.label}</button>`)
      .join('');
    box.dataset.built = '1';
  }
}

function currentUiScale() {
  // 服务端 settings 是唯一可信来源（端口无关）；
  // localStorage 仅在旧版本迁移时作为回退。
  const fromServer = App.state && App.state.settings ? Number(App.state.settings.uiScale) : NaN;
  const raw = Number.isFinite(fromServer) && fromServer > 0
    ? fromServer
    : Number(localStorage.getItem('campus:uiScale') || DEFAULT_UI_SCALE);
  return UI_SCALES.some((item) => item.value === raw) ? raw : DEFAULT_UI_SCALE;
}

function migrateUiScale() {
  // The first builds shipped a 100% default that read too small on high-DPI
  // screens; nudge existing profiles up once, without overriding a later choice.
  try {
    if (localStorage.getItem('campus:uiScaleV2')) return;
    const raw = localStorage.getItem('campus:uiScale');
    if (!raw || Number(raw) === 1) localStorage.setItem('campus:uiScale', String(DEFAULT_UI_SCALE));
    localStorage.setItem('campus:uiScaleV2', '1');
  } catch (_) { /* ignore */ }
}

function applySavedUiScale() {
  migrateUiScale();
  buildUiScaleOptions();
  applyUiScale(currentUiScale());
}

function applyUiScale(scale) {
  document.documentElement.style.zoom = String(scale);
  $$('#ui-scale .seg').forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.scale) === scale));
  const note = UI_SCALES.find((item) => item.value === scale);
  const hint = $('#ui-scale-hint');
  if (hint && note) hint.textContent = `当前 ${note.label} · ${note.note}`;
}

/** 首次使用引导：把“界面大小”摆在第一屏，避免用户以为页面糊或字太小。 */
function scaleGuidePending() {
  // 注意：不要只依赖 localStorage —— 本地服务端口每次启动都变，源一变存储就丢。
  const fromServer = App.state && App.state.settings ? App.state.settings.scaleGuideDone : false;
  if (fromServer) return false;
  try { return localStorage.getItem('campus:scaleGuideDone') !== '1'; } catch (_) { return true; }
}

function openScaleGuide() {
  const box = $('#scale-guide-options');
  if (!box) return;
  // 引导的每一步都不应阻塞弹窗显示：先显示，再填充内容。
  $('#scale-guide-modal').hidden = false;
  App.modalOpen = true;
  box.innerHTML = UI_SCALES
    .map((item) => `<button class="seg" data-scale="${item.value}">${item.label}</button>`)
    .join('');
  const current = currentUiScale();
  $$("#scale-guide-options .seg").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.scale) === current));
  const picked = UI_SCALES.find((i) => i.value === current) || UI_SCALES[1];
  $('#scale-guide-hint').textContent = `当前 ${picked.label} · ${picked.note}`;
}

function closeScaleGuide() {
  $('#scale-guide-modal').hidden = true;
  App.modalOpen = false;
  try { localStorage.setItem('campus:scaleGuideDone', '1'); } catch (_) { /* ignore */ }
  if (App.state && App.state.settings) App.state.settings.scaleGuideDone = true;
  api.updateSettings({ scaleGuideDone: true }).catch(() => { /* 离线时忽略 */ });
}

function setUiScale(scale) {
  const value = UI_SCALES.some((item) => item.value === Number(scale)) ? Number(scale) : DEFAULT_UI_SCALE;
  applyUiScale(value);
  // 双写：服务端保证重启后仍生效；localStorage 只作即时缓存
  try { localStorage.setItem('campus:uiScale', String(value)); } catch (_) { /* ignore */ }
  if (App.state && App.state.settings) App.state.settings.uiScale = value;
  api.updateSettings({ uiScale: value }).catch(() => { /* 离线时忽略 */ });
}

function stepUiScale(direction) {
  const list = UI_SCALES.map((item) => item.value);
  let index = list.indexOf(currentUiScale());
  if (index < 0) index = 1;
  index = Math.min(list.length - 1, Math.max(0, index + direction));
  setUiScale(list[index]);
  toast(`界面大小：${UI_SCALES[index].label}（${UI_SCALES[index].note}）`, 'info', 1600);
}

/* --------------------------------------------- notices / gear / mistakes UI */

async function refreshState() {
  try {
    applyPayload(await api.getState());
  } catch (_) { /* keep current view */ }
}

async function toggleNotice(id) {
  const notice = (App.state.notices || []).find((n) => n.id === id);
  if (!notice) return;
  const open = App.noticeOpen.has(id);
  if (open) {
    App.noticeOpen.delete(id);
  } else {
    App.noticeOpen.add(id);
    if (!notice.read) {
      try { await api.updateNotice(id, { read: true }); } catch (_) { /* ignore */ }
      notice.read = true;
    }
  }
  renderNotices();
  renderSidebar();
}

async function readNotice(id) {
  const notice = (App.state.notices || []).find((n) => n.id === id);
  if (!notice) return;
  const next = !notice.read;
  try {
    await api.updateNotice(id, { read: next });
    notice.read = next;
    renderNotices();
    renderSidebar();
  } catch (error) {
    toast(`更新失败：${error.message || error}`, 'error');
  }
}

async function deleteNotice(id) {
  const ok = await confirmAction({
    title: '删除这条通知？',
    text: '只删除本机记录，不影响学习通里的原始通知。',
    okText: '删除', icon: 'i-trash'
  });
  if (!ok) return;
  try {
    await api.deleteNotice(id);
    App.noticeOpen.delete(id);
    await refreshState();
    toast('通知已删除。', 'success');
  } catch (error) {
    toast(`删除失败：${error.message || error}`, 'error');
  }
}

async function extractNotices() {
  const button = $('#btn-extract-notices');
  if (button) button.disabled = true;
  try {
    const result = await api.extractNotices();
    await refreshState();
    if (result && result.added) toast(`提取完成，新增 ${result.added} 条通知。`, 'success', 4200);
    else toast('没有新的通知；本地关键事件已经是最新的。', 'info', 4200);
  } catch (error) {
    toast(`提取失败：${error.message || error}`, 'error', 5000);
  } finally {
    if (button) button.disabled = false;
  }
}

async function readAllNotices() {
  try {
    const result = await api.readAllNotices();
    await refreshState();
    toast(result && result.updated ? `已标记 ${result.updated} 条为已读。` : '没有未读通知。', 'success');
  } catch (error) {
    toast(`操作失败：${error.message || error}`, 'error');
  }
}

function openNoticeModal() {
  $('#notice-form').reset();
  $('#notice-kind').value = 'notice';
  $('#notice-modal').hidden = false;
  App.modalOpen = true;
  setTimeout(() => $('#notice-title').focus(), 80);
}

function closeNoticeModal() {
  $('#notice-modal').hidden = true;
  App.modalOpen = false;
}

async function saveNotice(event) {
  event.preventDefault();
  const title = $('#notice-title').value.trim();
  if (!title) { toast('请填写通知标题。', 'error'); $('#notice-title').focus(); return; }
  try {
    await api.addNotice({
      title,
      course: $('#notice-course').value.trim(),
      kind: $('#notice-kind').value,
      body: $('#notice-body').value.trim(),
      source: 'manual'
    });
    closeNoticeModal();
    await refreshState();
    toast('通知已保存。', 'success');
  } catch (error) {
    toast(`保存失败：${error.message || error}`, 'error');
  }
}

function gearNowInput() {
  const d = new Date();
  d.setSeconds(0, 0);
  return toLocalInput(d);
}

function openGearModal(item = null) {
  const form = $('#gear-form');
  form.reset();
  $('#gear-id').value = item ? item.id : '';
  $('#gear-modal-title').textContent = item ? '编辑器材记录' : '登记借出';
  $('#gear-save').textContent = item ? '保存修改' : '登记借出';
  if (item) {
    $('#gear-name').value = item.name;
    $('#gear-code').value = item.code || '';
    $('#gear-borrower').value = item.borrower || '';
    $('#gear-borrowed').value = item.borrowedAt ? toLocalInput(item.borrowedAt) : gearNowInput();
    $('#gear-due').value = item.dueAt ? toLocalInput(item.dueAt) : '';
    $('#gear-note').value = item.note || '';
  } else {
    $('#gear-borrowed').value = gearNowInput();
    const due = new Date();
    due.setDate(due.getDate() + 7);
    due.setSeconds(0, 0);
    $('#gear-due').value = toLocalInput(due);
  }
  $('#gear-modal').hidden = false;
  App.modalOpen = true;
  setTimeout(() => $('#gear-name').focus(), 80);
}

function closeGearModal() {
  $('#gear-modal').hidden = true;
  App.modalOpen = false;
}

async function saveGear(event) {
  event.preventDefault();
  const name = $('#gear-name').value.trim();
  if (!name) { toast('请填写器材名称。', 'error'); $('#gear-name').focus(); return; }
  const payload = {
    name,
    code: $('#gear-code').value.trim(),
    borrower: $('#gear-borrower').value.trim(),
    borrowedAt: fromLocalInput($('#gear-borrowed').value) || new Date().toISOString(),
    dueAt: fromLocalInput($('#gear-due').value) || '',
    note: $('#gear-note').value.trim()
  };
  const id = $('#gear-id').value;
  try {
    if (id) await api.updateGear(id, payload);
    else await api.addGear(payload);
    closeGearModal();
    await refreshState();
    toast(id ? '器材记录已更新。' : '已登记借出，到期会提醒你归还。', 'success');
  } catch (error) {
    toast(`保存失败：${error.message || error}`, 'error');
  }
}

async function returnGear(id) {
  const ok = await confirmAction({
    title: '确认已归还？',
    text: '会把这条记录标成已归还，并停止逾期提醒。',
    okText: '已归还', danger: false, icon: 'i-check'
  });
  if (!ok) return;
  try {
    await api.returnGear(id, { condition: '正常' });
    await refreshState();
    toast('已核对归还。', 'success');
  } catch (error) {
    toast(`操作失败：${error.message || error}`, 'error');
  }
}

async function deleteGear(id) {
  const ok = await confirmAction({
    title: '删除这条器材记录？',
    text: '删除后不再参与借还核对。',
    okText: '删除', icon: 'i-trash'
  });
  if (!ok) return;
  try {
    await api.deleteGear(id);
    await refreshState();
    toast('记录已删除。', 'success');
  } catch (error) {
    toast(`删除失败：${error.message || error}`, 'error');
  }
}

function gearCheck() {
  const out = (App.state.gear || []).filter((g) => g.status === 'out');
  const overdue = out.filter((g) => g.dueAt && new Date(g.dueAt).getTime() < Date.now());
  if (!out.length) toast('目前没有借出中的器材。', 'info', 3600);
  else if (overdue.length) toast(`核对：${out.length} 件未还，其中 ${overdue.length} 件已逾期。`, 'error', 5200);
  else toast(`核对：${out.length} 件借出中，都在应还时间内。`, 'success', 4200);
}

function openMistakeModal(item = null) {
  const form = $('#mistake-form');
  form.reset();
  $('#mistake-id').value = item ? item.id : '';
  $('#mistake-modal-title').textContent = item ? '编辑错题' : '记录一道错题';
  $('#mistake-save').textContent = item ? '保存修改' : '归档';
  if (item) {
    $('#mistake-course').value = item.course || '';
    $('#mistake-title').value = item.title || '';
    $('#mistake-question').value = item.question || '';
    $('#mistake-my').value = item.myAnswer || '';
    $('#mistake-correct').value = item.correctAnswer || '';
    $('#mistake-analysis').value = item.analysis || '';
    $('#mistake-tags').value = (item.tags || []).join(',');
  } else {
    $('#mistake-course').value = App.mistakeFilter !== 'all' ? App.mistakeFilter : '';
  }
  $('#mistake-modal').hidden = false;
  App.modalOpen = true;
  setTimeout(() => $('#mistake-question').focus(), 80);
}

function closeMistakeModal() {
  $('#mistake-modal').hidden = true;
  App.modalOpen = false;
}

async function saveMistake(event) {
  event.preventDefault();
  const question = $('#mistake-question').value.trim();
  if (!question) { toast('请填写题目。', 'error'); $('#mistake-question').focus(); return; }
  const payload = {
    course: $('#mistake-course').value.trim(),
    title: $('#mistake-title').value.trim(),
    question,
    myAnswer: $('#mistake-my').value.trim(),
    correctAnswer: $('#mistake-correct').value.trim(),
    analysis: $('#mistake-analysis').value.trim(),
    tags: $('#mistake-tags').value.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
    source: 'manual'
  };
  const id = $('#mistake-id').value;
  try {
    if (id) await api.updateMistake(id, payload);
    else await api.addMistake(payload);
    closeMistakeModal();
    await refreshState();
    toast(id ? '错题已更新。' : '错题已归档。', 'success');
  } catch (error) {
    toast(`保存失败：${error.message || error}`, 'error');
  }
}

async function deleteMistake(id) {
  const ok = await confirmAction({
    title: '删除这道错题？',
    text: '删除后不再出现在错题本。',
    okText: '删除', icon: 'i-trash'
  });
  if (!ok) return;
  try {
    await api.deleteMistake(id);
    await refreshState();
    toast('错题已删除。', 'success');
  } catch (error) {
    toast(`删除失败：${error.message || error}`, 'error');
  }
}

async function scanCurrentWorkPage() {
  const button = $('#btn-scan-mistakes');
  if (button) button.disabled = true;
  try {
    const page = await api.scanLoginPage();
    if (!page || page.needLogin) {
      toast('请先在登录窗口打开“已批改”的作业详情页，再点一次扫描。', 'info', 5200);
      return;
    }
    if (!/chaoxing\.com/i.test(page.url || '')) {
      toast('登录窗口当前不是学习通页面，请先打开作业详情页。', 'info', 5200);
      return;
    }
    const result = await api.importMistakesFromPage({
      text: page.text || '',
      url: page.url || '',
      title: page.title || '',
      frames: page.frames || 0,
      readableFrames: page.readableFrames || 0,
      course: ''
    });
    await refreshState();
    toast(result.message || '扫描完成。', result.added ? 'success' : 'info', 7000);
  } catch (error) {
    toast(`扫描失败：${error.message || error}`, 'error', 5200);
  } finally {
    if (button) button.disabled = false;
  }
}

/* --------------------------------------------------------- auto scan loop */

let autoScanTimer = null;
let lastAutoScanUrl = '';

function autoScanEnabled() {
  try { return localStorage.getItem('campus:autoScanMistakes') === '1'; } catch (_) { return false; }
}

function syncAutoScanUi() {
  const el = $('#auto-scan-mistakes');
  if (el) el.checked = autoScanEnabled();
}

async function autoScanTick() {
  try {
    const page = await api.scanLoginPage();
    if (!page || page.needLogin) return;
    if (!/chaoxing\.com/i.test(page.url || '')) return;
    if (page.url === lastAutoScanUrl) return;
    lastAutoScanUrl = page.url;
    if (!/我的答案|我的作答/.test(page.text || '')) return;
    const result = await api.importMistakesFromPage({
      text: page.text || '',
      url: page.url || '',
      title: page.title || '',
      frames: page.frames || 0,
      readableFrames: page.readableFrames || 0,
      course: ''
    });
    if (result && result.added) {
      await refreshState();
      toast(`自动归档 ${result.added} 道错题。`, 'success', 4200);
    }
  } catch (_) { /* the login window may be closed */ }
}

function startAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = setInterval(autoScanTick, 6000);
  autoScanTick();
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
}

function setAutoScan(enabled) {
  try { localStorage.setItem('campus:autoScanMistakes', enabled ? '1' : '0'); } catch (_) { /* ignore */ }
  if (enabled) {
    startAutoScan();
    toast('已开启自动扫描：打开已批改的作业页后会自动归档。', 'info', 3800);
  } else {
    stopAutoScan();
    toast('已关闭自动扫描。', 'info', 2600);
  }
}

async function extractMistakes() {
  const button = $('#btn-extract-mistakes');
  if (button) button.disabled = true;
  toast('正在读取已批阅作业，可能需要十几秒…', 'info', 3600);
  try {
    const result = await api.extractMistakes();
    await refreshState();
    toast(result.message || '归档完成。', result.added ? 'success' : 'info', 5200);
  } catch (error) {
    toast(`归档失败：${error.message || error}`, 'error', 5200);
  } finally {
    if (button) button.disabled = false;
  }
}

function setPage(page) {
  if (!page) return;
  if (page === 'logs') page = 'settings';
  App.page = page;
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $('#content').scrollTop = 0;
  if (page === 'logs') loadLogs();
  if (page === 'integration') {
    setTimeout(() => { updateAddress(); checkAuth(false); }, 120);
  }
  if (page === 'settings') renderSettings();
  if (App.lastPageView !== page) {
    App.lastPageView = page;
    try { localStorage.setItem('campus:lastPage', page); } catch (_) { /* ignore */ }
    if (App.state && App.state.settings) App.state.settings.lastPage = page;
    api.updateSettings({ lastPage: page }).catch(() => { /* ignore */ });
    api.pageView(page).catch(() => {});
  }
}

/* ----------------------------------------------------------------- events */

function bindEvents() {
  $('#btn-open-settings').addEventListener('click', () => setPage('settings'));
  $('#scale-guide-options').addEventListener('click', (event) => {
    const btn = event.target.closest('.seg');
    if (!btn) return;
    setUiScale(btn.dataset.scale);
    const note = UI_SCALES.find((i) => i.value === Number(btn.dataset.scale));
    $('#scale-guide-hint').textContent = `当前 ${note.label} · ${note.note}`;
  });
  $('#scale-guide-done').addEventListener('click', closeScaleGuide);
  // 设置页里的“重新查看字号引导”：只重开弹窗，不动任何本地文件
  $('#btn-reopen-scale-guide').addEventListener('click', () => {
    openScaleGuide();
  });
  $('#btn-min').addEventListener('click', () => api.windowAction('minimize'));
  $('#btn-max').addEventListener('click', () => api.windowAction('maximize'));
  $('#btn-close').addEventListener('click', () => api.windowAction('close'));
  $('#ui-scale').addEventListener('click', (event) => {
    const btn = event.target.closest('.seg');
    if (btn) setUiScale(btn.dataset.scale);
  });
  $('#btn-scroll-logs').addEventListener('click', () => {
    const logs = $('#page-logs');
    if (logs) logs.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btn-quit-app').addEventListener('click', quitApp);
  $('#btn-quit-side').addEventListener('click', quitApp);
  $('#titlebar').addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    api.windowAction('maximize');
  });
  api.onMaximized((max) => {
    const btn = $('#btn-max');
    btn.innerHTML = `<svg><use href="#${max ? 'i-restore' : 'i-max'}"/></svg>`;
    btn.title = max ? '还原' : '最大化';
  });

  $$('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
  document.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]');
    if (goto) { setPage(goto.dataset.goto); return; }
    const act = event.target.closest('[data-act]');
    if (!act) return;
    const id = act.dataset.id;
    switch (act.dataset.act) {
      case 'add': openTaskModal(); break;
      case 'edit': {
        const task = App.state.tasks.find((t) => t.id === id);
        if (task) openTaskModal(task);
        break;
      }
      case 'complete': completeTask(id); break;
      case 'delete': removeTask(id); break;
      case 'toggle': toggleTask(id); break;
      case 'candidate-add': {
        const candidate = (App.state.candidates || []).find((c) => c.id === id);
        if (candidate) openTaskModal(null, candidate);
        break;
      }
      case 'candidate-dismiss': dismissCandidate(id); break;
      case 'toggle-notice': toggleNotice(id); break;
      case 'read-notice': readNotice(id); break;
      case 'delete-notice': deleteNotice(id); break;
      case 'return-gear': returnGear(id); break;
      case 'edit-gear': {
        const item = (App.state.gear || []).find((g) => g.id === id);
        if (item) openGearModal(item);
        break;
      }
      case 'delete-gear': deleteGear(id); break;
      case 'edit-mistake': {
        const item = (App.state.mistakes || []).find((m) => m.id === id);
        if (item) openMistakeModal(item);
        break;
      }
      case 'delete-mistake': deleteMistake(id); break;
    }
  });

  $('#btn-add-top').addEventListener('click', () => openTaskModal());
  $('#btn-add-task').addEventListener('click', () => openTaskModal());
  $('#btn-sync-top').addEventListener('click', async () => {
    setPage('integration');
    try {
      const auth = await api.cxStatus();
      App.auth = auth;
      renderIntegration();
      if (auth.loggedIn) syncNow();
      else toast('请先在左侧窗口完成学习通登录。', 'info', 3600);
    } catch (_) { /* ignore */ }
  });
  $('#cx-mini-btn').addEventListener('click', () => {
    if (App.auth && App.auth.loggedIn) syncNow();
    else setPage('integration');
  });
  $('#welcome-login').addEventListener('click', () => {
    setPage('integration');
    markFirstRunDone();
    setTimeout(() => api.openLogin().catch(() => {}), 220);
  });
  $('#welcome-manual').addEventListener('click', () => { openTaskModal(); markFirstRunDone(); });
  $('#welcome-close').addEventListener('click', markFirstRunDone);

  $$('#status-tabs .seg').forEach((btn) => btn.addEventListener('click', () => {
    App.filters.status = btn.dataset.status;
    renderTasks();
  }));
  let searchTimer = null;
  $('#task-search').addEventListener('input', (event) => {
    App.filters.q = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTasks, 110);
  });
  $('#task-category').addEventListener('change', (event) => {
    App.filters.category = event.target.value;
    renderTasks();
  });

  $('#btn-cx-home').addEventListener('click', () => {
    api.openLogin().catch((error) => toast(`无法打开登录窗口：${error.message || error}`, 'error'));
  });
  $('#btn-cx-reload').addEventListener('click', () => {
    api.openLogin().catch((error) => toast(`无法打开登录窗口：${error.message || error}`, 'error'));
  });
  const openLoginBtn = $('#btn-cx-open-login');
  if (openLoginBtn) {
    openLoginBtn.addEventListener('click', () => {
      api.openLogin().catch((error) => toast(`无法打开登录窗口：${error.message || error}`, 'error'));
    });
  }
  $('#btn-cx-sync').addEventListener('click', () => syncNow());
  $('#cx-sync-btn').addEventListener('click', () => syncNow());
  $('#cx-scan-btn').addEventListener('click', async () => {
    await checkAuth(true);
    toast(App.auth && App.auth.loggedIn ? '已检测到学习通登录。' : '尚未检测到登录，请先在登录窗口完成扫码。', App.auth && App.auth.loggedIn ? 'success' : 'info', 3600);
  });
  $('#set-auto-sync-inline').addEventListener('change', (e) => updateSetting({ autoSync: e.target.checked }));
  $('#set-auto-add-inline').addEventListener('change', (e) => updateSetting({ autoAddFromChaoxing: e.target.checked }));

  $('#btn-extract-notices').addEventListener('click', extractNotices);
  $('#btn-add-notice').addEventListener('click', openNoticeModal);
  $('#btn-read-all').addEventListener('click', readAllNotices);
  $('#notice-form').addEventListener('submit', saveNotice);
  $('#notice-modal-close').addEventListener('click', closeNoticeModal);
  $('#notice-cancel').addEventListener('click', closeNoticeModal);
  $('#notice-modal').addEventListener('click', (event) => { if (event.target === $('#notice-modal')) closeNoticeModal(); });

  $('#btn-add-gear').addEventListener('click', () => openGearModal());
  $('#btn-gear-check').addEventListener('click', gearCheck);
  $('#gear-form').addEventListener('submit', saveGear);
  $('#gear-modal-close').addEventListener('click', closeGearModal);
  $('#gear-cancel').addEventListener('click', closeGearModal);
  $('#gear-modal').addEventListener('click', (event) => { if (event.target === $('#gear-modal')) closeGearModal(); });

  $('#btn-add-mistake').addEventListener('click', () => openMistakeModal());
  $('#btn-extract-mistakes').addEventListener('click', extractMistakes);
  $('#btn-scan-mistakes').addEventListener('click', scanCurrentWorkPage);
  $('#auto-scan-mistakes').addEventListener('change', (event) => setAutoScan(event.target.checked));
  $('#mistake-form').addEventListener('submit', saveMistake);
  $('#mistake-modal-close').addEventListener('click', closeMistakeModal);
  $('#mistake-cancel').addEventListener('click', closeMistakeModal);
  $('#mistake-modal').addEventListener('click', (event) => { if (event.target === $('#mistake-modal')) closeMistakeModal(); });
  $('#mistake-filter').addEventListener('change', (event) => {
    App.mistakeFilter = event.target.value;
    renderMistakes();
  });

  $('#task-form').addEventListener('submit', saveTask);
  $('#task-no-deadline').addEventListener('change', (event) => {
    const noDue = event.target.checked;
    $('#task-due').disabled = noDue;
    if (noDue) $('#task-due').value = '';
  });
  $('#task-modal-close').addEventListener('click', closeTaskModal);
  $('#task-cancel').addEventListener('click', closeTaskModal);
  $('#task-modal').addEventListener('click', (event) => { if (event.target === $('#task-modal')) closeTaskModal(); });
  $('#task-delete').addEventListener('click', async () => {
    if (!App.editingId) return;
    const ok = await confirmAction({ title: '删除这项日程？', text: '删除后无法恢复，相关的提醒也会一并取消。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteTask(App.editingId);
      closeTaskModal();
      applyPayload(await api.getState());
      toast('日程已删除。', 'success');
    } catch (error) { toast(`删除失败：${error.message || error}`, 'error'); }
  });

  $('#confirm-cancel').addEventListener('click', () => resolveConfirm(false));
  $('#confirm-ok').addEventListener('click', () => resolveConfirm(true));
  $('#confirm-modal').addEventListener('click', (event) => { if (event.target === $('#confirm-modal')) resolveConfirm(false); });

  $('#btn-test-reminder').addEventListener('click', async () => {
    try {
      await api.testReminder();
      toast('测试弹窗已发送，看看屏幕右下角。', 'success');
    } catch (error) {
      toast(`无法打开测试弹窗：${error.message || error}`, 'error', 5000);
    }
  });
  $('#set-sound').addEventListener('change', (e) => updateSetting({ sound: e.target.checked }));
  $('#set-quiet').addEventListener('change', (e) => {
    updateSetting({ quietHours: { ...App.state.settings.quietHours, enabled: e.target.checked } });
    $('#quiet-row').hidden = !e.target.checked;
  });
  $('#quiet-start').addEventListener('change', (e) => updateSetting({ quietHours: { ...App.state.settings.quietHours, start: e.target.value } }));
  $('#quiet-end').addEventListener('change', (e) => updateSetting({ quietHours: { ...App.state.settings.quietHours, end: e.target.value } }));
  $('#set-auto-launch').addEventListener('change', (e) => updateSetting({ autoLaunch: e.target.checked }));
  $('#set-close-tray').addEventListener('change', (e) => updateSetting({ closeToTray: e.target.checked }));
  $('#set-auto-sync').addEventListener('change', (e) => updateSetting({ autoSync: e.target.checked }));
  $('#set-auto-add').addEventListener('change', (e) => updateSetting({ autoAddFromChaoxing: e.target.checked }));
  $('#set-sync-interval').addEventListener('change', (e) => updateSetting({ autoSyncIntervalMin: Number(e.target.value) }));

  $('#reminder-offset-chips').addEventListener('change', () => {
    let offsets = getOffsets('#reminder-offset-chips');
    if (!offsets.length) {
      const first = $('#reminder-offset-chips input[value="60"]');
      if (first) first.checked = true;
      offsets = getOffsets('#reminder-offset-chips');
      toast('至少保留一个默认提醒时间。', 'info');
    }
    updateSetting({ reminderOffsets: offsets });
  });

  $('#btn-open-logdir').addEventListener('click', () => api.openLogDir());
  $('#btn-open-local').addEventListener('click', () => api.openLogDir());
  $('#btn-open-mirror').addEventListener('click', () => { if (App.logs && App.logs.mirrorDir) api.openMirrorDir(); });
  $('#btn-refresh-logs').addEventListener('click', loadLogs);
  $('#btn-log-filter').addEventListener('click', () => {
    App.logsErrorOnly = !App.logsErrorOnly;
    $('#btn-log-filter').classList.toggle('active', App.logsErrorOnly);
    $('#btn-log-filter').textContent = App.logsErrorOnly ? '显示全部' : '只看异常';
    renderLogs();
  });
  $('#btn-export-logs').addEventListener('click', async () => {
    try {
      const result = await api.copyLogs();
      if (result && result.path) toast('日志已保存到：' + result.path, 'success', 7000);
      else if (result && result.fallback) toast('已开始下载日志文件。', 'success');
      else toast('已取消保存。', 'info');
    } catch (error) {
      toast(`导出日志失败：${error.message || error}`, 'error', 6000);
    }
  });
  $('#btn-choose-repo').addEventListener('click', chooseLogRepo);
  $('#btn-pick-repo').addEventListener('click', chooseLogRepo);
  $('#btn-clear-mirror').addEventListener('click', async () => {
    const ok = await confirmAction({ title: '移除日志镜像？', text: '本机日志会保留，但不再同步到 Git 仓库目录。', okText: '移除', danger: false, icon: 'i-folder' });
    if (!ok) return;
    await api.clearLogDir();
    await loadLogs();
    toast('已移除日志镜像。', 'success');
  });

  $('#btn-export-data').addEventListener('click', async () => {
    try {
      const result = await api.exportData();
      if (result && result.path) toast('数据已保存到：' + result.path, 'success', 7000);
      else if (result && result.fallback) toast('已开始下载备份文件。', 'success');
      else toast('已取消保存。', 'info');
    } catch (error) {
      toast(`导出数据失败：${error.message || error}`, 'error', 6000);
    }
  });
  $('#btn-import-data').addEventListener('click', async () => {
    const result = await api.importData();
    if (result) {
      applyPayload(await api.getState());
      toast(`已导入 ${result.imported} 项日程。`, 'success');
    }
  });
  $('#btn-open-data').addEventListener('click', () => api.openDataDir());
  $('#btn-open-data-2').addEventListener('click', () => api.openDataDir());
  $('#btn-about-privacy').addEventListener('click', () => { $('#privacy-modal').hidden = false; App.modalOpen = true; });
  $('#privacy-close').addEventListener('click', closePrivacy);
  $('#privacy-ok').addEventListener('click', closePrivacy);
  $('#privacy-modal').addEventListener('click', (event) => { if (event.target === $('#privacy-modal')) closePrivacy(); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#confirm-modal').hidden) { resolveConfirm(false); return; }
      if (!$('#privacy-modal').hidden) { closePrivacy(); return; }
      if (!$('#scale-guide-modal').hidden) { closeScaleGuide(); return; }
      if (!$('#notice-modal').hidden) { closeNoticeModal(); return; }
      if (!$('#gear-modal').hidden) { closeGearModal(); return; }
      if (!$('#mistake-modal').hidden) { closeMistakeModal(); return; }
      if (!$('#task-modal').hidden) { closeTaskModal(); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!App.modalOpen) openTaskModal();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setPage('tasks');
      setTimeout(() => {
        const search = $('#task-search');
        if (search) { search.focus(); search.select(); }
      }, 60);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('#task-modal').hidden) {
      event.preventDefault();
      $('#task-form').requestSubmit();
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === '=' || event.key === '+') { event.preventDefault(); stepUiScale(1); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); stepUiScale(-1); }
      else if (event.key === '0') { event.preventDefault(); setUiScale(1); }    }
  });

  api.onState((payload) => {
    applyPayload(payload);
    if (App.page === 'logs') loadLogs();
  });
  api.onNewTask(() => openTaskModal());
  api.onOpenTask((id) => {
    const task = App.state.tasks.find((t) => t.id === id);
    if (task) { setPage('tasks'); openTaskModal(task); }
  });
  api.onCxLoading((loading) => {
    App.webviewLoading = Boolean(loading);
    $('#cx-loading').hidden = !loading;
    if (loading) updateAddress();
  });
  api.onCxNavigated(() => updateAddress());
  api.onCxPageTitle(() => updateAddress());
  api.onCxLoadError((payload) => {
    toast(`学习通页面加载失败：${(payload && payload.desc) || '网络异常'}`, 'error', 4200);
  });
  api.onCxOpenUrl((url) => {
    const wv = $('#cx-webview');
    if (wv && /^https?:/i.test(url)) { try { wv.loadURL(url); } catch (_) { /* ignore */ } }
  });
}

async function updateSetting(patch) {
  try {
    await api.updateSettings(patch);
    applyPayload(await api.getState());
  } catch (error) {
    toast(`设置保存失败：${error.message || error}`, 'error');
  }
}

async function chooseLogRepo() {
  const dir = await api.chooseLogDir();
  if (!dir) return;
  await api.updateSettings({ logMirrorDir: dir });
  applyPayload(await api.getState());
  await loadLogs();
  toast('日志会按天镜像到该仓库的 process_logs/。', 'success', 4200);
}

function closePrivacy() {
  $('#privacy-modal').hidden = true;
  App.modalOpen = false;
}

function markFirstRunDone() {
  if (!App.state.settings.firstRun) return;
  App.state.settings.firstRun = false;
  api.firstRunDone().catch(() => {});
  renderWelcome();
}

async function toggleTask(id) {
  const task = App.state.tasks.find((t) => t.id === id);
  if (!task) return;
  try {
    if (task.status === 'done') {
      await api.restoreTask(id);
      toast('已恢复为待完成。', 'success');
    } else {
      const result = await api.completeTask(id);
      toast(result && result.next ? '已完成，并生成了下一次重复日程。' : '已完成，做得好。', 'success');
    }
    applyPayload(await api.getState());
  } catch (error) {
    toast(`操作失败：${error.message || error}`, 'error');
  }
}

async function completeTask(id) {
  try {
    const result = await api.completeTask(id);
    toast(result && result.next ? '已完成，并生成了下一次重复日程。' : '已完成，做得好。', 'success');
    applyPayload(await api.getState());
  } catch (error) {
    toast(`操作失败：${error.message || error}`, 'error');
  }
}

async function removeTask(id) {
  const task = App.state.tasks.find((t) => t.id === id);
  if (!task) return;
  const ok = await confirmAction({
    title: '删除这项日程？',
    text: `“${task.title}”删除后无法恢复，相关提醒也会取消。`,
    okText: '删除'
  });
  if (!ok) return;
  try {
    await api.deleteTask(id);
    applyPayload(await api.getState());
    toast('日程已删除。', 'success');
  } catch (error) {
    toast(`删除失败：${error.message || error}`, 'error');
  }
}

async function dismissCandidate(id) {
  try {
    await api.dismissCandidate(id);
    applyPayload(await api.getState());
  } catch (error) {
    toast(`操作失败：${error.message || error}`, 'error');
  }
}

/* ------------------------------------------------------------------- start */

// Any host() failure used to surface as an unhandled rejection with no UI
// feedback; report it once instead of failing silently.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const message = (reason && (reason.message || reason)) || '未知错误';
  try { toast(`操作未完成：${message}`, 'error', 5000); } catch (_) { /* ignore */ }
});

document.addEventListener('DOMContentLoaded', boot);
