'use strict';

const crypto = require('crypto');

function decodeEntities(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

function stripTags(input) {
  return decodeEntities(String(input || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag || '');
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null;
}

function innerTag(html, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html || '');
  return m ? stripTags(m[1]) : '';
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function makeLocalDate(year, month, day, hour, minute) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour || 0);
  const mi = Number(minute || 0);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * Extract a deadline from Chinese free text.
 * Supports: 2026-11-20 23:59, 2026/11/20, 11月20日 23:59, 今天/明天/后天, ISO.
 * Assumes the current year when the year is omitted; a date more than 180 days
 * in the past rolls to next year (covers December -> January hand-offs).
 */
function extractDeadline(input, now = new Date()) {
  if (!input) return null;
  const text = String(input)
    .replace(/(发布于|发布时间|创建时间|更新时间|开课时间)\s*[:：]?\s*20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?/g, ' ')
    .replace(/[（(]/g, ' ')
    .replace(/[）)]/g, ' ')
    .replace(/：/g, ':')
    .replace(/\s+/g, ' ');

  // Full ISO / datetime with explicit year.
  let m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(text);
  if (m) {
    return makeLocalDate(m[1], m[2], m[3], m[4] || 23, m[5] || 59);
  }

  // Month/day with optional time.
  m = /(?:^|[^\d])(\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/.exec(text);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let date = makeLocalDate(now.getFullYear(), month, day, m[3] || 23, m[4] || 59);
      if (date && date.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) {
        date = makeLocalDate(now.getFullYear() + 1, month, day, m[3] || 23, m[4] || 59);
      }
      return date;
    }
  }

  // Relative days.
  const rel = /(今天|明天|后天|今日|明日)(?:\s*(\d{1,2}):(\d{2}))?/.exec(text);
  if (rel) {
    const offset = rel[1].includes('后') ? 2 : (rel[1].includes('明') ? 1 : 0);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset,
      rel[2] === undefined ? 23 : Number(rel[2]), rel[3] === undefined ? 59 : Number(rel[3]), 0, 0);
    return d;
  }

  return null;
}

function parseTimeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  const asDate = new Date(text.replace(/\//g, '-'));
  if (!Number.isNaN(asDate.getTime()) && /\d{4}/.test(text)) return asDate;
  return extractDeadline(text);
}

function normalizeType(value) {
  const t = String(value || '').toLowerCase();
  if (t.includes('exam') || t.includes('考试') || t === '2') return 'exam';
  return 'work';
}

function isClosedStatus(value) {
  const text = String(value || '');
  return /不可提交|不能提交|已关闭|已结束|已过期|逾期不可|不可补交|不能补交|无法补交/.test(text)
    && !isCompletedStatus(text);
}

function isCompletedStatus(value) {
  if (typeof value === 'number') return value > 0;
  const text = String(value || '');
  if (/^[1-9]\d*$/.test(text)) return true;
  // "已过期/已结束" means the deadline has passed, not that the student
  // submitted it. Keep those rows so overdue-but-unfinished work is recorded.
  return /已完成|已提交|已批阅|已交|已通过/.test(text);
}

function parseTaskFeed(body) {
  const root = typeof body === 'string' ? JSON.parse(body) : body;
  if (!root || Number(root.result) !== 1 || !Array.isArray(root.data)) return [];
  const out = [];
  for (const raw of root.data) {
    if (!raw || typeof raw !== 'object') continue;
    const title = stripTags(raw.title || raw.workname || raw.name || '');
    if (!title) continue;
    const type = normalizeType(raw.type);
    const end = parseTimeValue(raw.taskendtime ?? raw.endtime ?? raw.endTime);
    const open = parseTimeValue(raw.taskopentime ?? raw.opentime);
    const status = Number.isFinite(Number(raw.status)) ? Number(raw.status) : 0;
    const id = String(raw.id || raw.taskrefid || '').trim();
    const unique = id || hashKey(`${type}|${title}|${end ? end.toISOString() : ''}`);
    out.push({
      id: unique,
      sourceKey: `cx:${type}:${unique}`,
      title,
      course: stripTags(raw.coursename || raw.courseName || ''),
      type,
      dueAt: end ? end.toISOString() : null,
      openAt: open ? open.toISOString() : null,
      remoteStatus: status,
      sourceUrl: String(raw.dotaskurl || raw.doTaskUrl || '').trim(),
      unfinished: status === 0
    });
  }
  return dedupe(out);
}

/**
 * 从作业详情页（mooc1.chaoxing.com/work/phone/task-work）解析：
 *   - 截止时间：未提交的作业会渲染 .tmTimeNew 区块
 *       <span aria-label="截止时间11月20日23时59分00秒">
 *       <h4 aria-hidden="true">截止时间：11-20 23:59</h4>
 *     已提交/已批改的作业只显示成绩卡，页面上没有“截止”字样。
 *   - 题目数量：
 *       未提交页：共包含30道题目，其中单选题14道，判断题16道。
 *       成绩页：  共18题，客观题18道，主观题0道
 *
 * 时间按本机时区构造（学习通下发的是北京时间），返回值统一 ISO。
 * @param {string} html 详情页 HTML
 * @param {Date} [now] 用于补年份/处理跨年
 */
function parseWorkDetail(html, now = new Date()) {
  const raw = String(html || '');
  const result = {
    dueAt: null,
    questionCount: null,
    hasDeadlineLabel: /截止/.test(raw),
    hasCountLabel: /共包含\s*\d+\s*道题目|共\s*\d+\s*题/.test(raw),
    matchedDeadline: '',
    matchedCount: ''
  };

  const buildDate = (month, day, hour, minute) => {
    const m = Number(month);
    const d = Number(day);
    const h = Number(hour);
    const mi = Number(minute);
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || !(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) {
      return null;
    }
    let year = now.getFullYear();
    const candidate = new Date(year, m - 1, d, h, mi, 0, 0);
    // 跨年：例如现在是 12 月，作业截止 1 月 → 属于下一年
    if (candidate.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) {
      year += 1;
    }
    return new Date(year, m - 1, d, h, mi, 0, 0);
  };

  // 1) 完整日期（带年月日时分）
  const full = /aria-label="截止时间(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/.exec(raw);
  if (full) {
    const date = buildDate(full[1], full[2], full[3], full[4]);
    if (date) {
      result.dueAt = date.toISOString();
      result.matchedDeadline = full[0];
    }
  }

  // 2) 退化：截止时间：11-20 23:59
  if (!result.dueAt) {
    const short = /截止时间[：:]\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(raw);
    if (short) {
      const date = buildDate(short[1], short[2], short[3], short[4]);
      if (date) {
        result.dueAt = date.toISOString();
        result.matchedDeadline = short[0];
      }
    }
  }

  // 3) 题量：优先“共包含N道题目”，其次“共N题”
  const countFull = /共包含\s*(\d{1,4})\s*道题目/.exec(raw);
  const countShort = /共\s*(\d{1,4})\s*题[，,、\s]/.exec(raw);
  const countMatch = countFull || countShort;
  if (countMatch) {
    const n = Number(countMatch[1]);
    if (Number.isFinite(n) && n > 0 && n <= 9999) {
      result.questionCount = n;
      result.matchedCount = countMatch[0];
    }
  }

  return result;
}

function parseBackClazz(body) {
  const root = typeof body === 'string' ? JSON.parse(body) : body;
  if (!root || Number(root.result) !== 1 || !Array.isArray(root.channelList)) return [];
  const courses = [];
  for (const channel of root.channelList) {
    if (!channel || typeof channel !== 'object') continue;
    let content = channel.content;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch (_) { continue; }
    }
    if (!content || typeof content !== 'object') continue;
    const courseData = content.course && content.course.data;
    if (Array.isArray(courseData) && courseData.length) {
      const classId = String(content.id || channel.key || '');
      for (const course of courseData) {
        if (!course || !course.id || !classId) continue;
        courses.push({
          courseId: String(course.id),
          classId,
          courseName: stripTags(course.name || ''),
          className: stripTags(content.name || ''),
          teacher: stripTags(course.teacherfactor || ''),
          imageUrl: String(course.imageurl || ''),
          cpi: String(content.cpi || channel.cpi || ''),
          personId: String(course.personid || content.cpi || channel.cpi || '')
        });
      }
      continue;
    }
    if (Array.isArray(content.clazz)) {
      const courseId = String(content.id || '');
      for (const clazz of content.clazz) {
        if (!clazz || !clazz.id || !courseId) continue;
        courses.push({
          courseId,
          classId: String(clazz.id),
          courseName: stripTags(content.name || ''),
          className: stripTags(clazz.name || ''),
          teacher: stripTags(content.teacherfactor || ''),
          imageUrl: String(content.imageurl || ''),
          cpi: String(clazz.cpi || content.cpi || ''),
          personId: String(content.personid || content.cpi || '')
        });
      }
    }
  }
  const seen = new Set();
  return courses.filter((c) => {
    const key = `${c.courseId}:${c.classId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteUrl(base, url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!base) return value;
  return `${base.replace(/\/$/, '')}${value.startsWith('/') ? '' : '/'}${value}`;
}

function parseWorkListHtml(html, base = 'https://mooc1.chaoxing.com') {
  const out = [];
  const re = /<dt\b[^>]*>([\s\S]*?)<\/dt>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const inner = m[1];
    const data = attr(tag, 'data');
    if (!data) continue;
    const title = innerTag(inner, 'h3');
    if (!title) continue;
    const detail = innerTag(inner, 'p');
    const statusText = innerTag(inner, 'b');
    // 平台在 <dt> 上给了状态：1=未做 2=已过期（未提交） 4=已批改/已提交。
    // 已批改行只显示分数、没有 <b> 文案，仅按文案判断会误判成“未提交”。
    const statusAttr = String(attr(tag, 'status') || '').trim();
    const due = /截止|结束|提交截止|有效期/.test(`${detail} ${statusText}`)
      ? extractDeadline(`${detail} ${statusText}`)
      : null;
    out.push({
      id: hashKey(`${data}|${title}`),
      sourceKey: `cx:work:${hashKey(`${data}|${title}`)}`,
      title,
      course: '',
      type: 'work',
      dueAt: due ? due.toISOString() : null,
      remoteStatus: statusAttr
        ? (statusAttr === '4' ? 1 : 0)
        : (isCompletedStatus(statusText) ? 1 : 0),
      closed: statusAttr
        ? statusAttr === '2'
        : isClosedStatus(statusText),
      sourceUrl: absoluteUrl(base, data),
      statusText,
      detail,
      statusAttr
    });
  }
  return dedupe(out);
}

function parseExamListHtml(html, base = 'https://mooc1.chaoxing.com') {
  const out = [];
  const re = /<tr\b[^>]*\bdata\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const data = decodeEntities(m[1] ?? m[2] ?? '');
    if (!data) continue;
    const inner = m[3];
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(inner))) cells.push(stripTags(cm[1]));
    let title = attr(tag, 'title') || cells[0] || '';
    title = String(title).trim();
    if (!title) continue;
    const statusText = cells.length > 2 ? cells[2] : '';
    const due = extractDeadline(`${cells.join(' ')} ${statusText}`);
    out.push({
      id: hashKey(`${data}|${title}`),
      sourceKey: `cx:exam:${hashKey(`${data}|${title}`)}`,
      title,
      course: '',
      type: 'exam',
      dueAt: due ? due.toISOString() : null,
      remoteStatus: isCompletedStatus(statusText) ? 1 : 0,
      closed: isClosedStatus(statusText),
      sourceUrl: absoluteUrl(base, data),
      statusText,
      detail: cells.length > 1 ? cells[1] : ''
    });
  }
  return dedupe(out);
}

function genericTitle(value) {
  const t = stripTags(value || '');
  if (!t) return '';
  if (/^(作业|考试|任务|待办|待办事项|更多|查看全部|去完成|立即查看|学习通)$/.test(t)) return '';
  return t.slice(0, 160);
}

/**
 * Normalize raw rows produced by the in-page DOM scanner.
 * Each row: { title, href, text, course, dueText }
 */
function parsePageRows(rows, now = new Date()) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const title = genericTitle(row.title || row.text);
    if (!title || title.length < 3) continue;
    const due = extractDeadline(`${row.dueText || ''} ${row.text || ''}`, now);
    const href = String(row.href || '');
    const type = /exam|考试/.test(`${row.text || ''} ${href}`) ? 'exam' : 'work';
    const sourceUrl = /^https?:\/\//i.test(href) ? href : '';
    const unique = hashKey(`${title}|${sourceUrl}|${due ? due.toISOString() : ''}`);
    out.push({
      id: unique,
      sourceKey: `page:${type}:${unique}`,
      title,
      course: stripTags(row.course || '').slice(0, 60),
      type,
      dueAt: due ? due.toISOString() : null,
      remoteStatus: 0,
      closed: false,
      sourceUrl,
      statusText: '',
      detail: stripTags(row.text || '').slice(0, 180),
      fromPage: true
    });
  }
  return dedupe(out);
}

function dedupe(tasks) {
  const map = new Map();
  for (const task of tasks) {
    if (!task || !task.title) continue;
    const prev = map.get(task.sourceKey);
    if (!prev) {
      map.set(task.sourceKey, task);
      continue;
    }
    if (!prev.dueAt && task.dueAt) map.set(task.sourceKey, task);
    else if (task.dueAt && prev.dueAt && task.dueAt === prev.dueAt) {
      map.set(task.sourceKey, { ...prev, ...task });
    }
  }
  return [...map.values()];
}

function candidateReason(task) {
  if (!task.dueAt) return '未识别到截止时间';
  return '已识别';
}

/* ------------------------------------------------------ notices / mistakes */

function htmlToLines(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const NOTICE_SKIP = /登录|注册|忘记密码|下载客户端|版权所有|技术支持|客服|隐私政策|用户协议/;

function parseNoticeFeed(payload) {
  const arrays = [];
  const visit = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length && value.some((v) => v && typeof v === 'object' && (v.title || v.noticeTitle || v.subject))) {
        arrays.push(value);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) visit(value[key], depth + 1);
    }
  };
  visit(payload, 0);
  const best = arrays.sort((a, b) => b.length - a.length)[0] || [];
  const out = [];
  for (const item of best.slice(0, 120)) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title || item.noticeTitle || item.subject || item.name || '').trim();
    if (!title || title.length < 3 || NOTICE_SKIP.test(title)) continue;
    const body = String(item.content || item.body || item.summary || item.desc || '').trim();
    const timeRaw = item.createTime || item.publishTime || item.sendTime || item.time || item.pubTime || '';
    const parsed = parseTimeValue(timeRaw);
    out.push({
      title: title.slice(0, 180),
      body: body.slice(0, 500),
      kind: /考试|测验/.test(title) ? 'exam' : (/作业|任务|提交/.test(title) ? 'assignment' : 'notice'),
      publishedAt: parsed ? parsed.toISOString() : null,
      sourceUrl: String(item.url || item.link || item.noticeUrl || '').trim(),
      sourceKey: `cx:notice:${hashKey(`${title}|${timeRaw}`)}`
    });
  }
  return dedupeNotices(out);
}

function parseNoticeHtml(html, base) {
  const raw = String(html || '');
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{2,240}?)<\/a>/gi;
  let match;
  while ((match = re.exec(raw))) {
    const href = match[1];
    if (!/notice|message|inform|tzgg|gonggao/i.test(href)) continue;
    const title = stripTags(match[2]);
    if (!title || title.length < 4 || title.length > 120 || NOTICE_SKIP.test(title)) continue;
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(title)) continue;
    const around = raw.slice(match.index, match.index + match[0].length + 200);
    const timeHit = /(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|\d{1,2}-\d{1,2}\s+\d{2}:\d{2})/.exec(stripTags(around));
    const parsed = timeHit ? parseTimeValue(timeHit[1]) : null;
    out.push({
      title: title.slice(0, 180),
      body: '',
      kind: /考试|测验/.test(title) ? 'exam' : (/作业|提交/.test(title) ? 'assignment' : 'notice'),
      publishedAt: parsed ? parsed.toISOString() : null,
      sourceUrl: absoluteUrl(base, href),
      sourceKey: `cx:notice:${hashKey(`${title}|${href}`)}`
    });
  }
  return dedupeNotices(out);
}

function dedupeNotices(list) {
  const map = new Map();
  for (const item of list) {
    if (!item || !item.title) continue;
    if (!map.has(item.sourceKey)) map.set(item.sourceKey, item);
  }
  return [...map.values()];
}

function parseMistakeHtml(html, base) {
  return parseMistakeLines(htmlToLines(html), base);
}

function parseMistakeText(text, base) {
  // Text copied from the review page often arrives as one long line. Break it
  // on question numbers and answer labels before line-based parsing.
  const expanded = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/(?:^|\s)(\d{1,3}\s*[.、．)）]\s*[\(（]?\s*[单多判填]?)/g, '\n$1')
    .replace(/(我的答案|我的作答|学生答案|正确答案|答案解析|试题解析|得分)\s*[:：]?/g, '\n$1：');
  const lines = expanded
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return parseMistakeLines(lines, base);
}

function parseMistakeLines(lines, base) {
  const out = [];
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/我的答案|我的作答|学生答案/.test(line)) continue;

    // The desktop review page prints labels inline:
    //   我的答案:A 正确答案:A 答案解析:...
    const myMatch = /(?:我的答案|我的作答|学生答案)\s*[:：]?\s*(.*?)(?=正确答案|答案解析|试题解析|得分|$)/.exec(line);
    let myAnswer = clean(myMatch ? myMatch[1] : '');
    if (!myAnswer) {
      const fallback = /(?:我的答案|我的作答|学生答案)\s*[:：]?\s*(.*)$/.exec(line);
      myAnswer = clean(fallback ? fallback[1] : '');
    }

    let correctAnswer = '';
    const correctInline = /正确答案\s*[:：]?\s*(.*?)(?=答案解析|试题解析|得分|$)/.exec(line);
    if (correctInline) correctAnswer = clean(correctInline[1]);
    let analysis = '';
    const analysisInline = /(?:答案解析|试题解析|解析)\s*[:：]?\s*(.*)$/.exec(line);
    if (analysisInline) analysis = clean(analysisInline[1]);

    // Question stem: prefer the nearest numbered line and include the lines
    // that follow it up to the options (formulas often sit on their own line).
    let question = '';
    let numbered = -1;
    for (let j = i - 1; j >= Math.max(0, i - 12); j -= 1) {
      const prev = lines[j];
      if (!prev) continue;
      if (/正确答案|答案解析|试题解析|我的答案|得分|批阅|教师点评/.test(prev)) continue;
      if (/^\d+[.、．)）]/.test(prev)) { numbered = j; break; }
    }
    if (numbered >= 0) {
      const parts = [lines[numbered]];
      for (let j = numbered + 1; j < i && parts.length < 3; j += 1) {
        const next = lines[j];
        if (!next) continue;
        if (/^[A-Fa-f][.、．)）]/.test(next)) break;
        if (/我的答案|正确答案|答案解析|得分/.test(next)) break;
        parts.push(next);
      }
      question = parts.join(' ');
    } else {
      let score = -1;
      for (let j = i - 1; j >= Math.max(0, i - 10); j -= 1) {
        const prev = lines[j];
        if (!prev) continue;
        if (/正确答案|答案解析|我的答案|得分|批阅|教师点评|试题解析/.test(prev)) continue;
        if (prev.length < 4) continue;
        if (/^[A-Fa-f][.、．)）]/.test(prev)) continue;
        let current = 1 + Math.min(2, Math.floor(prev.length / 24));
        if (/[？?]$/.test(prev)) current += 2;
        if (current > score) {
          score = current;
          question = prev;
        }
        if (current >= 3) break;
      }
    }
    if (!question) continue;

    // Answers and explanations can span several lines on the review page.
    let analysisOpen = Boolean(analysisInline);
    for (let j = i + 1; j < Math.min(lines.length, i + 20); j += 1) {
      const next = lines[j];
      if (/我的答案/.test(next) || /^\d+[.、．)）]\s*[\(（]?[单多判填]/.test(next)) break;
      if (!correctAnswer) {
        const hit = /正确答案\s*[:：]?\s*(.*?)(?=答案解析|试题解析|得分|$)/.exec(next);
        if (hit) correctAnswer = clean(hit[1]);
      }
      const analysisHit = /(?:答案解析|试题解析|解析)\s*[:：]?\s*(.*)$/.exec(next);
      if (analysisHit) {
        analysis = clean([analysis, analysisHit[1]].filter(Boolean).join(' '));
        analysisOpen = true;
      } else if (analysisOpen && !/得分|批阅|教师点评/.test(next)) {
        analysis = clean([analysis, next].filter(Boolean).join(' ')).slice(0, 900);
      } else if (/得分|批阅|教师点评/.test(next)) {
        analysisOpen = false;
      }
      if (correctAnswer && analysis && !analysisOpen) break;
    }

    const noAnswer = !myAnswer || /未作答|未答|^[（(]\s*[)）]$/.test(myAnswer);
    const context = lines.slice(Math.max(0, i - 3), i + 3).join(' ');
    if (!correctAnswer && !noAnswer && !/错误|不正确|答错/.test(context)) continue;
    if (!correctAnswer && !noAnswer) continue;
    const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
    if (myAnswer && correctAnswer && normalize(myAnswer) === normalize(correctAnswer)) continue;
    out.push({
      question: question.slice(0, 600),
      myAnswer,
      correctAnswer,
      analysis,
      sourceUrl: absoluteUrl(base || 'https://mooc1.chaoxing.com', '')
    });
  }
  return out;
}

/* ---------------------------------------------------- wrong questions (批改详情页) */

/**
 * 学习通批改详情页里，每题外面那层容器的 class。改版时这里会变。
 * 留成常量是为了以后改一处就够。
 */
const QUESTION_BLOCK_CLASS = 'singleQuesId';

/** 学习通给"答错"的题打的 class（在顶部答题卡导航条上）。 */
const WRONG_MARK_CLASS = 'wrongRed';

/** 题型：优先用题干里写的中文标签，qType 只作兜底（实测 0=单选、3=判断）。 */
const QTYPE_LABELS = {
  0: '单选题',
  1: '多选题',
  2: '填空题',
  3: '判断题',
  4: '简答题',
  5: '论述题',
  6: '计算题',
  7: '名词解释',
  8: '其他'
};

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把相对地址补成绝对地址。学习通的图片是 //host/path 这种协议相对写法，
 * 不补的话 WebView2 里会当成 file:// 加载不出来。
 */
function absoluteAssetUrl(base, href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  if (/^data:/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  try {
    return new URL(raw, base || 'https://mooc1.chaoxing.com').toString();
  } catch (_) {
    return '';
  }
}

/**
 * 删掉给读屏器用的隐藏 span。
 *
 * 为什么必须先删：学习通在「正确答案」span 后面插了一段
 * span.element-invisible-hidden 写着 "D; "，
 * 不删的话正确答案会被读成 "C D"，错题本里就会显示错的答案。
 */
function stripInvisibleSpans(html) {
  return String(html || '').replace(/<span[^>]*class="[^"]*element-invisible-hidden[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
}

/**
 * 从 startIndex 处的标签开始，按标签配对找到它的闭合位置。
 *
 * 为什么不用非贪婪正则：题干里有嵌套 div/p（公式和图片各占一层），
 * 非贪婪的 <div[^>]*>([\s\S]*?)<\/div> 会提前截断，把后半句题干吃掉。
 *
 * @returns {number} 闭合标签结束后的下标；找不到返回 -1
 */
function endOfElement(html, startIndex, tag) {
  const openRe = new RegExp('<' + tag + '\\b', 'gi');
  const closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
  let depth = 0;
  let i = startIndex;
  while (i < html.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return -1;
    if (open && open.index < close.index) {
      depth += 1;
      i = open.index + open[0].length;
    } else {
      depth -= 1;
      i = close.index + close[0].length;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从 html 里找出所有 class 含 name 的元素起始位置。
 * 只返回起点，具体到哪儿结束由调用方决定（题目块是"到下一块为止"）。
 */
function findElementsByClass(html, name) {
  const re = new RegExp('<([a-z]+)[^>]*class="[^"]*\\b' + name + '\\b[^"]*"[^>]*>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ at: m.index, tagName: m[1].toLowerCase(), raw: m[0] });
  return out;
}

/**
 * 把一小段 HTML 变成"安全的内联内容"：
 *   - 只保留图片（地址补成绝对），其余标签全部去掉；
 *   - 文本部分先解码实体再转义，避免把原来的尖括号带进页面；
 *   - 图片位置在纯文本里写成 [图]，方便复制和搜索。
 *
 * 为什么存 HTML 而不只是纯文本：题干和选项里有大量公式图
 * （第 10 题整道题的题干就是一张图），只存文字会变成空白。
 */
function inlineContent(fragment, base) {
  const source = String(fragment || '');
  const images = [];
  let text = '';
  let html = '';

  const imgRe = /<img\b[^>]*>/gi;
  let last = 0;
  let m;
  const pushText = (chunk) => {
    const plain = stripTags(chunk);
    if (!plain) return;
    text += plain;
    html += escapeHtml(plain);
  };
  while ((m = imgRe.exec(source))) {
    pushText(source.slice(last, m.index));
    const src = absoluteAssetUrl(base, attr(m[0], 'src'));
    if (src) {
      images.push(src);
      text += '[图]';
      html += '<img class="cx-inline-img" src="' + escapeHtml(src) + '" alt="题目图片" loading="lazy" />';
    }
    last = m.index + m[0].length;
  }
  pushText(source.slice(last));

  return { text: text.replace(/\s+/g, ' ').trim(), html: html.trim(), images };
}

/**
 * 顶部答题卡导航条：每题一个 div，id 就是题目 id，答错的带 wrongRed。
 *
 * 这是最可靠的判错信号 —— 学习通自己判好的，不依赖"得 0 分"这类文字，
 * 主观题给部分分时也不会误判。
 *
 * @returns {Map<string, boolean>} 题目 id -> 是否答错
 */
function collectWrongVerdicts(html) {
  const map = new Map();
  const re = /<div\s+id="(\d+)"\s+class="([^"]*)"[^>]*>([\s\S]{0,400}?)<\/div>/gi;
  const wrongRe = new RegExp('\\b' + WRONG_MARK_CLASS + '\\b');
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const cls = m[2] || '';
    const inner = m[3] || '';
    if (!/\ballQuestion\b/.test(inner) && !/swiper-slide/.test(cls)) continue;
    if (wrongRe.test(cls) || wrongRe.test(inner)) map.set(id, true);
    else if (/\bactiveGreen\b/.test(cls) || /\bactiveGreen\b/.test(inner)) map.set(id, false);
  }
  return map;
}

/**
 * 把整页切成一道一道的题。
 *
 * 每道题的容器是 div.ans-cc.fontLabel.singleQuesId，一直延伸到下一个同类容器为止
 * （页面结构就是这样平铺的，没有更明确的边界）。
 */
function splitQuestionBlocks(html) {
  const starts = findElementsByClass(html, QUESTION_BLOCK_CLASS);
  const out = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : html.length;
    out.push({ tag: starts[i].raw, body: html.slice(from, to) });
  }
  return out;
}

/** 从 "(单选题，7.6  分)" 里取出题型和该题满分。 */
function parseStemMeta(grayText) {
  const text = stripTags(grayText);
  const label = /(单选题|多选题|判断题|填空题|简答题|论述题|计算题|名词解释|其他)/.exec(text);
  const full = /([\d]+(?:\.[\d]+)?)\s*分/.exec(text);
  return {
    type: label ? label[1] : '',
    fullScore: full ? Number(full[1]) : null
  };
}

/** 取某个 class 元素内部的原始 HTML（用于题干/选项/解析），取不到返回空串。 */
function firstElementInner(html, name) {
  const found = findElementsByClass(html, name)[0];
  if (!found) return '';
  const end = endOfElement(html, found.at, found.tagName);
  if (end < 0) return '';
  const openEnd = html.indexOf('>', found.at);
  if (openEnd < 0) return '';
  return html.slice(openEnd + 1, end - (found.tagName.length + 3));
}

/**
 * 解析批改详情页里的全部题目。
 *
 * 返回每道题的结构化结果，isWrong 表示这道题是否答错。
 * 拿不到「正确答案」也要照常返回（主观题可能只给分数）—— 不能因为缺一个字段就丢题。
 *
 * @param {string} html 批改详情页 HTML
 * @param {string} [base] 用来补全相对地址的基准 URL
 * @returns {Array<object>}
 */
function parseWrongQuestions(html, base) {
  const source = stripInvisibleSpans(html);
  const verdicts = collectWrongVerdicts(source);
  const blocks = splitQuestionBlocks(source);
  const out = [];

  blocks.forEach((block, blockIndex) => {
    const tag = block.tag || '';
    const body = block.body || '';
    const idMatch = /\bdata="(\d+)"/.exec(tag);
    const id = idMatch ? idMatch[1] : '';
    const qTypeMatch = /\bqType="(\d+)"/.exec(tag);
    const qType = qTypeMatch ? qTypeMatch[1] : '';

    // 题号：stemDiv 开头就是 "10."
    const stemDiv = firstElementInner(body, 'stemDiv');
    const noMatch = /^(\d+)\s*\./.exec(stripTags(stemDiv));
    const questionNo = noMatch ? Number(noMatch[1]) : (blockIndex + 1);

    const grayMatch = /<span[^>]*class="[^"]*stemGray[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body);
    const meta = parseStemMeta(grayMatch ? grayMatch[1] : '');

    const stemRaw = firstElementInner(body, 'qtContent') || stemDiv;
    const stem = inlineContent(stemRaw, base);

    // 选项：每个 div.optionCon 装一个选项，内容在 div.ptag 或 p.qtDetail 里
    const options = [];
    const optionDivInner = firstElementInner(body, 'optionDiv');
    if (optionDivInner) {
      const starts = findElementsByClass(optionDivInner, 'optionCon');
      starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].at : optionDivInner.length;
        const chunk = optionDivInner.slice(start.at, end);
        const inner = firstElementInner(chunk, 'qtDetail') || firstElementInner(chunk, 'ptag') || chunk;
        const content = inlineContent(inner, base);
        const keyMatch = /^([A-Za-z])\s*[.、．]/.exec(content.text);
        options.push({
          key: keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + i),
          text: content.text,
          html: content.html,
          images: content.images
        });
      });
    }

    const correctMatch = /<span[^>]*class="[^"]*rightAnswerContent[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body);
    const correctAnswer = correctMatch ? stripTags(correctMatch[1]) : '';

    const myMatch = /<span[^>]*class="[^"]*\bstuAnswerContent\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body);
    const myAnswer = myMatch ? stripTags(myMatch[1]) : '';

    const scoreMatch = /得\s*<span[^>]*class="[^"]*font40[^"]*"[^>]*>\s*([\d.]+)\s*<\/span>\s*分/.exec(body);
    const score = scoreMatch ? Number(scoreMatch[1]) : null;

    const analysisRaw = firstElementInner(body, 'qtAnalysis');
    const analysis = analysisRaw
      ? inlineContent(analysisRaw.replace(/^[\s\S]*?答案解析[:：]/, ''), base)
      : { text: '', html: '', images: [] };

    // 判错：三个信号取或。任何一个成立就算错 —— 宁可多记一道，
    // 也别因为改版少了一种标记就把真错题漏掉。
    const navVerdict = verdicts.has(id) ? verdicts.get(id) : null;
    const markedWrongByIcon = /wrong_v1\.png/i.test(body);
    const lostPoints = Number.isFinite(score) && Number.isFinite(meta.fullScore) && score < meta.fullScore - 0.001;
    const answersDiffer = Boolean(correctAnswer && myAnswer && correctAnswer !== myAnswer);
    const isWrong = navVerdict === true || markedWrongByIcon || lostPoints || answersDiffer;

    out.push({
      id,
      questionNo,
      type: meta.type || QTYPE_LABELS[qType] || '',
      qType,
      stem: stem.text,
      stemHtml: stem.html,
      stemImages: stem.images,
      options,
      correctAnswer,
      myAnswer,
      score: Number.isFinite(score) ? score : null,
      fullScore: Number.isFinite(meta.fullScore) ? meta.fullScore : null,
      analysis: analysis.text,
      analysisHtml: analysis.html,
      isWrong
    });
  });

  return out;
}

/**
 * 解析"骨架页"：拿到 workAnswerId、总分，以及拼批改详情页要用的参数。
 *
 * 这一层只负责取数，不发请求。拿不到 workAnswerId 时返回 ok:false，
 * 由调用方决定降级（比如改用页面里的 doHomeWork 链接再试一次）。
 */
function parseWorkSkeleton(html) {
  const text = String(html || '');
  const scoreMatch = /<p[^>]*class="[^"]*Number[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(text);
  const scoreDigits = scoreMatch ? /([\d]+(?:\.[\d]+)?)/.exec(stripTags(scoreMatch[1])) : null;
  const score = scoreDigits ? Number(scoreDigits[1]) : null;

  const answerIdMatch = /workAnswerId=(\d+)/.exec(text);
  const workAnswerId = answerIdMatch ? answerIdMatch[1] : '';

  // look() 里那条 URL 把参数都写全了，直接从它身上取，比自己拼更不容易错
  const lookMatch = /work\/phone\/selectWorkQuestionYiPiYue\?([^'"\s<]+)/.exec(text);
  const query = lookMatch ? lookMatch[1].replace(/&amp;/g, '&') : '';
  const params = new URLSearchParams(query);
  const pick = (name) => params.get(name) || '';
  const hidden = (name) => {
    const m = new RegExp('id="' + name + '"[^>]*value="([^"]*)"').exec(text);
    return m ? m[1] : '';
  };

  const countsMatch = /共\s*(\d+)\s*题[，,]?\s*客观题\s*(\d+)\s*道[，,]?\s*主观题\s*(\d+)\s*道/.exec(stripTags(text));

  return {
    ok: Boolean(workAnswerId),
    workAnswerId,
    score: Number.isFinite(score) ? score : null,
    courseId: pick('courseId') || hidden('courseId'),
    classId: pick('classId') || hidden('classId'),
    workId: pick('workId') || hidden('workId'),
    total: countsMatch ? Number(countsMatch[1]) : null,
    objective: countsMatch ? Number(countsMatch[2]) : null,
    subjective: countsMatch ? Number(countsMatch[3]) : null,
    // 满分作业没有错题，调用方据此跳过详情请求
    isFullScore: Number.isFinite(score) && score >= 99.999
  };
}

module.exports = {
  extractDeadline,
  parseTimeValue,
  parseTaskFeed,
  parseBackClazz,
  parseWorkListHtml,
  parseExamListHtml,
  parsePageRows,
  parseWorkDetail,
  dedupe,
  stripTags,
  decodeEntities,
  candidateReason,
  hashKey,
  htmlToLines,
  parseNoticeFeed,
  parseNoticeHtml,
  parseMistakeHtml,
  parseMistakeText,
  parseWrongQuestions,
  parseWorkSkeleton,
  stripInvisibleSpans
};
