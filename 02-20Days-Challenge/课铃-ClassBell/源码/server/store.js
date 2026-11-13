'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const MAX_TASKS = 2000;
const MAX_CANDIDATES = 200;
const MAX_NOTICES = 400;
const MAX_GEAR = 300;
const MAX_MISTAKES = 1200;
const NO_DEADLINE_ISO = '2099-12-31T23:59:00.000Z';

const CATEGORIES = new Set(['homework', 'exam', 'schedule', 'other']);
const PRIORITIES = new Set(['normal', 'important', 'urgent']);
const RECURRENCES = new Set(['none', 'daily', 'weekly', 'monthly']);

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

function cleanText(value, max = 200) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyKey(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultSettings() {
  return {
    autoLaunch: true,
    closeToTray: true,
    autoSync: true,
    autoSyncIntervalMin: 30,
    autoAddFromChaoxing: true,
    reminderOffsets: [1440, 60, 10],
    sound: true,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    logMirrorDir: '',
    displayName: '',
    firstRun: true,
    // 界面偏好存这里而不是 localStorage：本地服务端口每次启动都变，
    // localStorage 按源隔离会“丢”，导致字号引导每次启动都弹。
    uiScale: 1.1,
    scaleGuideDone: false,
    lastPage: 'dashboard',
    // 关闭窗口的说明只弹一次；存服务端避免 WebView2 数据被清后重复弹
    closeHintShown: false,
    // 托盘气泡通知也只弹一次
    trayHintShown: false
  };
}

function defaultState() {
  const ts = nowIso();
  return {
    schema: SCHEMA,
    createdAt: ts,
    updatedAt: ts,
    tasks: [],
    candidates: [],
    notices: [],
    gear: [],
    mistakes: [],
    settings: defaultSettings(),
    sync: {
      lastSyncAt: null,
      lastAttemptAt: null,
      lastResult: null,
      courses: 0,
      recognized: 0,
      added: 0,
      updated: 0,
      error: null,
      accountLabel: ''
    },
    metrics: {
      totalAdded: 0,
      totalCompleted: 0,
      totalSynced: 0,
      totalReminders: 0
    }
  };
}

const NOTICE_KINDS = new Set(['assignment', 'exam', 'gear', 'notice', 'system']);

/**
 * 是否还需要向用户解释“× 只是隐藏到托盘”。
 * 只要 closeHintShown 不是明确的 true，就认为还没解释过。
 * 老用户没有这个字段 → 返回 true，会补弹一次，属于预期行为。
 */
function shouldShowCloseHint(settings) {
  return !(settings && settings.closeHintShown === true);
}

function normalizeNotice(input, existing = null) {
  const base = existing || {};
  const title = cleanText(input.title ?? base.title, 180);
  if (!title) throw new Error('NOTICE_TITLE_REQUIRED');
  const kind = NOTICE_KINDS.has(input.kind) ? input.kind : (base.kind || 'notice');
  const published = parseDate(input.publishedAt ?? base.publishedAt);
  return {
    id: base.id || uid('n_'),
    title,
    body: cleanText(input.body ?? base.body, 1200),
    course: cleanText(input.course ?? base.course, 80),
    kind,
    read: Boolean(input.read ?? base.read),
    source: ['chaoxing', 'local', 'manual'].includes(input.source) ? input.source : (base.source || 'manual'),
    sourceKey: cleanText(input.sourceKey ?? base.sourceKey, 160) || '',
    sourceUrl: cleanText(input.sourceUrl ?? base.sourceUrl, 600) || '',
    publishedAt: published ? published.toISOString() : (base.publishedAt || nowIso()),
    createdAt: base.createdAt || nowIso()
  };
}

function normalizeGear(input, existing = null) {
  const base = existing || {};
  const name = cleanText(input.name ?? base.name, 120);
  if (!name) throw new Error('GEAR_NAME_REQUIRED');
  const due = parseDate(input.dueAt ?? base.dueAt);
  const returned = parseDate(input.returnedAt ?? base.returnedAt);
  const borrowed = parseDate(input.borrowedAt ?? base.borrowedAt) || new Date();
  const status = input.status === 'returned' || returned ? 'returned' : 'out';
  return {
    id: base.id || uid('g_'),
    name,
    code: cleanText(input.code ?? base.code, 60),
    borrower: cleanText(input.borrower ?? base.borrower, 60),
    keeper: cleanText(input.keeper ?? base.keeper, 60),
    borrowedAt: borrowed.toISOString(),
    dueAt: due ? due.toISOString() : '',
    returnedAt: status === 'returned' ? (returned ? returned.toISOString() : nowIso()) : '',
    status,
    condition: cleanText(input.condition ?? base.condition, 40),
    note: cleanText(input.note ?? base.note, 500),
    createdAt: base.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function normalizeMistake(input, existing = null) {
  const base = existing || {};
  const question = cleanText(input.question ?? base.question, 2000);
  if (!question) throw new Error('MISTAKE_QUESTION_REQUIRED');
  const wrong = parseDate(input.wrongAt ?? base.wrongAt);
  return {
    id: base.id || uid('m_'),
    course: cleanText(input.course ?? base.course, 80),
    title: cleanText(input.title ?? base.title, 160),
    question,
    myAnswer: cleanText(input.myAnswer ?? base.myAnswer, 800),
    correctAnswer: cleanText(input.correctAnswer ?? base.correctAnswer, 800),
    analysis: cleanText(input.analysis ?? base.analysis, 1200),
    note: cleanText(input.note ?? base.note, 800),
    tags: Array.isArray(input.tags ?? base.tags)
      ? [...new Set((input.tags ?? base.tags).map((t) => cleanText(t, 24)).filter(Boolean))].slice(0, 8)
      : [],
    source: input.source === 'chaoxing' ? 'chaoxing' : (base.source || 'manual'),
    sourceKey: cleanText(input.sourceKey ?? base.sourceKey, 200) || '',
    sourceUrl: cleanText(input.sourceUrl ?? base.sourceUrl, 600) || '',
    wrongAt: wrong ? wrong.toISOString() : (base.wrongAt || nowIso()),
    createdAt: base.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function normalizeOffsets(input, fallback = [60, 10]) {  const raw = Array.isArray(input) ? input : fallback;
  const values = [...new Set(raw.map((v) => safeInt(v, -1))
    .filter((v) => v >= 0 && v <= 10080))]
    .sort((a, b) => b - a);
  return values.length ? values : [...fallback];
}

function normalizeTask(input, existing = null) {
  const base = existing || {};
  const title = cleanText(input.title ?? base.title, 120);
  if (!title) throw new Error('TASK_TITLE_REQUIRED');

  const noDeadline = Boolean(input.noDeadline ?? base.noDeadline);
  const due = noDeadline ? new Date(NO_DEADLINE_ISO) : parseDate(input.dueAt ?? base.dueAt);
  if (!due || Number.isNaN(due.getTime())) throw new Error('TASK_DUE_INVALID');

  const category = CATEGORIES.has(input.category) ? input.category : (base.category || 'homework');
  const priority = PRIORITIES.has(input.priority) ? input.priority : (base.priority || 'normal');
  const recurrence = RECURRENCES.has(input.recurrence) ? input.recurrence : (base.recurrence || 'none');
  const status = ['done', 'pending', 'missed'].includes(input.status)
    ? input.status
    : (['done', 'missed'].includes(base.status) ? base.status : 'pending');
  const source = ['manual', 'chaoxing'].includes(input.source) ? input.source : (base.source || 'manual');
  const offsets = normalizeOffsets(input.reminderOffsets ?? base.reminderOffsets);

  const task = {
    id: base.id || uid('t_'),
    title,
    course: cleanText(input.course ?? base.course, 60),
    category,
    priority,
    dueAt: due.toISOString(),
    noDeadline,
    notes: cleanText(input.notes ?? base.notes, 2000),
    status,
    missedAt: status === 'missed' ? (base.missedAt || nowIso()) : null,
    completedAt: status === 'done'
      ? (base.completedAt || nowIso())
      : null,
    createdAt: base.createdAt || nowIso(),
    updatedAt: nowIso(),
    reminderOffsets: offsets,
    remindersSent: Array.isArray(input.remindersSent)
      ? input.remindersSent.map((v) => cleanText(v, 40)).filter(Boolean).slice(0, 30)
      : (Array.isArray(base.remindersSent) ? base.remindersSent : []),
    recurrence,
    seriesId: cleanText(input.seriesId ?? base.seriesId, 80) || '',
    // 重复日程的锚点：每月固定在这一天（31 号在小月自动取月末），
    // seriesStartAt 是系列首期，用于避免“1/31 → 2/28 → 3/28”的日期漂移。
    recurrenceDay: (() => {
      const fallback = due.getDate();
      const raw = safeInt(input.recurrenceDay ?? base.recurrenceDay, fallback);
      return Math.max(1, Math.min(31, raw || fallback));
    })(),
    seriesStartAt: cleanText(input.seriesStartAt ?? base.seriesStartAt, 40)
      || (recurrence !== 'none' ? due.toISOString() : ''),
    source,
    sourceKey: cleanText(input.sourceKey ?? base.sourceKey, 160) || '',
    sourceUrl: cleanText(input.sourceUrl ?? base.sourceUrl, 600) || '',
    remoteStatus: safeInt(input.remoteStatus ?? base.remoteStatus, 0),
    lastSeenAt: cleanText(input.lastSeenAt ?? base.lastSeenAt, 40) || '',
    completedBy: cleanText(input.completedBy ?? base.completedBy, 20) || '',
    // 1.6.0：详情页补全出来的题目数量（未知为 null）
    questionCount: (() => {
      const raw = input.questionCount ?? base.questionCount;
      if (raw === null || raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 && n <= 9999 ? Math.trunc(n) : null;
    })(),
    // 详情页抓取成功的时间；抓失败不写，下次同步会重试
    detailFetchedAt: cleanText(input.detailFetchedAt ?? base.detailFetchedAt, 40) || null,
    // 用户手工改过截止时间：同步与补全都不许覆盖
    dueAtManual: Boolean(input.dueAtManual ?? base.dueAtManual)
  };

  if (task.dueAt !== base.dueAt) {
    task.remindersSent = [];
  } else if (input.reminderOffsets) {
    // Keep the reminder keys that are still valid for the remaining offsets,
    // otherwise editing a note re-arms every reminder that already fired.
    const valid = new Set(task.reminderOffsets.map((o) => `o${o}@${task.dueAt}`));
    task.remindersSent = (task.remindersSent || []).filter((k) => valid.has(k));
  }
  return task;
}

const RECURRENCE_ROLL_LIMIT = 6000;

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
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'data.json');
    this.backupFile = path.join(dataDir, 'data.backup.json');
    this.state = defaultState();
    this._writeTimer = null;
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const candidate of [this.file, this.backupFile]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) continue;
        this.state = this.migrate(raw);
        return;
      } catch (err) {
        // Try the backup, then fall back to defaults.
      }
    }
    this.state = defaultState();
    this.save();
  }

  migrate(raw) {
    const base = defaultState();
    const settings = { ...base.settings, ...(raw.settings || {}) };
    settings.reminderOffsets = normalizeOffsets(settings.reminderOffsets);
    settings.quietHours = { ...base.settings.quietHours, ...(settings.quietHours || {}) };
    settings.autoSyncIntervalMin = Math.max(5, Math.min(240, safeInt(settings.autoSyncIntervalMin, 30)));
    const tasks = [];
    for (const item of raw.tasks) {
      try {
        tasks.push(normalizeTask(item, item));
      } catch (_) {
        // Drop malformed rows rather than breaking the whole store.
      }
    }
    const candidates = Array.isArray(raw.candidates)
      ? raw.candidates.filter((c) => c && c.title).slice(0, MAX_CANDIDATES).map((c) => ({
        id: cleanText(c.id, 80) || uid('c_'),
        title: cleanText(c.title, 160),
        course: cleanText(c.course, 80),
        dueAt: c.dueAt && parseDate(c.dueAt) ? parseDate(c.dueAt).toISOString() : null,
        sourceKey: cleanText(c.sourceKey, 160),
        sourceUrl: cleanText(c.sourceUrl, 600),
        type: cleanText(c.type, 20) || 'work',
        reason: cleanText(c.reason, 40),
        discoveredAt: cleanText(c.discoveredAt, 40) || nowIso()
      }))
      : [];
    const notices = Array.isArray(raw.notices)
      ? raw.notices.slice(0, MAX_NOTICES).map((n) => {
        try { return normalizeNotice(n, n); } catch (_) { return null; }
      }).filter(Boolean)
      : [];
    const gear = Array.isArray(raw.gear)
      ? raw.gear.slice(0, MAX_GEAR).map((g) => {
        try { return normalizeGear(g, g); } catch (_) { return null; }
      }).filter(Boolean)
      : [];
    const mistakes = Array.isArray(raw.mistakes)
      ? raw.mistakes.slice(0, MAX_MISTAKES).map((m) => {
        try { return normalizeMistake(m, m); } catch (_) { return null; }
      }).filter(Boolean)
      : [];
    // Repair records archived before the scanner learned to read the course from
    // the work URL, and make sure every mistake carries a visible reason.
    for (const mistake of mistakes) {
      if (!mistake.course && mistake.sourceUrl) {
        const courseId = (/[?&]courseId=(\d+)/.exec(mistake.sourceUrl) || [])[1];
        if (courseId) {
          const matched = tasks.find((t) => t.sourceUrl && t.sourceUrl.indexOf('courseId=' + courseId) >= 0);
          if (matched) {
            mistake.course = matched.course || mistake.course;
            if (!mistake.title || /学习通|作业详情|个人空间/.test(mistake.title)) {
              mistake.title = matched.title || mistake.title;
            }
          }
        }
      }
      if (!mistake.analysis) {
        mistake.analysis = mistake.myAnswer
          ? `我的答案“${mistake.myAnswer}”与正确答案“${mistake.correctAnswer || '未给出'}”不一致。`
          : `未作答，正确答案为“${mistake.correctAnswer || '未给出'}”。`;
      }
    }
    return {
      ...base,
      ...raw,
      schema: SCHEMA,
      settings,
      tasks,
      candidates,
      notices,
      gear,
      mistakes,
      sync: { ...base.sync, ...(raw.sync || {}) },
      metrics: { ...base.metrics, ...(raw.metrics || {}) }
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  save() {
    this.state.updatedAt = nowIso();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, `data.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, this.backupFile);
        } catch (_) { /* best effort */ }
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Windows can transiently lock the target; retry with a direct write.
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      fs.writeFileSync(this.file, json, 'utf8');
    }
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = null;
  }

  scheduleSave() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      try { this.save(); } catch (err) { console.error('store save failed', err); }
    }, 180);
  }

  flush() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = null;
    this.save();
  }

  addTask(input) {
    if (this.state.tasks.length >= MAX_TASKS) {
      throw new Error('TASK_LIMIT_REACHED');
    }
    const task = normalizeTask({
      ...input,
      source: input.source === 'chaoxing' ? 'chaoxing' : 'manual'
    });
    if (task.sourceKey) {
      const existing = this.state.tasks.find((t) => t.sourceKey && t.sourceKey === task.sourceKey);
      if (existing) {
        return this.updateTask(existing.id, {
          ...task,
          id: existing.id,
          remindersSent: existing.remindersSent,
          status: existing.status
        });
      }
    }
    this.state.tasks.push(task);
    this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== task.sourceKey);
    this.state.metrics.totalAdded += 1;
    this.scheduleSave();
    return task;
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @param {{manual?: boolean}} [options] manual=true 表示用户本人改的，
   *        截止时间一旦被用户改过就打 dueAtManual，之后同步/补全都不覆盖。
   */
  updateTask(id, patch, options = {}) {
    const idx = this.state.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error('TASK_NOT_FOUND');
    const existing = this.state.tasks[idx];

    // 用户手工改期：打标记（同一个时间点不算改动）
    if (options.manual && patch.dueAt !== undefined && patch.noDeadline !== true) {
      const patchDue = parseDate(patch.dueAt);
      const currentDue = parseDate(existing.dueAt);
      const changed = patchDue && (!currentDue || patchDue.getTime() !== currentDue.getTime());
      if (changed || existing.noDeadline) patch = { ...patch, dueAtManual: true };
    }

    const updated = normalizeTask({ ...existing, ...patch, id: existing.id }, existing);
    if (patch.status === 'done' && existing.status !== 'done') {
      updated.completedAt = nowIso();
      updated.completedBy = cleanText(patch.completedBy, 20) || 'user';
      this.state.metrics.totalCompleted += 1;
    }
    if (patch.status === 'pending') {
      updated.completedAt = null;
      updated.completedBy = '';
    }
    this.state.tasks[idx] = updated;
    this.scheduleSave();
    return updated;
  }

  /**
   * 写入详情页补全的结果。
   * 规则：
   *   - 已有真实截止时间（非长期任务）→ 不覆盖；
   *   - 用户手工改过（dueAtManual）→ 不覆盖；
   *   - 只补“确实缺失”的字段。
   * @returns {object|null} 实际更新后的任务
   */
  applyDetailEnrichment(id, { dueAt = null, questionCount = null, fetchedAt = null } = {}) {
    const existing = this.state.tasks.find((t) => t.id === id);
    if (!existing) return null;

    const patch = {};
    if (fetchedAt) patch.detailFetchedAt = fetchedAt;

    const hasRealDue = existing.dueAt && !existing.noDeadline;
    if (dueAt && !hasRealDue && !existing.dueAtManual) {
      patch.dueAt = dueAt;
      patch.noDeadline = false;
    }
    if (questionCount && !existing.questionCount) {
      patch.questionCount = questionCount;
    }
    if (!Object.keys(patch).length) return existing;
    return this.updateTask(id, patch);
  }

  deleteTask(id) {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    if (this.state.tasks.length === before) throw new Error('TASK_NOT_FOUND');
    this.scheduleSave();
    return true;
  }

  completeTask(id) {
    const existing = this.state.tasks.find((t) => t.id === id);
    if (!existing) throw new Error('TASK_NOT_FOUND');
    if (existing.status === 'done') return { task: existing, next: null };
    const done = this.updateTask(id, { status: 'done', completedBy: 'user' });
    let next = null;
    if (existing.recurrence !== 'none') {
      // 传 now：补完一条过期好几天的重复任务时，下一期要落在今天之后，
      // 而不是刚生成就又是“已逾期”。
      const draft = nextOccurrence(existing, Date.now());
      if (draft) {
        next = normalizeTask(draft, draft);
        this.state.tasks.push(next);
      }
    }
    this.scheduleSave();
    return { task: done, next };
  }

  restoreTask(id) {
    return this.updateTask(id, { status: 'pending', completedAt: null });
  }

  updateSettings(patch) {
    const allowed = [
      'autoLaunch', 'closeToTray', 'autoSync', 'autoSyncIntervalMin',
      'autoAddFromChaoxing', 'sound', 'quietHours', 'logMirrorDir',
      'displayName', 'firstRun', 'reminderOffsets',
      'uiScale', 'scaleGuideDone', 'lastPage',
      'closeHintShown', 'trayHintShown'
    ];
    const next = { ...this.state.settings };
    for (const key of allowed) {
      if (!(key in patch)) continue;
      if (key === 'autoSyncIntervalMin') {
        next[key] = Math.max(5, Math.min(240, safeInt(patch[key], 30)));
      } else if (key === 'quietHours') {
        const q = patch[key] || {};
        const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
        next.quietHours = {
          enabled: q.enabled === true || q.enabled === 'true',
          start: TIME_RE.test(q.start || '') ? q.start : (next.quietHours.start || '23:00'),
          end: TIME_RE.test(q.end || '') ? q.end : (next.quietHours.end || '07:00')
        };
      } else if (key === 'reminderOffsets') {
        next.reminderOffsets = normalizeOffsets(patch.reminderOffsets);
      } else if (key === 'uiScale') {
        // 只接受界面里提供的 6 档，避免脏值把页面缩坏
        const allowedScales = [0.9, 1, 1.1, 1.25, 1.4, 1.6];
        const value = Number(patch.uiScale);
        next.uiScale = allowedScales.includes(value) ? value : (next.uiScale || 1.1);
      } else if (key === 'lastPage') {
        const allowedPages = ['dashboard', 'tasks', 'integration', 'notices', 'gear', 'mistakes', 'settings'];
        const value = cleanText(patch.lastPage, 20);
        next.lastPage = allowedPages.includes(value) ? value : (next.lastPage || 'dashboard');
      } else if (key === 'logMirrorDir' || key === 'displayName') {
        next[key] = cleanText(patch[key], 500);
      } else {
        // "false" (string) used to sneak in as true; only accept real booleans.
        next[key] = patch[key] === true || patch[key] === 'true';
      }
    }
    this.state.settings = next;
    this.scheduleSave();
    return next;
  }

  markRemindersSent(taskId, keys) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const set = new Set(task.remindersSent || []);
    for (const key of keys) set.add(key);
    task.remindersSent = [...set].slice(-30);
    task.updatedAt = nowIso();
    this.scheduleSave();
  }

  setSyncMeta(patch) {
    this.state.sync = { ...this.state.sync, ...patch };
    if (patch.lastResult === 'ok') this.state.metrics.totalSynced += 1;
    this.scheduleSave();
  }

  /**
   * Merge an array of normalized remote tasks.
   * Remote rows without a usable deadline are kept in candidates for review.
   */
  mergeRemote(remoteTasks, { autoAdd = true } = {}) {
    const stats = { added: 0, updated: 0, completed: 0, missed: 0, candidates: 0, skipped: 0 };
    const bySource = new Map();
    const byFingerprint = new Map();
    for (const task of this.state.tasks) {
      if (task.sourceKey) bySource.set(task.sourceKey, task);
      byFingerprint.set(`${task.title}::${task.dueAt}`, task);
    }

    for (const remote of remoteTasks) {
      const sourceKey = cleanText(remote.sourceKey, 160);
      if (!sourceKey || !remote.title) { stats.skipped += 1; continue; }
      const existing = bySource.get(sourceKey);
      const dueAt = remote.dueAt && parseDate(remote.dueAt) ? parseDate(remote.dueAt).toISOString() : null;

      if (existing) {
        const patch = {
          title: remote.title,
          course: remote.course || existing.course,
          sourceUrl: remote.sourceUrl || existing.sourceUrl,
          remoteStatus: safeInt(remote.remoteStatus, 0),
          lastSeenAt: nowIso()
        };
        let changed = false;
        if (remote.title && remote.title !== existing.title) changed = true;
        if (remote.course && remote.course !== existing.course) changed = true;
        // 用户手工改过截止时间 —— 平台同步不许覆盖，避免“改了又被改回去”
        if (dueAt && dueAt !== existing.dueAt && !existing.dueAtManual) {
          patch.dueAt = dueAt;
          patch.noDeadline = false;
          changed = true;
        }
        if (remote.remoteStatus !== undefined && remote.remoteStatus !== 0 && existing.status === 'pending') {
          patch.status = 'done';
          patch.completedBy = 'chaoxing';
          stats.completed += 1;
          changed = true;
        } else if (remote.closed && existing.status === 'pending') {
          patch.status = 'missed';
          stats.missed += 1;
          changed = true;
        }
        if (changed) {
          this.updateTask(existing.id, patch);
          stats.updated += 1;
        }
        continue;
      }

      if (safeInt(remote.remoteStatus, 0) !== 0) {
        stats.skipped += 1;
        continue;
      }

      if (remote.closed) {
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt: dueAt || nowIso(),
          status: 'missed',
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: 0,
          lastSeenAt: nowIso(),
          reminderOffsets: []
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        this.state.metrics.totalAdded += 1;
        stats.missed += 1;
        continue;
      }

      const fingerprint = `${remote.title}::${dueAt || ''}`;
      const duplicate = dueAt ? byFingerprint.get(fingerprint) : null;
      if (duplicate) {
        if (!duplicate.sourceKey) {
          duplicate.sourceKey = sourceKey;
          duplicate.sourceUrl = remote.sourceUrl || duplicate.sourceUrl;
          stats.updated += 1;
        }
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        continue;
      }

      if (dueAt && autoAdd) {
        if (parseDate(dueAt).getTime() < Date.now() - 45 * 24 * 3600 * 1000) {
          stats.skipped += 1;
          continue;
        }
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt,
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: safeInt(remote.remoteStatus, 0),
          lastSeenAt: nowIso(),
          reminderOffsets: this.state.settings.reminderOffsets
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        byFingerprint.set(fingerprint, created);
        this.state.metrics.totalAdded += 1;
        stats.added += 1;
        continue;
      }

      // No deadline is a valid state on Chaoxing: the teacher simply did not set
      // one. Keep it as an open-ended task until the student marks it complete.
      if (!dueAt && autoAdd) {
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt: NO_DEADLINE_ISO,
          noDeadline: true,
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: 0,
          lastSeenAt: nowIso(),
          reminderOffsets: []
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        this.state.metrics.totalAdded += 1;
        stats.added += 1;
        continue;
      }

      const candidate = {
        id: uid('c_'),
        title: cleanText(remote.title, 160),
        course: cleanText(remote.course, 80),
        dueAt,
        sourceKey,
        sourceUrl: cleanText(remote.sourceUrl, 600),
        type: remote.type === 'exam' ? 'exam' : 'work',
        reason: dueAt ? 'auto_add_disabled' : 'no_deadline',
        discoveredAt: nowIso()
      };
      const old = this.state.candidates.find((c) => c.sourceKey === sourceKey);
      if (old) Object.assign(old, candidate, { id: old.id });
      else this.state.candidates.unshift(candidate);
      stats.candidates += 1;
    }

    this.state.candidates = this.state.candidates.slice(0, MAX_CANDIDATES);
    this.scheduleSave();
    return stats;
  }

  dismissCandidate(id) {
    this.state.candidates = this.state.candidates.filter((c) => c.id !== id);
    this.scheduleSave();
    return true;
  }

  /* ------------------------------------------------------------ notices */

  addNotice(input) {
    const notice = normalizeNotice(input);
    if (notice.sourceKey) {
      const existing = this.state.notices.find((n) => n.sourceKey && n.sourceKey === notice.sourceKey);
      if (existing) {
        existing.title = notice.title || existing.title;
        existing.body = notice.body || existing.body;
        existing.publishedAt = notice.publishedAt;
        existing.sourceUrl = notice.sourceUrl || existing.sourceUrl;
        this.scheduleSave();
        return { notice: existing, created: false };
      }
    }
    this.state.notices.unshift(notice);
    this.state.notices = this.state.notices.slice(0, MAX_NOTICES);
    this.scheduleSave();
    return { notice, created: true };
  }

  addNotices(list) {
    const stats = { added: 0, updated: 0, skipped: 0 };
    for (const item of Array.isArray(list) ? list : []) {
      try {
        const result = this.addNotice(item);
        if (result.created) stats.added += 1;
        else stats.updated += 1;
      } catch (_) {
        stats.skipped += 1;
      }
    }
    return stats;
  }

  markNotice(id, read = true) {
    const notice = this.state.notices.find((n) => n.id === id);
    if (!notice) throw new Error('NOTICE_NOT_FOUND');
    notice.read = Boolean(read);
    this.scheduleSave();
    return notice;
  }

  markAllNoticesRead() {
    let count = 0;
    for (const notice of this.state.notices) {
      if (!notice.read) { notice.read = true; count += 1; }
    }
    this.scheduleSave();
    return { updated: count };
  }

  deleteNotice(id) {
    const before = this.state.notices.length;
    this.state.notices = this.state.notices.filter((n) => n.id !== id);
    if (this.state.notices.length === before) throw new Error('NOTICE_NOT_FOUND');
    this.scheduleSave();
    return true;
  }

  /* --------------------------------------------------------------- gear */

  addGear(input) {
    const item = normalizeGear(input);
    this.state.gear.unshift(item);
    this.state.gear = this.state.gear.slice(0, MAX_GEAR);
    this.scheduleSave();
    return item;
  }

  updateGear(id, patch) {
    const index = this.state.gear.findIndex((g) => g.id === id);
    if (index < 0) throw new Error('GEAR_NOT_FOUND');
    const next = normalizeGear({ ...this.state.gear[index], ...patch, id }, this.state.gear[index]);
    this.state.gear[index] = next;
    this.scheduleSave();
    return next;
  }

  returnGear(id, extra = {}) {
    return this.updateGear(id, {
      status: 'returned',
      returnedAt: extra.returnedAt || nowIso(),
      condition: extra.condition !== undefined ? extra.condition : '正常',
      note: extra.note !== undefined ? extra.note : undefined
    });
  }

  deleteGear(id) {
    const before = this.state.gear.length;
    this.state.gear = this.state.gear.filter((g) => g.id !== id);
    if (this.state.gear.length === before) throw new Error('GEAR_NOT_FOUND');
    this.scheduleSave();
    return true;
  }

  gearSummary() {
    const now = Date.now();
    const out = this.state.gear.filter((g) => g.status === 'out');
    return {
      total: this.state.gear.length,
      out: out.length,
      returned: this.state.gear.filter((g) => g.status === 'returned').length,
      overdue: out.filter((g) => g.dueAt && new Date(g.dueAt).getTime() < now).length
    };
  }

  /* ----------------------------------------------------------- mistakes */

  addMistake(input) {
    const mistake = normalizeMistake(input);
    if (mistake.sourceKey) {
      const existing = this.state.mistakes.find((m) => m.sourceKey && m.sourceKey === mistake.sourceKey);
      if (existing) return { mistake: existing, created: false };
    }
    this.state.mistakes.unshift(mistake);
    this.state.mistakes = this.state.mistakes.slice(0, MAX_MISTAKES);
    this.scheduleSave();
    return { mistake, created: true };
  }

  addMistakes(list) {
    const stats = { added: 0, skipped: 0 };
    for (const item of Array.isArray(list) ? list : []) {
      try {
        const result = this.addMistake(item);
        if (result.created) stats.added += 1;
        else stats.skipped += 1;
      } catch (_) {
        stats.skipped += 1;
      }
    }
    return stats;
  }

  updateMistake(id, patch) {
    const index = this.state.mistakes.findIndex((m) => m.id === id);
    if (index < 0) throw new Error('MISTAKE_NOT_FOUND');
    const next = normalizeMistake({ ...this.state.mistakes[index], ...patch, id }, this.state.mistakes[index]);
    this.state.mistakes[index] = next;
    this.scheduleSave();
    return next;
  }

  deleteMistake(id) {
    const before = this.state.mistakes.length;
    this.state.mistakes = this.state.mistakes.filter((m) => m.id !== id);
    if (this.state.mistakes.length === before) throw new Error('MISTAKE_NOT_FOUND');
    this.scheduleSave();
    return true;
  }

  mistakeSummary() {
    const now = Date.now();
    const week = 7 * 24 * 3600 * 1000;
    const byCourse = new Map();
    for (const item of this.state.mistakes) {
      const key = item.course || '未分课程';
      byCourse.set(key, (byCourse.get(key) || 0) + 1);
    }
    return {
      total: this.state.mistakes.length,
      week: this.state.mistakes.filter((m) => now - new Date(m.wrongAt).getTime() <= week).length,
      courses: [...byCourse.entries()].map(([course, count]) => ({ course, count }))
        .sort((a, b) => b.count - a.count)
    };
  }

  exportData() {
    return JSON.stringify({
      app: 'ClassBell',
      schema: SCHEMA,
      exportedAt: nowIso(),
      tasks: this.state.tasks,
      notices: this.state.notices,
      gear: this.state.gear,
      mistakes: this.state.mistakes,
      settings: this.state.settings
    }, null, 2);
  }

  importData(payload) {
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      throw new Error('IMPORT_INVALID_JSON');
    }
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('IMPORT_INVALID_FORMAT');
    const valid = [];
    for (const item of parsed.tasks.slice(0, MAX_TASKS)) {
      try {
        valid.push(normalizeTask(item, item));
      } catch (_) { /* skip */ }
    }
    const knownKeys = new Set(this.state.tasks.map((t) => t.sourceKey).filter(Boolean));
    const knownSignatures = new Set(this.state.tasks.map((t) => `${t.title}::${t.dueAt}`));
    const stats = { imported: 0, skipped: 0 };
    for (const task of valid) {
      if (task.sourceKey && knownKeys.has(task.sourceKey)) { stats.skipped += 1; continue; }
      const signature = `${task.title}::${task.dueAt}`;
      if (knownSignatures.has(signature)) { stats.skipped += 1; continue; }
      if (this.state.tasks.some((t) => t.id === task.id)) task.id = uid('t_');
      this.state.tasks.push(task);
      if (task.sourceKey) knownKeys.add(task.sourceKey);
      knownSignatures.add(signature);
      stats.imported += 1;
    }
    this.state.tasks.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    if (Array.isArray(parsed.gear)) {
      for (const item of parsed.gear.slice(0, MAX_GEAR)) {
        try { this.state.gear.push(normalizeGear(item)); } catch (_) { /* skip */ }
      }
    }
    if (Array.isArray(parsed.mistakes)) {
      for (const item of parsed.mistakes.slice(0, MAX_MISTAKES)) {
        try { this.state.mistakes.push(normalizeMistake(item)); } catch (_) { /* skip */ }
      }
    }
    if (Array.isArray(parsed.notices)) {
      for (const item of parsed.notices.slice(0, MAX_NOTICES)) {
        try { this.state.notices.push(normalizeNotice(item)); } catch (_) { /* skip */ }
      }
    }
    // A backup carries settings; restoring them is what users expect.
    if (parsed.settings && typeof parsed.settings === 'object') {
      try { this.updateSettings(parsed.settings); } catch (_) { /* ignore bad settings */ }
    }
    this.scheduleSave();
    return { imported: stats.imported, skipped: stats.skipped, total: this.state.tasks.length };
  }

  stats() {
    const now = Date.now();
    const pending = this.state.tasks.filter((t) => t.status === 'pending');
    const today = dateOnlyKey(new Date());
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    return {
      pending: pending.length,
      overdue: pending.filter((t) => new Date(t.dueAt).getTime() < now).length,
      today: pending.filter((t) => dateOnlyKey(t.dueAt) === today).length,
      tomorrow: pending.filter((t) => dateOnlyKey(t.dueAt) === dateOnlyKey(tomorrow)).length,
      week: pending.filter((t) => {
        const d = new Date(t.dueAt).getTime();
        return d >= now && d <= weekEnd.getTime();
      }).length,
      done: this.state.tasks.filter((t) => t.status === 'done').length,
      missed: this.state.tasks.filter((t) => t.status === 'missed').length,
      noticesUnread: this.state.notices.filter((n) => !n.read).length,
      gearOut: this.gearSummary().out,
      gearOverdue: this.gearSummary().overdue,
      mistakes: this.state.mistakes.length
    };
  }
}

module.exports = {
  Store,
  defaultState,
  normalizeTask,
  nextOccurrence,
  normalizeOffsets,
  NO_DEADLINE_ISO,
  shouldShowCloseHint,
  dateOnlyKey,
  cleanText
};
