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
  parseMistakeHtml,
  parseWrongQuestions,
  parseWorkSkeleton,
  parseWorkDetail
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
   * 从作业详情页补全「截止时间」与「题目数量」。
   *
   * 只处理需要补的：待完成 + 没有真实截止时间 + 有详情页 URL +
   * 没被补过（detailFetchedAt 为空）+ 用户没手工改过（dueAtManual）。
   *
   * 限速：最多 2 并发、请求间隔 800~1200ms、单条 10s 超时、一轮最多 40 条。
   * 降级：任何一条失败都不影响其它条，也不抛给调用方；
   *       抓取失败不写 detailFetchedAt（下次还会重试）。
   *
   * @param {Array<object>} tasks store 里的任务（只读，不改）
   * @param {{limit?:number, onProgress?:Function, now?:Date, fetchImpl?:Function}} [options]
   * @returns {Promise<{stats:object, results:Array<{id:string,patch:object,parsed:object}>}>}
   */
  async enrichTaskDetails(tasks, options = {}) {
    const {
      limit = 40,
      concurrency = 2,
      gapMs = 900,
      timeoutMs = 10000,
      onProgress = null,
      now = new Date()
    } = options;

    const targets = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => t
        && t.status === 'pending'
        && (t.noDeadline || !t.dueAt)
        && !t.dueAtManual
        && !t.detailFetchedAt
        && typeof t.sourceUrl === 'string'
        && /^https?:\/\//i.test(t.sourceUrl))
      .slice(0, limit);

    const stats = {
      checked: targets.length,
      requests: 0,
      dueFilled: 0,
      countFilled: 0,
      parseMiss: 0,
      noDeadline: 0,
      failed: 0
    };
    if (!targets.length) return { stats, results: [] };

    const started = Date.now();
    const results = [];
    let cursor = 0;
    let doneCount = 0;
    let lastStart = 0;

    // 800~1200ms 抖动，避免固定节奏
    const nextGap = () => gapMs + Math.floor(Math.random() * 300);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // 抢占“起跑窗口”：两个 worker 必须排队，否则会同时发出请求，
    // 间隔限速就失效了。
    let gate = Promise.resolve();
    const reserveSlot = () => {
      const run = async () => {
        const wait = lastStart + nextGap() - Date.now();
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
      };
      const next = gate.then(run, run);
      gate = next.then(() => {}, () => {});
      return next;
    };

    const report = () => {
      if (typeof onProgress === 'function') {
        try { onProgress({ done: doneCount, total: targets.length }); } catch (_) { /* 进度回调不许影响抓取 */ }
      }
    };

    const worker = async () => {
      while (cursor < targets.length) {
        const task = targets[cursor];
        cursor += 1;

        await reserveSlot();
        stats.requests += 1;

        let parsed = null;
        try {
          const res = await this._fetch(task.sourceUrl, { timeout: timeoutMs });
          parsed = parseWorkDetail(res.text, now);
        } catch (error) {
          // 抓取失败：不写 detailFetchedAt，下次同步继续试
          stats.failed += 1;
          this.telemetry.log('detail_fetch_error', {
            ok: false,
            error,
            meta: { taskId: task.id, code: (error && error.code) || 'ERROR' }
          });
          doneCount += 1;
          report();
          continue;
        }

        const patch = { detailFetchedAt: now.toISOString() };
        if (parsed.dueAt) {
          patch.dueAt = parsed.dueAt;
          patch.noDeadline = false;
          stats.dueFilled += 1;
        }
        if (parsed.questionCount) {
          patch.questionCount = parsed.questionCount;
          stats.countFilled += 1;
        }

        if (!parsed.dueAt) {
          if (parsed.hasDeadlineLabel) {
            // 页面上有“截止”字样却解析不出来 → 结构可能变了，记一条
            stats.parseMiss += 1;
            this.telemetry.log('detail_parse_miss', {
              ok: false,
              meta: { taskId: task.id, hasCount: parsed.hasCountLabel }
            });
          } else {
            // 已提交/已批改的作业页本来就没有截止时间：正常情况，不算异常
            stats.noDeadline += 1;
            this.telemetry.log('detail_no_deadline', {
              meta: { taskId: task.id, count: parsed.questionCount }
            });
          }
        }

        results.push({ id: task.id, patch, parsed });
        doneCount += 1;
        report();
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker);
    await Promise.all(workers);

    this.telemetry.log('detail_enrichment', {
      durationMs: Date.now() - started,
      meta: {
        checked: stats.checked,
        requests: stats.requests,
        dueFilled: stats.dueFilled,
        countFilled: stats.countFilled,
        parseMiss: stats.parseMiss,
        noDeadline: stats.noDeadline,
        failed: stats.failed
      }
    });

    return { stats, results };
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
   * 抓已批改作业里的错题。
   *
   * 三步走：
   *   1. 请求任务的 sourceUrl（骨架页），解析出 workAnswerId / 总分 / courseId+classId+workId；
   *   2. 总分满 100 的作业直接跳过 —— 没有错题，省掉详情请求；
   *   3. 拼出批改详情页地址，一次请求拿到整份作业的题干/选项/正确答案/我的答案/解析。
   *
   * 为什么要先看分数：一份作业一次详情请求约 89KB，18 份已批改作业全拉一遍没必要，
   * 满分作业既没有错题也省流量。
   *
   * 降级：任意一份作业失败都不影响其它份；解析不出题目的记一次解析失败，
   * 但不静默 —— 结果里带 parseMiss / skippedFull，前端能告诉用户到底发生了什么。
   *
   * @param {Array<object>} tasks store 里的任务（只读）
   * @param {{limit?:number, concurrency?:number, gapMs?:number, timeoutMs?:number, knownKeys?:Set<string>}} [options]
   * @returns {Promise<{ok:boolean, mistakes:Array<object>, checked:number, found:number, stats:object}>}
   */
  async collectMistakes(tasks, options = {}) {
    const {
      limit = 12,
      concurrency = 2,
      gapMs = 900,
      timeoutMs = 10000,
      knownKeys = null,
      knownWorkIds = null
    } = options;

    const started = Date.now();
    // 已批改的排前面：只有它们有错题可抓。
    // 抓过的作业不再请求：taskrefId 就是 workId，拿它当键；
    // 不然每次点「从学习通归档」都会把排在前面的同一批作业重新拉一遍。
    const workIdOf = (url) => {
      const m = /[?&](?:taskrefId|workId)=(\d+)/.exec(String(url || ''));
      return m ? m[1] : '';
    };
    const targets = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => t && typeof t.sourceUrl === 'string' && /^https?:\/\//i.test(t.sourceUrl))
      .filter((t) => !(knownWorkIds && workIdOf(t.sourceUrl) && knownWorkIds.has(workIdOf(t.sourceUrl))))
      .sort((a, b) => {
        const rank = (t) => (t.status === 'done' ? 0 : (t.completedAt ? 1 : 2));
        return rank(a) - rank(b);
      })
      .slice(0, limit);

    const stats = { checked: targets.length, requests: 0, skippedFull: 0, parseMiss: 0, failed: 0, questions: 0 };
    if (!targets.length) {
      return { ok: true, mistakes: [], checked: 0, found: 0, stats };
    }

    const out = [];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastStart = 0;
    let gate = Promise.resolve();
    // 抢占起跑窗口：不排队的话两个 worker 会同时发请求，间隔限速就失效了
    const reserveSlot = () => {
      const run = async () => {
        const wait = lastStart + gapMs + Math.floor(Math.random() * 300) - Date.now();
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
      };
      const next = gate.then(run, run);
      gate = next.then(() => {}, () => {});
      return next;
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const task = targets[cursor++];
        try {
          // ---- 第 1 步：骨架页 ----
          await reserveSlot();
          stats.requests += 1;
          const skeletonPage = await this._fetch(task.sourceUrl, { timeout: timeoutMs });
          let skeleton = parseWorkSkeleton(skeletonPage.text);

          // 有的入口是外层包装页，要在里面找真正的答题页链接再试一次
          if (!skeleton.ok) {
            const next = /https?:\/\/[^"'\s<]*work\/phone\/doHomeWork\?[^"'\s<]+/.exec(skeletonPage.text);
            if (next) {
              await reserveSlot();
              stats.requests += 1;
              const inner = await this._fetch(next[0].replace(/&amp;/g, '&'), { timeout: timeoutMs });
              skeleton = parseWorkSkeleton(inner.text);
            }
          }

          if (!skeleton.ok) { stats.parseMiss += 1; continue; }
          // ---- 第 2 步：满分作业跳过 ----
          if (skeleton.isFullScore) { stats.skippedFull += 1; continue; }

          // ---- 第 3 步：批改详情 ----
          const detailUrl = 'https://mooc1.chaoxing.com/mooc-ans/work/phone/selectWorkQuestionYiPiYue'
            + '?courseId=' + encodeURIComponent(skeleton.courseId)
            + '&classId=' + encodeURIComponent(skeleton.classId)
            + '&workId=' + encodeURIComponent(skeleton.workId)
            + '&workAnswerId=' + encodeURIComponent(skeleton.workAnswerId)
            + '&status=4&isReport=false&mooc=1&times=0&ut=s';

          await reserveSlot();
          stats.requests += 1;
          const detail = await this._fetch(detailUrl, { timeout: timeoutMs });
          const questions = parseWrongQuestions(detail.text, detailUrl);
          stats.questions += questions.length;
          if (!questions.length) { stats.parseMiss += 1; continue; }

          const wrong = questions.filter((q) => q.isWrong);
          for (const q of wrong) {
            // 题干可能整道都是图片，纯文本会只剩 [图]；给它一个可读的兜底标题
            const stemText = q.stem || ('第 ' + q.questionNo + ' 题（图片题）');
            const sourceKey = 'cx:wrong:' + (skeleton.workId || task.sourceKey || task.id) + ':' + (q.id || q.questionNo);
            if (knownKeys && knownKeys.has(sourceKey)) continue;
            out.push({
              course: task.course || '',
              title: task.title || '',
              questionNo: q.questionNo,
              type: q.type,
              question: stemText,
              stemHtml: q.stemHtml,
              options: q.options,
              myAnswer: q.myAnswer,
              correctAnswer: q.correctAnswer,
              score: q.score,
              fullScore: q.fullScore,
              analysis: q.analysis,
              source: 'chaoxing',
              sourceKey,
              sourceUrl: detailUrl,
              wrongAt: task.completedAt || task.missedAt || new Date().toISOString()
            });
          }
        } catch (_) {
          stats.failed += 1;
        }
      }
    });
    await Promise.all(workers);

    // 隐私：错题含真实作答，telemetry 只记数量，不记题干/答案。
    this.telemetry.log('mistakes_extracted', {
      durationMs: Date.now() - started,
      meta: {
        checked: stats.checked,
        found: out.length,
        requests: stats.requests,
        skippedFull: stats.skippedFull,
        parseMiss: stats.parseMiss,
        failed: stats.failed
      }
    });
    return { ok: true, mistakes: out, checked: stats.checked, found: out.length, stats };
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
