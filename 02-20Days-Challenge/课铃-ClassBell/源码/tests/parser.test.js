'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractDeadline, parseTaskFeed, parseBackClazz, parseWorkListHtml,
  parseExamListHtml, parsePageRows, parseNoticeHtml, parseMistakeHtml
} = require('../server/chaoxing-parser');

const NOW = new Date(2026, 10, 9, 12, 0, 0);

test('extractDeadline understands Chinese absolute dates', () => {
  const d = extractDeadline('截止时间：2026-11-20 23:59', NOW);
  assert.ok(d);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('extractDeadline understands month/day and relative days', () => {
  const d = extractDeadline('11月20日 18:30 前提交', NOW);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 18);
  const tomorrow = extractDeadline('明天 09:00 截止', NOW);
  assert.equal(tomorrow.getDate(), 10);
  assert.equal(tomorrow.getHours(), 9);
});

test('extractDeadline returns null for non-deadline text', () => {
  assert.equal(extractDeadline('发布于 2026-11-08', NOW), null);
});

test('parseTaskFeed maps the native task feed fields', () => {
  const ms = new Date(2026, 10, 20, 23, 59).getTime();
  const tasks = parseTaskFeed({
    result: 1,
    data: [{
      id: '9988', title: '第七章作业', coursename: '高等数学', type: 'work',
      status: 0, taskopentime: ms - 86400000, taskendtime: ms,
      dotaskurl: 'https://mooc1.chaoxing.com/work/phone/task-work?id=1'
    }]
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '第七章作业');
  assert.equal(tasks[0].course, '高等数学');
  assert.equal(tasks[0].type, 'work');
  assert.equal(tasks[0].sourceKey, 'cx:work:9988');
  assert.equal(new Date(tasks[0].dueAt).getDate(), 20);
});

test('parseBackClazz handles the class-centric live shape', () => {
  const courses = parseBackClazz({
    result: 1,
    channelList: [{
      key: 'class-1',
      content: {
        id: 'class-1', name: '软件工程 2024-1', cpi: 'person-1',
        course: { data: [{ id: 'course-1', name: '软件工程', teacherfactor: '王老师' }] }
      }
    }]
  });
  assert.equal(courses.length, 1);
  assert.equal(courses[0].courseId, 'course-1');
  assert.equal(courses[0].classId, 'class-1');
  assert.equal(courses[0].courseName, '软件工程');
});

test('parseWorkListHtml does not treat publish date as a deadline', () => {
  const html = `<dl><dt data="/work/phone/task-work?id=1" status="n">
    <h3>第 7 章作业</h3><p>发布于 2026-11-08</p><b>做作业</b>
  </dt></dl>`;
  const tasks = parseWorkListHtml(html);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '第 7 章作业');
  assert.equal(tasks[0].dueAt, null);
  assert.equal(tasks[0].sourceUrl, 'https://mooc1.chaoxing.com/work/phone/task-work?id=1');
});

test('parseWorkListHtml reads an explicit deadline', () => {
  const html = `<dl><dt data="/work/phone/task-work?id=2" status="n">
    <h3>第 8 章作业</h3><p>截止时间：2026-11-20 23:59</p><b>做作业</b>
  </dt></dl>`;
  const tasks = parseWorkListHtml(html);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].dueAt);
  assert.equal(new Date(tasks[0].dueAt).getDate(), 20);
});

test('parseExamListHtml reads the exam title and cells', () => {
  const html = `<table><tr data="/exam/phone/task-exam?id=3" title="期中考试" status="n">
    <td>期中考试</td><td>100 分</td><td>未开始</td>
  </tr></table>`;
  const tasks = parseExamListHtml(html);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '期中考试');
  assert.equal(tasks[0].type, 'exam');
});

test('parsePageRows extracts a page candidate only with a real title', () => {
  const rows = parsePageRows([
    { title: '第七章 多元函数微分学习题', text: '截止时间：2026-11-20 23:59', href: 'https://mooc1.chaoxing.com/work/1', course: '高等数学' },
    { title: '作业', text: '作业', href: '', course: '' }
  ], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '第七章 多元函数微分学习题');
  assert.ok(rows[0].dueAt);
});


/* ---------------------------------------------- notices / gear / mistakes */

test('parseNoticeHtml keeps notice links and their own timestamps', () => {
  const html = [
    '<ul><li><a href="/notice/1">关于期中考试安排的通知</a><span>2026-11-08 10:00</span></li>',
    '<li><a href="/notice/2">第三次作业提交提醒</a><span>2026-11-09 08:30</span></li>',
    '<li><a href="/login">登录</a></li></ul>'
  ].join('');
  const list = parseNoticeHtml(html, 'https://mooc1.chaoxing.com');
  assert.equal(list.length, 2);
  assert.match(list[0].sourceUrl, /notice\/1/);
  assert.notEqual(list[0].publishedAt, list[1].publishedAt);
});

test('parseMistakeHtml prefers the question stem over option lines', () => {
  const html = [
    '<div><p>1. 下列哪个是质数</p>',
    '<p>A. 4 B. 6 C. 7 D. 9</p>',
    '<p>我的答案：A</p>',
    '<p>正确答案：C</p>',
    '<p>答案解析：7 只有 1 和自身两个因数</p></div>'
  ].join('');
  const list = parseMistakeHtml(html);
  assert.equal(list.length, 1);
  assert.match(list[0].question, /哪个是质数/);
  assert.equal(list[0].myAnswer, 'A');
  assert.equal(list[0].correctAnswer, 'C');
});

test('a correct answer without a wrong marker is not archived', () => {
  const html = '<p>2. 填空题</p><p>我的答案：正确内容</p><p>正确答案：正确内容</p>';
  assert.equal(parseMistakeHtml(html).length, 0);
});
