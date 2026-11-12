'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ---------------- P2-11: compact text + unanswered questions ---------------- */
const parserPath = root + 'server/chaoxing-parser.js';
let parser = fs.readFileSync(parserPath, 'utf8');

const fromText = `function parseMistakeText(text, base) {
  const lines = String(text || '')
    .split(/\\r?\\n/)
    .map((line) => line.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  return parseMistakeLines(lines, base);
}`;

const toText = `function parseMistakeText(text, base) {
  // Text copied from the review page often arrives as one long line. Break it
  // on question numbers and answer labels before line-based parsing.
  const expanded = String(text || '')
    .replace(/\\r/g, '\\n')
    .replace(/(?:^|\\s)(\\d{1,3}\\s*[.、．)）]\\s*[\\(（]?\\s*[单多判填]?)/g, '\\n$1')
    .replace(/(我的答案|我的作答|学生答案|正确答案|答案解析|试题解析|得分)\\s*[:：]?/g, '\\n$1：');
  const lines = expanded
    .split(/\\r?\\n/)
    .map((line) => line.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  return parseMistakeLines(lines, base);
}`;

if (parser.includes(fromText)) { parser = parser.replace(fromText, toText); done.push('compact text expansion'); }
else console.log('MISS: compact text');

const fromGate = `    if (!correctAnswer && !/错误|不正确|答错/.test(lines.slice(Math.max(0, i - 3), i + 3).join(' '))) continue;`;
const toGate = `    const noAnswer = !myAnswer || /未作答|未答|^[（(]\\s*[)）]$/.test(myAnswer);
    const context = lines.slice(Math.max(0, i - 3), i + 3).join(' ');
    if (!correctAnswer && !noAnswer && !/错误|不正确|答错/.test(context)) continue;
    if (!correctAnswer && !noAnswer) continue;`;

if (parser.includes(fromGate)) { parser = parser.replace(fromGate, toGate); done.push('unanswered mistakes'); }
else console.log('MISS: gate');

fs.writeFileSync(parserPath, parser, 'utf8');

/* ---------------- P1-9: testReminder + global rejection guard ---------------- */
const appPath = root + 'src/renderer/app.js';
let app = fs.readFileSync(appPath, 'utf8');

const fromTest = `  $('#btn-test-reminder').addEventListener('click', async () => {
    await api.testReminder();
  });`;

const toTest = `  $('#btn-test-reminder').addEventListener('click', async () => {
    try {
      await api.testReminder();
      toast('测试弹窗已发送，看看屏幕右下角。', 'success');
    } catch (error) {
      toast(\`无法打开测试弹窗：\${error.message || error}\`, 'error', 5000);
    }
  });`;

if (app.includes(fromTest)) { app = app.replace(fromTest, toTest); done.push('testReminder guard'); }
else console.log('MISS: testReminder');

const fromBoot = `document.addEventListener('DOMContentLoaded', boot);`;
const toBoot = `// Any host() failure used to surface as an unhandled rejection with no UI
// feedback; report it once instead of failing silently.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const message = (reason && (reason.message || reason)) || '未知错误';
  try { toast(\`操作未完成：\${message}\`, 'error', 5000); } catch (_) { /* ignore */ }
});

document.addEventListener('DOMContentLoaded', boot);`;

if (app.includes(fromBoot)) { app = app.replace(fromBoot, toBoot); done.push('unhandledrejection guard'); }
else console.log('MISS: boot');

fs.writeFileSync(appPath, app, 'utf8');

/* ---------------- P3-14: env var names keep working ---------------- */
const serverPath = root + 'server/server.js';
let server = fs.readFileSync(serverPath, 'utf8');
server = server.split("process.env.CAMPUSPULSE_LOG_MIRROR").join("(process.env.CLASSBELL_LOG_MIRROR || process.env.CAMPUSPULSE_LOG_MIRROR)");
server = server.split("process.env.CAMPUSPULSE_HEARTBEAT_MS").join("(process.env.CLASSBELL_HEARTBEAT_MS || process.env.CAMPUSPULSE_HEARTBEAT_MS)");
fs.writeFileSync(serverPath, server, 'utf8');
done.push('env aliases');

console.log('applied:', done.join(', '));
