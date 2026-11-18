'use strict';

/* WebView2 bridge: implements the same window.campus surface the renderer
   used under Electron, backed by the local Node service and native host. */
(function () {
  const hostAvailable = Boolean(window.chrome && window.chrome.webview);
  const listeners = new Map();
  const pending = new Map();
  let sequence = 0;

  function emit(type, payload) {
    const list = listeners.get(type) || [];
    for (const fn of list) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }

  window.__hostEmit = function (type, payload) {
    emit(type, payload);
  };
  window.__hostResolve = function (id, ok, json) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    let value = null;
    try { value = json ? JSON.parse(json) : null; } catch (_) { value = null; }
    if (ok) entry.resolve(value);
    else entry.reject(new Error((value && value.message) || '本机操作失败'));
  };

  function on(type, callback) {
    if (typeof callback !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
    return () => {
      const list = listeners.get(type) || [];
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  function host(method, ...args) {
    if (!hostAvailable) return Promise.reject(new Error('HOST_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const id = `h${++sequence}`;
      pending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ type: 'host', id, method, args });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('本机操作超时'));
        }
      }, 20000);
    });
  }

  if (hostAvailable) {
    window.chrome.webview.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'result') {
        window.__hostResolve(data.id, data.ok, data.json);
      } else if (data.type === 'event') {
        emit(data.event, data.payload);
      }
    });
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('native-shell');
    });
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!response.ok) {
      const err = new Error((data && data.message) || `请求失败 (${response.status})`);
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 200);
  }

  function pickImportFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) { reject(new Error('未选择文件')); input.remove(); return; }
        const reader = new FileReader();
        reader.onload = () => { input.remove(); resolve(String(reader.result || '')); };
        reader.onerror = () => { input.remove(); reject(new Error('读取文件失败')); };
        reader.readAsText(file, 'utf-8');
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  const api = {
    bootstrap: () => request('GET', '/api/bootstrap'),
    getState: () => request('GET', '/api/state'),
    getMeta: async () => (await request('GET', '/api/state')).meta,
    getStats: async () => (await request('GET', '/api/state')).stats,
    quit: () => host('quit'),
    hide: () => host('windowAction', 'minimize'),
    openDataDir: () => host('openPath', '__DATA__'),
    windowAction: (action) => host('windowAction', action),

    addTask: (task) => request('POST', '/api/tasks', task),
    updateTask: (id, patch) => request('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch),
    deleteTask: (id) => request('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
    completeTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/complete`),
    restoreTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/restore`),

    updateSettings: async (patch) => {
      const result = await request('POST', '/api/settings', patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'autoLaunch')) {
        host('setAutoLaunch', Boolean(patch.autoLaunch)).catch(() => {});
      }
      // 关闭行为要立即生效，否则用户切完开关当场点 × 会以为没生效
      if (Object.prototype.hasOwnProperty.call(patch, 'closeToTray')) {
        host('applyCloseToTray', Boolean(patch.closeToTray)).catch(() => {});
      }
      // 浮窗开关同理：改完要马上出现/消失，用户不会等 30 秒
      if (Object.prototype.hasOwnProperty.call(patch, 'floatWindow')) {
        host('applyFloatWindow', Boolean(patch.floatWindow)).catch(() => {});
      }
      // 浮窗 / 弹窗字号也立刻生效：不然要等 30 秒轮询，用户会以为没调成功。
      // 主界面缩放不在这里处理 —— 那是前端 CSS zoom，宿主不参与。
      if (Object.prototype.hasOwnProperty.call(patch, 'floatScale')) {
        host('applySurfaceScale', 'float', Number(patch.floatScale)).catch(() => {});
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'toastScale')) {
        host('applySurfaceScale', 'toast', Number(patch.toastScale)).catch(() => {});
      }
      // 浮窗条数 / 透明度：拖完立刻生效，不用等下一轮轮询。
      // 两个值一起传，宿主一次重排就够。
      if (Object.prototype.hasOwnProperty.call(patch, 'floatTaskCount')
          || Object.prototype.hasOwnProperty.call(patch, 'floatOpacity')) {
        // 没提交的那一项传 null：宿主那边表示「这一项没变，别动它」。
        // 以前这里填默认值，导致只调透明度时条数被重置成 1。
        const hasCount = Object.prototype.hasOwnProperty.call(patch, 'floatTaskCount');
        const hasOpacity = Object.prototype.hasOwnProperty.call(patch, 'floatOpacity');
        const count = hasCount ? Number(patch.floatTaskCount) : null;
        const opacity = hasOpacity ? Number(patch.floatOpacity) : null;
        host('applyFloatOptions',
          Number.isFinite(count) ? count : null,
          Number.isFinite(opacity) ? opacity : null).catch(() => {});
      }
      return result;
    },
    /**
     * 透明度预览：只把当前值推给宿主，不写设置。
     *
     * 为什么单独一个方法而不是复用 updateSettings：
     * 拖动滑杆时 input 每秒会触发几十次，走 updateSettings 就是几十次
     * POST /api/settings + 写 data.json + broadcastState —— 又慢又脏。
     * 这条通道直接发宿主消息，落盘留给松手时的 change。
     */
    previewFloatOpacity: (value) => host('applyFloatOptions', null, value),
    chooseLogDir: () => host('chooseFolder'),
    clearLogDir: () => request('POST', '/api/settings', { logMirrorDir: '' }),

    logSummary: () => request('GET', '/api/logs'),
    openLogDir: () => host('openPath', '__LOGS__'),
    openMirrorDir: async () => {
      const logs = await request('GET', '/api/logs');
      if (logs.mirrorDir) return host('openPath', logs.mirrorDir);
      return '';
    },
        // 优先让宿主弹“另存为”并落盘；浏览器模式下退回普通下载。
    copyLogs: async () => {
      try { return await host('saveLogs'); }
      catch (_) { download('/api/logs/export'); return { path: '', fallback: true }; }
    },
        exportData: async () => {
      try { return await host('saveData'); }
      catch (_) { download('/api/data/export'); return { path: '', fallback: true }; }
    },
    importData: async () => {
      const text = await pickImportFile();
      return request('POST', '/api/data/import', JSON.parse(text));
    },

    cxStatus: () => request('GET', '/api/cx/status'),
    cxSync: () => request('POST', '/api/cx/sync'),
    cxScanPage: () => request('POST', '/api/cx/scan'),
    cxOpenUrl: () => Promise.resolve(true),
    dismissCandidate: (id) => request('POST', '/api/candidates/dismiss', { id }),
    openLogin: () => host('openLogin'),

    addNotice: (notice) => request('POST', '/api/notices', notice),
    updateNotice: (id, patch) => request('PATCH', `/api/notices/${encodeURIComponent(id)}`, patch),
    deleteNotice: (id) => request('DELETE', `/api/notices/${encodeURIComponent(id)}`),
    readAllNotices: () => request('POST', '/api/notices/read-all', {}),
    extractNotices: () => request('POST', '/api/notices/extract', {}),

    addGear: (item) => request('POST', '/api/gear', item),
    updateGear: (id, patch) => request('PATCH', `/api/gear/${encodeURIComponent(id)}`, patch),
    returnGear: (id, extra) => request('POST', `/api/gear/${encodeURIComponent(id)}/return`, extra || {}),
    deleteGear: (id) => request('DELETE', `/api/gear/${encodeURIComponent(id)}`),

    addMistake: (item) => request('POST', '/api/mistakes', item),
    updateMistake: (id, patch) => request('PATCH', `/api/mistakes/${encodeURIComponent(id)}`, patch),
    deleteMistake: (id) => request('DELETE', `/api/mistakes/${encodeURIComponent(id)}`),
    extractMistakes: () => request('POST', '/api/mistakes/extract', {}),
    // autoOpen=true 仅用于用户主动点击；自动扫描一律 false
    scanLoginPage: (autoOpen) => host('scanLoginPage', Boolean(autoOpen)),
    importMistakesFromPage: (page) => request('POST', '/api/mistakes/import-text', page),

    testReminder: () => host('testReminder'),
    reminderAction: async (action, taskId, minutes, firedAt) => {
      const result = await request('POST', '/api/reminders/action', { action, taskId, minutes, firedAt });
      if (action === 'open' && result && result.openTask) {
        await host('openTask', result.openTask);
      }
      host('closeReminder').catch(() => {});
      return true;
    },
    pageView: (page) => request('POST', '/api/log/page', { page }),
    // 今晚能做多少：budgetMinutes 由用户点 1/2/3 小时或半天决定
    tonightPlan: (budgetMinutes) => request('GET', `/api/tonight?minutes=${encodeURIComponent(budgetMinutes)}`),
    // 预热估时：首屏不等它，估完再刷新一次
    estimateAll: () => request('GET', '/api/estimate'),
    // 可选精估：只有设置里打开开关才调；问的是本机 1.5b 小模型
    refineEstimates: () => request('GET', '/api/estimate/refine'),
    // 查询 1.5b 在不在：设置页那行状态用它，失败了也只是显示未检测到
    modelStatus: () => request('GET', '/api/estimate/model'),
    // 点「开始做」记开工时间，完成时才知道真实耗时
    startTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/start`, {}),
    // 没点开始做的任务，完成时把用户选的耗时区间带上
    completeTaskWithMinutes: (id, minutes) => request('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { actualMinutes: minutes }),
    firstRunDone: () => request('POST', '/api/first-run'),
    openExternal: (url) => host('openExternal', url),
    // 走宿主剪贴板：WebView2 里 navigator.clipboard 常被拒
    copyText: (text) => host('copyText', text),

    onState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      if (new URLSearchParams(location.search).has('static')) return () => {};
      if (window.EventSource) {
        const es = new EventSource('/events');
        es.addEventListener('state', (event) => {
          try { callback(JSON.parse(event.data)); } catch (_) { /* ignore */ }
        });
        return () => es.close();
      }
      return () => {};
    },
    onMaximized: () => () => {},
    onNewTask: (cb) => on('newTask', cb),
    onOpenTask: (cb) => on('openTask', cb),
    onGoPage: (cb) => on('goPage', cb),
    onReminderData: (cb) => on('reminderData', cb),
    onCxLoading: () => () => {},
    onCxNavigated: () => () => {},
    onCxPageTitle: () => () => {},
    onCxLoadError: () => () => {},
    onCxOpenUrl: () => () => {}
  };

  window.__campusNewTask = () => emit('newTask');
  window.__campusOpenTask = (id) => emit('openTask', id);
  // 浮窗右键菜单「设置」用：宿主执行 window.__campusGoPage("settings")
  window.__campusGoPage = (page) => emit('goPage', page);
  window.campus = api;
})();
