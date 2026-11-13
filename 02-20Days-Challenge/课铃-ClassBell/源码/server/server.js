'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { Store } = require('./store');
const { Telemetry } = require('./telemetry');
const { ReminderScheduler } = require('./scheduler');
const { ChaoxingService, LOGIN_URL, HOME_URL, cleanError } = require('./chaoxing');
const { parseMistakeText, hashKey } = require('./chaoxing-parser');

function argValue(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

const appRoot = path.join(__dirname, '..');
const rendererDir = path.join(appRoot, 'src', 'renderer');
const assetsDir = path.join(appRoot, 'src', 'assets');
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const port = Number(argValue('--port', '48765'));
const dataDirArg = argValue('--data-dir', '');
const dataDir = path.resolve(dataDirArg || path.join(process.env.APPDATA || process.cwd(), 'ClassBell'));
fs.mkdirSync(dataDir, { recursive: true });

const store = new Store(dataDir);
const telemetry = new Telemetry({
  dataDir,
  mirrorDir: (process.env.CLASSBELL_LOG_MIRROR || process.env.CAMPUSPULSE_LOG_MIRROR) || store.state.settings.logMirrorDir,
  appVersion: packageJson.version
});
const chaoxing = new ChaoxingService({ telemetry });
const clients = new Set();
let syncPromise = null;
// 详情补全进度（null = 没在补全）；通过 state 广播推给界面
let detailProgress = null;
let reminderQueue = [];
let reminderDropped = 0;
let snoozes = [];
let autoSyncTimer = null;

function log(event, options) { telemetry.log(event, options); }

function friendlyError(error) {
  const code = (error && error.code) || 'UNKNOWN';
  const map = {
    AUTH_REQUIRED: '尚未登录学习通，请先打开登录窗口完成登录。',
    UID_MISSING: '未读取到学习通用户标识，请重新登录。',
    WAF_HTML: '学习通返回了验证页面，请稍后重试。',
    INVALID_JSON: '学习通接口返回格式变化，请稍后重试。',
    HTTP_403: '学习通拒绝了本次请求，请重新登录后重试。',
    FETCH_FAILED: '网络连接失败，请检查网络后重试。'
  };
  return map[code] || String((error && error.message) || '同步失败，请稍后重试。').slice(0, 180);
}

function stats() { return store.stats(); }

function statePayload() {
  return {
    state: store.snapshot(),
    stats: stats(),
    meta: {
      version: packageJson.version,
      packaged: true,
      host: 'webview2',
      dataDir,
      platform: process.platform,
      arch: process.arch,
      loginUrl: LOGIN_URL,
      homeUrl: HOME_URL,
      detailProgress
    }
  };
}

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(statePayload())}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/* Only the local host may talk to this service. Binding to 127.0.0.1 alone does
   not stop DNS rebinding: a hostile page can resolve its own domain to loopback
   and reach these APIs with a foreign Host header. */
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`
]);

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  return ALLOWED_HOSTS.has(host);
}

/* Writes must come from our own page: JSON content type + same-origin fetch.
   Browsers cannot set Sec-Fetch-Site from a cross-site page, and text/plain
   simple requests skip preflight, so both are checked. */
function crossSiteWrite(req) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = String(req.headers.origin || '');
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return true;
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct && ct !== 'application/json') return true;
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  let parsed;
  try { parsed = new URL(req.url, 'http://127.0.0.1'); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent(parsed.pathname); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (urlPath === '/favicon.ico') {
    res.writeHead(302, { Location: '/assets/icon.png' });
    res.end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const base = urlPath.startsWith('/assets/') ? assetsDir : rendererDir;
  const relative = urlPath.startsWith('/assets/') ? urlPath.slice('/assets/'.length) : urlPath.replace(/^\//, '');
  const file = path.resolve(base, relative);
  if (!file.startsWith(path.resolve(base))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ sync */

function syncMetaFor(auth, result, merge, error) {
  return {
    lastSyncAt: result && result.ok ? new Date().toISOString() : store.state.sync.lastSyncAt,
    lastAttemptAt: new Date().toISOString(),
    lastResult: result && result.ok ? 'ok' : 'error',
    courses: result && Array.isArray(result.courses) ? result.courses.length : store.state.sync.courses,
    recognized: result && Array.isArray(result.tasks) ? result.tasks.length : 0,
    added: merge ? merge.added : 0,
    updated: merge ? merge.updated : 0,
    missed: merge ? (merge.missed || 0) : 0,
    error: error ? friendlyError(error) : '',
    accountLabel: auth && auth.loggedIn ? '学习通账号' : ''
  };
}

/**
 * 同步之后的详情补全：把缺截止时间的作业逐个打开详情页，补上
 * 「截止时间」与「题目数量」。
 *
 * 任何异常都在这里吞掉并记日志 —— 补全失败不能影响已经同步好的数据。
 */
async function enrichDetailsAfterSync() {
  const candidates = store.state.tasks.filter((t) => t
    && t.status === 'pending'
    && (t.noDeadline || !t.dueAt)
    && !t.dueAtManual
    && !t.detailFetchedAt
    && t.sourceUrl);
  if (!candidates.length) return null;

  detailProgress = { done: 0, total: Math.min(40, candidates.length) };
  broadcastState();

  try {
    const { stats, results } = await chaoxing.enrichTaskDetails(candidates, {
      limit: 40,
      onProgress: ({ done: d, total }) => {
        detailProgress = { done: d, total };
        broadcastState();
      }
    });

    let applied = 0;
    for (const item of results) {
      try {
        const updated = store.applyDetailEnrichment(item.id, {
          dueAt: item.patch.dueAt || null,
          questionCount: item.patch.questionCount || null,
          fetchedAt: item.patch.detailFetchedAt || null
        });
        if (updated) applied += 1;
      } catch (error) {
        log('detail_apply_error', { ok: false, error, meta: { taskId: item.id } });
      }
    }

    log('detail_enrichment_applied', { meta: { ...stats, applied } });
    return { ...stats, applied };
  } catch (error) {
    log('detail_enrichment_failed', { ok: false, error });
    return null;
  } finally {
    detailProgress = null;
    broadcastState();
  }
}

function runSync({ auto = false } = {}) {
  if (syncPromise) return syncPromise;
  const started = Date.now();
  log('sync_start', { meta: { trigger: auto ? 'auto' : 'manual' } });
  syncPromise = (async () => {
    let result = null;
    let merge = null;
    try {
      result = await chaoxing.sync();
      if (!result.ok) {
        const err = new Error(result.message || '尚未登录学习通');
        err.code = result.code || 'AUTH_REQUIRED';
        throw err;
      }
      merge = store.mergeRemote(result.tasks || [], {
        autoAdd: Boolean(store.state.settings.autoAddFromChaoxing)
      });
      // 先让界面看到同步结果，再慢慢补全（补全失败也不影响这一次同步）
      store.setSyncMeta(syncMetaFor(result.auth, result, merge, null));
      broadcastState();
      const detail = await enrichDetailsAfterSync();
      log('sync_merge', {
        durationMs: Date.now() - started,
        meta: {
          added: merge.added, updated: merge.updated, completed: merge.completed,
          missed: merge.missed || 0,
          candidates: merge.candidates, source: result.source
        }
      });
      broadcastState();
      const detailNote = detail && detail.dueFilled ? `，补全截止时间 ${detail.dueFilled} 项` : '';
      return {
        ok: true,
        result,
        merge,
        detail,
        message: `识别 ${result.tasks.length} 项，新增 ${merge.added} 项${merge.missed ? `，错过 ${merge.missed} 项` : ''}${detailNote}`
      };
    } catch (error) {
      const auth = result ? result.auth : null;
      store.setSyncMeta(syncMetaFor(auth, null, null, error));
      log('sync_failed', { ok: false, error, durationMs: Date.now() - started, meta: { trigger: auto ? 'auto' : 'manual' } });
      broadcastState();
      return { ok: false, code: error.code || 'SYNC_FAILED', message: friendlyError(error) };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

async function maybeAutoSync() {
  if (syncPromise) return;
  if (!store.state.settings.autoSync) return;
  const last = store.state.sync.lastAttemptAt || store.state.sync.lastSyncAt;
  const interval = Math.max(5, Number(store.state.settings.autoSyncIntervalMin) || 30) * 60000;
  if (last && Date.now() - Date.parse(last) < interval) return;
  const auth = await chaoxing.getAuthStatus();
  if (!auth.loggedIn) return;
  await runSync({ auto: true });
}

/* ------------------------------------------------------------------ reminders */

const scheduler = new ReminderScheduler({
  store,
  telemetry,
  onFire: (payload) => {
    reminderQueue.push({ ...payload, queuedAt: Date.now() });
    if (reminderQueue.length > 20) { reminderQueue.shift(); reminderDropped += 1; }
  }
});

function processSnoozes() {
  const now = Date.now();
  const due = snoozes.filter((s) => s.at <= now);
  snoozes = snoozes.filter((s) => s.at > now);
  for (const item of due) {
    const task = store.state.tasks.find((t) => t.id === item.payload.taskId);
    if (!task || task.status !== 'pending') continue;
    reminderQueue.push({ ...item.payload, snoozed: true });
    if (reminderQueue.length > 20) { reminderQueue.shift(); reminderDropped += 1; }
  }
}

/* ------------------------------------------------------------------ routes */

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (p === '/api/health' && method === 'GET') return json(res, 200, { ok: true, version: packageJson.version });
  if (p === '/api/shutdown' && method === 'POST') {
    setTimeout(shutdown, 120);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/bootstrap' && method === 'GET') {
    return json(res, 200, {
      ...statePayload(),
      auth: await chaoxing.getAuthStatus(),
      logs: telemetry.summary()
    });
  }
  if (p === '/api/state' && method === 'GET') return json(res, 200, statePayload());
  if (p === '/api/logs' && method === 'GET') {
    return json(res, 200, { ...telemetry.summary(), recent: telemetry.recentEvents(80) });
  }
  if (p === '/api/logs/export' && method === 'GET') {
    const dir = telemetry.logDir;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    let out = '';
    for (const file of files) out += fs.readFileSync(path.join(dir, file), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename=ClassBell-process_logs.jsonl'
    });
    return res.end(out);
  }
  if (p === '/api/data/export' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename=ClassBell-backup.json'
    });
    return res.end(store.exportData());
  }
  if (p === '/api/data/import' && method === 'POST') {
    const text = await readBody(req, 4 * 1024 * 1024);
    const result = store.importData(text);
    log('data_imported', { meta: { imported: result.imported } });
    broadcastState();
    return json(res, 200, result);
  }

  if (p === '/api/tasks' && method === 'POST') {
    const body = await readJson(req);
    const task = store.addTask(body);
    log('task_added', {
      meta: {
        category: task.category, priority: task.priority, source: task.source,
        has_due: Boolean(task.dueAt), recurring: task.recurrence !== 'none'
      }
    });
    broadcastState();
    scheduler.check();
    return json(res, 200, task);
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(complete|restore))?$/.exec(p);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      // manual=true：用户手工改期要打 dueAtManual，之后同步/补全都不许覆盖
      const task = store.updateTask(id, await readJson(req), { manual: true });
      log('task_updated', { meta: { category: task.category, status: task.status } });
      broadcastState();
      scheduler.check();
      return json(res, 200, task);
    }
    if (method === 'DELETE') {
      store.deleteTask(id);
      log('task_deleted');
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && taskMatch[2] === 'complete') {
      const result = store.completeTask(id);
      log('task_completed', { meta: { recurring: Boolean(result.next) } });
      broadcastState();
      return json(res, 200, result);
    }
    if (method === 'POST' && taskMatch[2] === 'restore') {
      const task = store.restoreTask(id);
      log('task_restored');
      broadcastState();
      return json(res, 200, task);
    }
  }

  if (p === '/api/settings' && method === 'POST') {
    const patch = await readJson(req);
    const settings = store.updateSettings(patch);
    log('settings_updated', { meta: { keys: Object.keys(patch) } });
    if ('logMirrorDir' in patch) telemetry.setMirrorDir(settings.logMirrorDir);
    broadcastState();
    return json(res, 200, settings);
  }

  if (p === '/api/log/page' && method === 'POST') {
    const body = await readJson(req);
    log('page_view', { meta: { page: String(body.page || '').slice(0, 30) } });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/first-run' && method === 'POST') {
    store.updateSettings({ firstRun: false });
    broadcastState();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/cx/status' && method === 'GET') {
    return json(res, 200, { ...(await chaoxing.getAuthStatus()), loginUrl: LOGIN_URL, homeUrl: HOME_URL });
  }
  if (p === '/api/cx/cookies' && method === 'POST') {
    const body = await readJson(req);
    chaoxing.setCookies(body.cookies || []);
    try {
      fs.writeFileSync(path.join(dataDir, 'cx-cookies.json'), JSON.stringify(chaoxing.exportCookies()), 'utf8');
    } catch (_) { /* persistence is best effort */ }
    const auth = await chaoxing.getAuthStatus();
    broadcastState();
    return json(res, 200, auth);
  }
  if (p === '/api/cx/cookies' && method === 'GET') {
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'cross-site') {
      return json(res, 403, { error: 'FORBIDDEN_ORIGIN', message: '跨站请求被拒绝' });
    }
    if (chaoxing.exportCookies().length) return json(res, 200, { cookies: chaoxing.exportCookies() });
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'cx-cookies.json'), 'utf8'));
      if (Array.isArray(saved) && saved.length) {
        chaoxing.setCookies(saved);
        return json(res, 200, { cookies: chaoxing.exportCookies() });
      }
    } catch (_) { /* nothing saved yet */ }
    return json(res, 200, { cookies: [] });
  }
  if (p === '/api/cx/sync' && method === 'POST') {
    return json(res, 200, await runSync({ auto: false }));
  }
  if (p === '/api/cx/scan' && method === 'POST') {
    return json(res, 200, {
      rows: [],
      merged: { added: 0, updated: 0, candidates: 0 },
      message: '当前版本使用学习通接口同步，无需扫描页面。'
    });
  }
  if (p === '/api/candidates/dismiss' && method === 'POST') {
    const body = await readJson(req);
    store.dismissCandidate(String(body.id || ''));
    broadcastState();
    return json(res, 200, { ok: true });
  }

  /* ------------------------------------------------------------ notices */

  if (p === '/api/notices' && method === 'POST') {
    const body = await readJson(req);
    const result = store.addNotice({ ...body, source: body.source || 'manual' });
    log('notice_added', { meta: { kind: result.notice.kind, created: result.created } });
    broadcastState();
    return json(res, 200, result.notice);
  }
  if (p === '/api/notices/read-all' && method === 'POST') {
    const result = store.markAllNoticesRead();
    log('notices_read_all', { meta: { updated: result.updated } });
    broadcastState();
    return json(res, 200, result);
  }
  if (p === '/api/notices/extract' && method === 'POST') {
    const started = Date.now();
    let added = 0;
    let source = 'local';
    try {
      const result = await chaoxing.fetchNotices();
      if (result.ok) {
        const stats = store.addNotices(result.notices);
        added += stats.added;
        source = 'chaoxing';
      }
    } catch (error) {
      log('notice_extract_error', { ok: false, error, durationMs: Date.now() - started });
    }
    // Local signals are always available: new assignments, missed deadlines and
    // gear that is still out past its due date.
    const now = Date.now();
    const localNotices = [];
    for (const task of store.state.tasks) {
      if (task.status === 'missed') {
        localNotices.push({
          title: `已错过：${task.title}`,
          body: `${task.course || '未填课程'} · 该作业已无法补交`,
          kind: 'assignment',
          course: task.course,
          source: 'local',
          sourceKey: `local:missed:${task.id}`,
          publishedAt: task.missedAt || task.updatedAt
        });
      } else if (task.status === 'pending' && task.dueAt && new Date(task.dueAt).getTime() < now) {
        localNotices.push({
          title: `已逾期：${task.title}`,
          body: `${task.course || '未填课程'} · 请尽快处理`,
          kind: 'assignment',
          course: task.course,
          source: 'local',
          sourceKey: `local:overdue:${task.id}`,
          publishedAt: task.dueAt
        });
      }
    }
    for (const item of store.state.gear) {
      if (item.status === 'out' && item.dueAt && new Date(item.dueAt).getTime() < now) {
        localNotices.push({
          title: `器材未还：${item.name}`,
          body: `${item.borrower || '借用人未填'} · 应还 ${new Date(item.dueAt).toLocaleString('zh-CN')}`,
          kind: 'gear',
          source: 'local',
          sourceKey: `local:gear:${item.id}:${item.dueAt}`,
          publishedAt: item.dueAt
        });
      }
    }
    const localStats = store.addNotices(localNotices);
    added += localStats.added;
    log('notices_extracted', {
      durationMs: Date.now() - started,
      meta: { added, source, local: localNotices.length }
    });
    broadcastState();
    return json(res, 200, { ok: true, added, source, local: localNotices.length });
  }
  const noticeMatch = /^\/api\/notices\/([^/]+)$/.exec(p);
  if (noticeMatch) {
    const id = decodeURIComponent(noticeMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const notice = store.markNotice(id, body.read !== false);
      broadcastState();
      return json(res, 200, notice);
    }
    if (method === 'DELETE') {
      store.deleteNotice(id);
      broadcastState();
      return json(res, 200, { ok: true });
    }
  }

  /* --------------------------------------------------------------- gear */

  if (p === '/api/gear' && method === 'POST') {
    const body = await readJson(req);
    const item = store.addGear(body);
    log('gear_added', { meta: { has_due: Boolean(item.dueAt) } });
    broadcastState();
    return json(res, 200, item);
  }
  const gearMatch = /^\/api\/gear\/([^/]+)(?:\/(return))?$/.exec(p);
  if (gearMatch) {
    const id = decodeURIComponent(gearMatch[1]);
    if (method === 'POST' && gearMatch[2] === 'return') {
      const body = await readJson(req).catch(() => ({}));
      const item = store.returnGear(id, body || {});
      log('gear_returned', { meta: { condition: item.condition || '' } });
      broadcastState();
      return json(res, 200, item);
    }
    if (method === 'PATCH' || method === 'PUT') {
      const item = store.updateGear(id, await readJson(req));
      broadcastState();
      return json(res, 200, item);
    }
    if (method === 'DELETE') {
      store.deleteGear(id);
      broadcastState();
      return json(res, 200, { ok: true });
    }
  }

  /* ----------------------------------------------------------- mistakes */

  if (p === '/api/mistakes' && method === 'POST') {
    const body = await readJson(req);
    const result = store.addMistake({ ...body, source: body.source === 'chaoxing' ? 'chaoxing' : 'manual' });
    log('mistake_added', { meta: { course: result.mistake.course, created: result.created } });
    broadcastState();
    return json(res, 200, result.mistake);
  }
  if (p === '/api/mistakes/inspect' && method === 'POST') {
    const body = await readJson(req);
    const url = String(body.url || '');
    let target = null;
    try { target = new URL(url); } catch (_) { target = null; }
    const hostName = target ? target.hostname.toLowerCase() : '';
    const chaoxingHost = hostName === 'chaoxing.com' || hostName.endsWith('.chaoxing.com');
    if (!target || target.protocol !== 'https:' || target.username || target.password
        || (target.port && target.port !== '443') || !chaoxingHost) {
      return json(res, 400, { ok: false, error: 'INVALID_URL', message: '仅允许学习通域名' });
    }
    try {
      const page = await chaoxing._fetch(url, { timeout: 15000 });
      const text = page.text || '';
      const keyword = String(body.keyword || '').slice(0, 40);
      let matches = [];
      if (keyword) {
        const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let hit;
        while ((hit = re.exec(text)) && matches.length < 6) {
          matches.push(text.slice(Math.max(0, hit.index - 120), hit.index + 180));
        }
      }
      return json(res, 200, {
        ok: true,
        status: page.status,
        finalUrl: page.url,
        length: text.length,
        matches,
        markers: {
          my: /我的答案|我的作答/.test(text),
          correct: /正确答案/.test(text),
          analysis: /答案解析|试题解析/.test(text),
          reviewed: /已批阅|批阅完成|得分/.test(text),
          iframe: /<iframe/i.test(text),
          login: /passport|请先登录|用户登录/.test(text)
        },
        head: text.slice(0, 6000)
      });
    } catch (error) {
      return json(res, 200, { ok: false, error: cleanError(error) });
    }
  }
  if (p === '/api/mistakes/import-text' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').slice(0, 200000);
    const url = String(body.url || '');
    let title = String(body.title || '');
    let course = String(body.course || '');

    // Fill the missing course/title from the URL and the already synced tasks,
    // so an archived mistake never lands in "未分课程" when we can identify it.
    const courseId = (/[?&]courseId=(\d+)/.exec(url) || [])[1] || '';
    if (courseId) {
      const matched = store.state.tasks.find((t) => t.sourceUrl && t.sourceUrl.indexOf('courseId=' + courseId) >= 0);
      if (matched) {
        if (!course && matched.course) course = matched.course;
        if (!title || /学习通|作业详情|个人空间|课程/.test(title)) title = matched.title || title;
      }
    }
    if (!title) title = '学习通作业';
    const parsed = parseMistakeText(text, url);
    const count = (re) => (text.match(re) || []).length;
    const markers = {
      my: count(/我的答案|我的作答|学生答案/g),
      correct: count(/正确答案/g),
      analysis: count(/答案解析|试题解析/g),
      frames: Number(body.frames || 0),
      readableFrames: Number(body.readableFrames || 0),
      length: text.length
    };
    const items = parsed.map((item, i) => ({
      ...item,
      course,
      title,
      analysis: item.analysis || (item.myAnswer
        ? `我的答案“${item.myAnswer}”与正确答案“${item.correctAnswer || '未给出'}”不一致。`
        : `未作答，正确答案为“${item.correctAnswer || '未给出'}”。`),
      source: 'chaoxing',
      sourceUrl: url,
      sourceKey: `cx:mistake:${hashKey(`${url}|${i}|${item.question.slice(0, 60)}`)}`,
      wrongAt: new Date().toISOString()
    }));
    const stats = store.addMistakes(items);
    log('mistakes_import_text', {
      meta: {
        length: markers.length, frames: markers.frames, readable: markers.readableFrames,
        my: markers.my, correct: markers.correct, found: parsed.length, added: stats.added
      }
    });
    broadcastState();
    const message = parsed.length
      ? `从当前页面归档 ${stats.added} 道错题。`
      : (markers.my
        ? '页面里出现了“我的答案”，但没有配对的正确答案，可能是主观题或页面还没批改完。'
        : `当前页面没有“我的答案 / 正确答案”。已读取 ${markers.length} 字、${markers.frames} 个内嵌框（可读 ${markers.readableFrames} 个）。请确认打开的是已批改的作业详情页。`);
    return json(res, 200, { ok: true, found: parsed.length, added: stats.added, markers, message });
  }
  if (p === '/api/mistakes/extract' && method === 'POST') {    const started = Date.now();
    try {
      const result = await chaoxing.collectMistakes(store.state.tasks, { limit: 12 });
      const stats = store.addMistakes(result.mistakes || []);
      log('mistakes_extracted', {
        durationMs: Date.now() - started,
        meta: { checked: result.checked, found: result.found, added: stats.added }
      });
      broadcastState();
      return json(res, 200, {
        ok: true, checked: result.checked, found: result.found, added: stats.added,
        message: result.found
          ? `检查 ${result.checked} 份作业，归档 ${stats.added} 道错题。`
          : `检查 ${result.checked} 份作业，没有识别到可归档的错题；可在页面里手动添加。`
      });
    } catch (error) {
      log('mistakes_extract_error', { ok: false, error, durationMs: Date.now() - started });
      return json(res, 200, { ok: false, code: cleanError(error).code, message: '读取作业详情失败，请稍后重试或手动添加。' });
    }
  }
  const mistakeMatch = /^\/api\/mistakes\/([^/]+)$/.exec(p);
  if (mistakeMatch) {
    const id = decodeURIComponent(mistakeMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      const item = store.updateMistake(id, await readJson(req));
      broadcastState();
      return json(res, 200, item);
    }
    if (method === 'DELETE') {
      store.deleteMistake(id);
      broadcastState();
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/reminders/pending' && method === 'GET') {
    scheduler.check();
    processSnoozes();
    const items = reminderQueue.splice(0, reminderQueue.length);
    if (reminderDropped > 0) {
      log('reminder_dropped', { meta: { count: reminderDropped } });
      reminderDropped = 0;
    }
    return json(res, 200, { items });
  }
  if (p === '/api/reminders/action' && method === 'POST') {
    const body = await readJson(req);
    const { action, taskId, minutes } = body;
    const task = taskId ? store.state.tasks.find((t) => t.id === taskId) : null;
    let latency = 0;
    if (body.firedAt) {
      const fired = Date.parse(body.firedAt);
      if (Number.isFinite(fired) && fired <= Date.now()) latency = Date.now() - fired;
    }
    log('reminder_action', {
      meta: { action: String(action || '').slice(0, 20), latency_ms: latency }
    });
    if (action === 'done' && task) {
      store.completeTask(taskId);
      log('reminder_done', { meta: { action: 'done' } });
      broadcastState();
    } else if (action === 'snooze' && task) {
      const delay = Math.max(1, Math.min(120, Number(minutes) || 10));
      snoozes.push({
        at: Date.now() + delay * 60000,
        payload: {
          taskId, title: task.title, course: task.course, category: task.category,
          priority: task.priority, dueAt: task.dueAt, offset: -1, lateMinutes: 0, silent: false
        }
      });
      log('reminder_snoozed', { meta: { minutes: delay } });
    } else if (action === 'close' && task) {
      scheduler.dismiss(taskId);
      log('reminder_dismissed');
    } else if (action === 'open' && task) {
      log('reminder_open_task');
    }
    return json(res, 200, { ok: true, openTask: action === 'open' ? taskId : null });
  }

  if (p === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  return json(res, 404, { error: 'NOT_FOUND', message: '接口不存在' });
}

/* ------------------------------------------------------------------ start */

const API_STATUS = {
  TASK_NOT_FOUND: 404, NOTICE_NOT_FOUND: 404, GEAR_NOT_FOUND: 404, MISTAKE_NOT_FOUND: 404,
  TASK_TITLE_REQUIRED: 422, TASK_DUE_INVALID: 422, MISTAKE_QUESTION_REQUIRED: 422,
  GEAR_NAME_REQUIRED: 422, NOTICE_TITLE_REQUIRED: 422, IMPORT_INVALID_FORMAT: 422,
  IMPORT_INVALID_JSON: 422, TASK_LIMIT_REACHED: 409
};

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) {
    if (req.url.startsWith('/api/') || req.url === '/events') {
      return json(res, 403, { error: 'HOST_NOT_ALLOWED', message: '仅允许本机访问' });
    }
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('仅允许本机访问');
  }
  if (crossSiteWrite(req)) {
    return json(res, 403, { error: 'FORBIDDEN_ORIGIN', message: '跨站请求被拒绝' });
  }
  if (req.url.startsWith('/api/') || req.url === '/events') {
    handleApi(req, res).catch((error) => {
      const code = (error && error.code) || error.message || 'SERVER_ERROR';
      log('api_error', { ok: false, error, meta: { path: req.url.split('?')[0] } });
      if (!res.headersSent) {
        json(res, API_STATUS[code] || 400, { error: code, message: String((error && error.message) || error).slice(0, 200) });
      } else res.end();
    });
    return;
  }
  try { serveStatic(req, res); }
  catch (error) {
    if (!res.headersSent) json(res, 400, { error: 'BAD_REQUEST', message: '请求格式错误' });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});

server.listen(port, '127.0.0.1', () => {
  telemetry.log('app_start', {
    meta: { host: 'webview2', port, packaged: true, node: process.versions.node }
  });
  telemetry.writeIndex();
  scheduler.start();
  autoSyncTimer = setInterval(() => maybeAutoSync(), 60000);
  setTimeout(() => maybeAutoSync(), 15000);
  setInterval(() => {
    telemetry.log('heartbeat', {
      meta: { uptime_min: Math.round(process.uptime() / 60), pending: store.stats().pending }
    });
  }, Number((process.env.CLASSBELL_HEARTBEAT_MS || process.env.CAMPUSPULSE_HEARTBEAT_MS)) || 5 * 60000);
  console.log(`ClassBell server listening on 127.0.0.1:${port}`);
});

function shutdown() {
  try { scheduler.stop(); } catch (_) {}
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  try { store.flush(); } catch (_) {}
  try { telemetry.flush(); } catch (_) {}
  try { telemetry.writeIndex(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  try { log('uncaught_exception', { ok: false, error }); } catch (_) { /* ignore */ }
  try { store.flush(); } catch (_) { /* ignore */ }
  try { telemetry.flush(); } catch (_) { /* ignore */ }
  try { telemetry.writeIndex(); } catch (_) { /* ignore */ }
  // Running on after an unhandled exception leaves the service in an unknown
  // state; exit and let the host report it instead of serving bad data.
  setTimeout(() => process.exit(1), 60);
});
process.on('unhandledRejection', (error) => log('unhandled_rejection', { ok: false, error }));
