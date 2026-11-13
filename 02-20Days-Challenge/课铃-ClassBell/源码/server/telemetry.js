'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 这些事件表示“主通道不可用，但备用通道已顶上”，对用户没有影响。
// 归类为 degraded：不计入错误数，只单独计数，避免日志页一屏红字。
const DEGRADED_EVENTS = new Set([
  'task_feed_error',
  'task_feed_error_waf',
  'course_list_error',
  'course_tasks_error',
  'detail_no_deadline'
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTimestamp(d = new Date()) {
  return `${dayKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 160);
    else if (Array.isArray(value)) out[key] = value.slice(0, 12).map((v) => String(v).slice(0, 40));
    else if (typeof value === 'object') out[key] = undefined;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeError(error) {
  if (!error) return undefined;
  if (typeof error === 'string') return { code: 'ERROR', message: error.slice(0, 240) };
  return {
    code: String(error.code || error.name || 'ERROR').slice(0, 60),
    message: String(error.message || error).slice(0, 240)
  };
}

class Telemetry {
  constructor({ dataDir, mirrorDir = '', appVersion = '0.0.0' }) {
    this.dataDir = dataDir;
    this.logDir = path.join(dataDir, 'process_logs');
    this.indexFile = path.join(this.logDir, 'index.json');
    this.appVersion = appVersion;
    const idFile = path.join(dataDir, 'install.id');
    try {
      if (fs.existsSync(idFile)) this.installId = fs.readFileSync(idFile, 'utf8').trim();
    } catch (_) { /* regenerate below */ }
    if (!this.installId || !/^[a-f0-9-]{8,40}$/i.test(this.installId)) {
      this.installId = crypto.randomUUID();
      try { fs.writeFileSync(idFile, this.installId, 'utf8'); } catch (_) { /* ignore */ }
    }
    this.session = crypto.randomUUID();
    this.seq = 0;
    this.mirrorDir = '';
    this.mirrorErrorAt = 0;
    this.hidden = false;
    fs.mkdirSync(this.logDir, { recursive: true });
    this.setMirrorDir(mirrorDir);
  }

  setMirrorDir(dir) {
    let next = '';
    if (dir) {
      const p = path.resolve(String(dir));
      next = path.basename(p).toLowerCase() === 'process_logs' ? p : path.join(p, 'process_logs');
    }
    this.mirrorDir = next;
    if (next) {
      try {
        fs.mkdirSync(next, { recursive: true });
        this._mirrorRecent();
      } catch (err) {
        if (Date.now() - this.mirrorErrorAt > 60_000) {
          this.mirrorErrorAt = Date.now();
          this.log('log_mirror_error', { ok: false, error: err });
        }
      }
    }
  }

  _file(day = dayKey()) {
    return path.join(this.logDir, `${day}.jsonl`);
  }

  _mirrorFile(day = dayKey()) {
    return this.mirrorDir ? path.join(this.mirrorDir, `${day}.jsonl`) : '';
  }

  _mirrorRecent() {
    if (!this.mirrorDir) return;
    const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl')).slice(-7);
    for (const name of files) {
      const src = path.join(this.logDir, name);
      const dest = path.join(this.mirrorDir, name);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      else {
        const srcSize = fs.statSync(src).size;
        const destSize = fs.statSync(dest).size;
        if (srcSize > destSize) {
          const data = fs.readFileSync(src);
          fs.writeFileSync(dest, data.subarray(destSize));
        }
      }
    }
    if (fs.existsSync(this.indexFile)) fs.copyFileSync(this.indexFile, path.join(this.mirrorDir, 'index.json'));
  }

  log(event, options = {}) {
    if (this.hidden) return;
    const now = new Date();
    const entry = {
      v: 1,
      ts: now.toISOString(),
      local: localTimestamp(now),
      tz: -now.getTimezoneOffset(),
      day: dayKey(now),
      session: this.session,
      seq: ++this.seq,
      app: this.appVersion,
      install: this.installId,
      event: String(event || 'event').slice(0, 60),
      ok: options.ok !== false,
      duration_ms: Number.isFinite(options.durationMs) ? Math.max(0, Math.round(options.durationMs)) : 0
    };
    const error = safeError(options.error);
    if (error) entry.error = error;
    const meta = sanitizeMeta(options.meta);
    if (meta) entry.meta = meta;
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(this._file(entry.day), line, 'utf8');
    } catch (err) {
      console.error('telemetry write failed', err);
    }
    if (this.mirrorDir) {
      try {
        fs.mkdirSync(this.mirrorDir, { recursive: true });
        fs.appendFileSync(path.join(this.mirrorDir, `${entry.day}.jsonl`), line, 'utf8');
      } catch (err) {
        if (Date.now() - this.mirrorErrorAt > 60_000) {
          this.mirrorErrorAt = Date.now();
          try {
            const fallback = {
              ...entry,
              seq: ++this.seq,
              event: 'log_mirror_error',
              ok: false,
              error: safeError(err)
            };
            delete fallback.meta;
            fs.appendFileSync(this._file(entry.day), `${JSON.stringify(fallback)}\n`, 'utf8');
          } catch (_) { /* ignore */ }
        }
      }
    }
    return entry;
  }

  hide(value = true) {
    this.hidden = Boolean(value);
  }

  _readFile(file) {
    const entries = [];
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return entries; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch (_) { /* skip partial line */ }
    }
    return entries;
  }

  readDays(count = 7) {
    const days = [];
    const today = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = dayKey(d);
      const entries = this._readFile(this._file(key));
      // 只统计“尚未恢复”的错误：像 learn 主接口 403 但备用通道成功的情况，
      // 对用户没有影响，不该出现在错误计数里（否则每天都是 8 条红字）。
      // 只统计真正需要用户关心的错误：
      //  - meta.recovered：已由备用通道恢复
      //  - DEGRADED_EVENTS：本身就有降级兜底（例如主接口 403）
      const errors = entries.filter((e) => e.ok === false
        && !(e.meta && e.meta.recovered)
        && !DEGRADED_EVENTS.has(e.event)).length;
      const degraded = entries.filter((e) => e.ok === false && DEGRADED_EVENTS.has(e.event)).length;
      const heartbeats = entries.filter((e) => e.event === 'heartbeat').length;
      const actions = entries.filter((e) => !['heartbeat', 'app_start', 'app_stop'].includes(e.event));
      const duration = entries.reduce((sum, e) => sum + (Number(e.duration_ms) || 0), 0);
      days.push({
        day: key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        weekday: '日一二三四五六'[d.getDay()],
        events: entries.length,
        actions: actions.length,
        errors,
        degraded,
        heartbeats,
        activeMinutes: heartbeats * 5,
        durationMs: duration,
        syncs: entries.filter((e) => e.event === 'sync_complete' || e.event === 'sync_ok').length,
        added: entries.filter((e) => e.event === 'task_added').length,
        reminders: entries.filter((e) => e.event === 'reminder_fired').length,
        hasData: entries.length > 0
      });
    }
    return days;
  }

  recentEvents(limit = 80) {
    const all = [];
    const today = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      all.push(...this._readFile(this._file(dayKey(d))));
    }
    return all.slice(-limit).reverse().map((e) => ({
      local: e.local,
      event: e.event,
      ok: e.ok !== false,
      duration_ms: e.duration_ms,
      error: e.error ? `${e.error.code}: ${e.error.message}` : '',
      meta: e.meta || {}
    }));
  }

  summary() {
    const days = this.readDays(7);
    const today = days[days.length - 1];
    return {
      days,
      today,
      totals: {
        events: days.reduce((s, d) => s + d.events, 0),
        errors: days.reduce((s, d) => s + d.errors, 0),
        syncs: days.reduce((s, d) => s + d.syncs, 0),
        activeDays: days.filter((d) => d.hasData).length
      },
      logDir: this.logDir,
      mirrorDir: this.mirrorDir,
      session: this.session
    };
  }

  todayText() {
    try { return fs.readFileSync(this._file(), 'utf8'); } catch (_) { return ''; }
  }

  writeIndex() {
    try {
      const days = this.readDays(7);
      const payload = {
        schema: 1,
        generatedAt: localTimestamp(),
        appVersion: this.appVersion,
        totals: {
          events: days.reduce((s, d) => s + d.events, 0),
          errors: days.reduce((s, d) => s + d.errors, 0),
          syncs: days.reduce((s, d) => s + d.syncs, 0),
          activeDays: days.filter((d) => d.hasData).length
        },
        days
      };
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      fs.writeFileSync(this.indexFile, text, 'utf8');
      if (this.mirrorDir) fs.writeFileSync(path.join(this.mirrorDir, 'index.json'), text, 'utf8');
    } catch (err) {
      // The index is an aggregation; never let it break normal logging.
    }
  }

  copyAllTo(destination) {
    const dest = path.resolve(destination);
    fs.mkdirSync(dest, { recursive: true });
    const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl') || f === 'index.json');
    for (const name of files) fs.copyFileSync(path.join(this.logDir, name), path.join(dest, name));
    return { copied: files.length, destination: dest };
  }

  flush() {
    this.log('app_stop', { meta: { uptime_s: Math.round(process.uptime()) } });
  }
}

module.exports = { Telemetry, dayKey, localTimestamp };
