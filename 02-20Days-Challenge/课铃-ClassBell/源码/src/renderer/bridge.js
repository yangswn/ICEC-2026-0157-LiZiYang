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
      return result;
    },
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
    firstRunDone: () => request('POST', '/api/first-run'),
    openExternal: (url) => host('openExternal', url),

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
    onReminderData: (cb) => on('reminderData', cb),
    onCxLoading: () => () => {},
    onCxNavigated: () => () => {},
    onCxPageTitle: () => () => {},
    onCxLoadError: () => () => {},
    onCxOpenUrl: () => () => {}
  };

  window.__campusNewTask = () => emit('newTask');
  window.__campusOpenTask = (id) => emit('openTask', id);
  window.campus = api;
})();
