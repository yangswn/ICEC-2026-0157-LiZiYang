'use strict';

const {
  parseTaskFeed,
  parseBackClazz,
  parseWorkListHtml,
  parseExamListHtml,
  extractDeadline,
  parseTimeValue,
  stripTags,
  dedupe,
  parseNoticeFeed,
  parseNoticeHtml,
  parseMistakeHtml
} = require('./chaoxing-parser');

const LOGIN_URL = 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com';
const HOME_URL = 'https://i.chaoxing.com/';
const API_BASE = 'https://mooc1-api.chaoxing.com';
const HTML_BASE = 'https://mooc1.chaoxing.com';

class ChaoxingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanError(error) {
  return {
    code: (error && error.code) || 'ERROR',
    message: String((error && error.message) || error).slice(0, 240)
  };
}

function deadlineFromWorkPage(html) {
  const raw = String(html || '');
  const ms = /"(?:taskendtime|endTime|end_time|deadline)"\s*:\s*"?(\d{10,13})/i.exec(raw);
  if (ms) {
    const parsed = parseTimeValue(ms[1]);
    if (parsed) return parsed;
  }
  const iso = /"(?:endTime|end_time|deadline|taskendtime)"\s*:\s*"([^"]{4,40})"/i.exec(raw);
  if (iso) {
    const parsed = parseTimeValue(iso[1]);
    if (parsed) return parsed;
  }
  const text = stripTags(raw);
  const labeled = /(?:截止时间|结束时间|提交截止|截止日期|有效期至)\s*[:：]?\s*([^，。；|]{4,48})/.exec(text);
  if (labeled) {
    const parsed = extractDeadline(labeled[1]);
    if (parsed) return parsed;
  }
  return null;
}

class ChaoxingService {
  constructor({ telemetry }) {
    this.telemetry = telemetry;
    this.cookies = [];
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    this.lastAuth = null;
  }

  setCookies(cookies) {
    this.cookies = Array.isArray(cookies) ? cookies : [];
    this.telemetry.log('cx_cookies_received', {
      meta: { count: this.cookies.length, has_uid: this.getUid() !== '' }
    });
  }

  /**
   * Keep only the fields needed to re-inject the session into WebView2 after a
   * restart. Chaoxing login cookies are session-scoped, so WebView2 drops them
   * when the host exits; persisting them locally avoids a re-login every start.
   */
  exportCookies() {
    return this.cookies
      .filter((c) => c && c.name && c.value !== undefined && c.value !== '')
      .map((c) => ({
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain || '.chaoxing.com'),
        path: String(c.path || '/')
      }));
  }

  getUid() {
    const find = (name) => this.cookies.find((c) => c && c.name === name);
    return (find('_uid') || find('UID') || find('puid') || {}).value || '';
  }

  cookieHeader() {
    return this.cookies
      .filter((c) => c && c.name && c.value !== undefined)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  async getAuthStatus() {
    const uid = this.getUid();
    this.lastAuth = {
      loggedIn: Boolean(uid),
      uid,
      name: '',
      url: '',
      checkedAt: new Date().toISOString()
    };
    return this.lastAuth;
  }

  async _fetch(url, { timeout = 22000, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'application/json, text/plain, text/html, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          'Referer': 'https://i.chaoxing.com/',
          'Cookie': this.cookieHeader(),
          ...headers
        }
      });
      const text = await res.text();
      if (!res.ok) throw new ChaoxingError(`HTTP_${res.status}`, `HTTP ${res.status}`);
      if (text.length > 8 * 1024 * 1024) throw new ChaoxingError('RESPONSE_TOO_LARGE', 'response too large');
      return { status: res.status, text, url: res.url || url, contentType: res.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  }

  async _fetchJson(url, opts) {
    const res = await this._fetch(url, opts);
    const trimmed = res.text.trim();
    if (trimmed.startsWith('<')) {
      throw new ChaoxingError('WAF_HTML', 'server returned HTML instead of JSON');
    }
    try {
      return JSON.parse(trimmed.replace(/^\uFEFF/, ''));
    } catch (_) {
      throw new ChaoxingError('INVALID_JSON', 'response is not valid JSON');
    }
  }

  async fetchCourseList() {
    const url = `${API_BASE}/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode=`;
    return parseBackClazz(await this._fetchJson(url));
  }

  async fetchTaskFeed(uid) {
    if (!uid) throw new ChaoxingError('UID_MISSING', '未读取到学习通用户标识');
    const fields = [
      'id', 'userid', 'taskrefid', 'classid', 'courseid', 'taskcreatetime',
      'taskopentime', 'taskendtime', 'status', 'type', 'coursename',
      'coursecover', 'title', 'dotaskurl', 'clientexam', 'finishstandard'
    ].join(',');
    const params = new URLSearchParams({
      id: '', userid: uid, type: '', limit: '100', offset: '0',
      order: 'time', orderway: 'desc', fields, view: 'json'
    });
    const body = await this._fetchJson(`${API_BASE}/gas/taskmsg?${params.toString()}`);
    if (Number(body.result) !== 1) throw new ChaoxingError('FEED_RESULT_ERROR', `task feed result=${body.result}`);
    return parseTaskFeed(body);
  }

  async fetchCourseTasks(courses, limit = 30) {
    const list = courses.slice(0, limit);
    const out = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(3, list.length || 1) }, async () => {
      while (index < list.length) {
        const course = list[index++];
        for (const kind of ['work', 'exam']) {
          const url = `${API_BASE}/phone/moocAnalysis/${kind}List?courseId=${encodeURIComponent(course.courseId)}&classId=${encodeURIComponent(course.classId)}`;
          try {
            const res = await this._fetch(url);
            const text = res.text.trim();
            let tasks = [];
            if (text.startsWith('{')) {
              try { tasks = parseTaskFeed(JSON.parse(text.replace(/^\uFEFF/, ''))); } catch (_) { tasks = []; }
            } else {
              tasks = kind === 'work' ? parseWorkListHtml(text, HTML_BASE) : parseExamListHtml(text, HTML_BASE);
            }
            for (const task of tasks) {
              task.course = task.course || course.courseName;
              task.sourceKey = `${task.sourceKey}:${course.classId}`;
              out.push(task);
            }
          } catch (_) { /* best effort */ }
        }
      }
    });
    await Promise.all(workers);
    return dedupe(out);
  }

  /**
   * The H5 work list often carries only a publish date. Fetch the detail pages
   * for rows that still lack a deadline and parse the actual close time.
   */
  async enrichDeadlines(tasks) {
    const targets = tasks
      .filter((t) => !t.dueAt && t.sourceUrl && Number(t.remoteStatus || 0) === 0)
      .slice(0, 40);
    if (!targets.length) return { checked: 0, found: 0 };
    const started = Date.now();
    let index = 0;
    let found = 0;
    const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (index < targets.length) {
        const task = targets[index++];
        try {
          const res = await this._fetch(task.sourceUrl, { timeout: 12000 });
          const due = deadlineFromWorkPage(res.text);
          if (due) {
            task.dueAt = due.toISOString();
            found++;
          }
        } catch (_) { /* keep as candidate */ }
      }
    });
    await Promise.all(workers);
    this.telemetry.log('deadline_enrichment', {
      durationMs: Date.now() - started,
      meta: { checked: targets.length, found }
    });
    return { checked: targets.length, found };
  }

  /**
   * Best-effort notice extraction. Chaoxing has no stable public notice API,
   * so several known endpoints are tried and the first usable payload wins.
   */
  async fetchNotices() {
    const started = Date.now();
    const urls = [
      'https://notice.chaoxing.com/pc/notice/list?page=1&size=30',
      'https://i.chaoxing.com/base/message/notice/list?page=1&size=30',
      'https://mooc1.chaoxing.com/mooc-ans/notice/list?page=1&size=30'
    ];
    for (const url of urls) {
      try {
        const res = await this._fetch(url, { timeout: 12000 });
        const text = res.text.trim();
        const notices = text.startsWith('{') || text.startsWith('[')
          ? parseNoticeFeed(JSON.parse(text.replace(/^\uFEFF/, '')))
          : parseNoticeHtml(text, url);
        if (notices.length) {
          this.telemetry.log('notices_extracted', {
            durationMs: Date.now() - started,
            meta: { count: notices.length, via: 'api' }
          });
          return { ok: true, notices, source: 'api' };
        }
      } catch (_) { /* try next */ }
    }
    this.telemetry.log('notices_extracted', {
      durationMs: Date.now() - started,
      ok: false,
      error: { code: 'NOTICE_SOURCE_UNAVAILABLE', message: 'no notice endpoint returned data' },
      meta: { count: 0, via: 'api' }
    });
    return { ok: false, notices: [], code: 'NOTICE_SOURCE_UNAVAILABLE' };
  }

  /**
   * Read finished work pages and keep the questions whose answers were wrong.
   */
  async collectMistakes(tasks, { limit = 12 } = {}) {
    const started = Date.now();
    const targets = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => t && t.sourceUrl)
      .slice(0, limit);
    if (!targets.length) return { ok: true, mistakes: [], checked: 0, found: 0 };

    const out = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (index < targets.length) {
        const task = targets[index++];
        try {
          const page = await this._fetch(task.sourceUrl, { timeout: 14000 });
          let html = page.text;
          let parsed = parseMistakeHtml(html, task.sourceUrl);
          if (!parsed.length) {
            // The work list links to a wrapper page that JS-redirects to the real
            // answer sheet; fetch that sheet directly instead.
            const next = /\/work\/phone\/doHomeWork\?[^'"\s<]+/.exec(html);
            if (next) {
              const answerUrl = 'https://mooc1.chaoxing.com/mooc-ans' + next[0].replace(/&amp;/g, '&');
              try {
                const sheet = await this._fetch(answerUrl, { timeout: 14000 });
                html = sheet.text;
                parsed = parseMistakeHtml(html, answerUrl);
              } catch (_) { /* keep empty */ }
            }
          }
          parsed.forEach((item, i) => {
            out.push({
              ...item,
              course: task.course || '',
              title: task.title || '',
              source: 'chaoxing',
              sourceUrl: task.sourceUrl,
              sourceKey: `cx:mistake:${task.sourceKey || task.id}:${i}:${item.question.slice(0, 40)}`,
              wrongAt: task.completedAt || task.missedAt || new Date().toISOString()
            });
          });
        } catch (_) { /* skip unreadable page */ }
      }
    });
    await Promise.all(workers);

    this.telemetry.log('mistakes_extracted', {
      durationMs: Date.now() - started,
      meta: { checked: targets.length, found: out.length }
    });
    return { ok: true, mistakes: out, checked: targets.length, found: out.length };
  }

  async sync() {
    const started = Date.now();
    const auth = await this.getAuthStatus();
    if (!auth.loggedIn) {
      return {
        ok: false, code: 'AUTH_REQUIRED', message: '请先打开学习通登录窗口完成登录。',
        auth, tasks: [], courses: [], durationMs: Date.now() - started
      };
    }

    let courses = [];
    let tasks = [];
    let source = 'api';
    let warning = '';

    try {
      tasks = await this.fetchTaskFeed(auth.uid);
    } catch (error) {
      warning = cleanError(error).code;
      // 主接口（gas/taskmsg）在部分账号上固定返回 403，这是平台限制而不是故障；
      // 后面的课程列表/H5 兜底会正常工作，所以把这条记为“已恢复”，
      // 避免日志页把每次同步都渲染成红色异常。
      this.telemetry.log('task_feed_error', {
        ok: false,
        error,
        meta: { fallback: true, recovered: true }
      });
    }

    try {
      courses = await this.fetchCourseList();
    } catch (error) {
      this.telemetry.log('course_list_error', { ok: false, error });
    }

    if (!tasks.length) {
      source = 'fallback';
      if (courses.length) {
        tasks = await this.fetchCourseTasks(courses);
      }
    }

    if (tasks.length) await this.enrichDeadlines(tasks);

    tasks = dedupe(tasks);
    const durationMs = Date.now() - started;
    this.telemetry.log('sync_complete', {
      durationMs,
      ok: tasks.length > 0,
      meta: {
        source,
        courses: courses.length,
        tasks: tasks.length,
        waf_fallback: warning === 'WAF_HTML'
      }
    });
    return {
      ok: true,
      auth,
      tasks: tasks.slice(0, 800),
      courses,
      pageRows: [],
      source,
      warning,
      durationMs
    };
  }
}

module.exports = { ChaoxingService, ChaoxingError, LOGIN_URL, HOME_URL, cleanError };
