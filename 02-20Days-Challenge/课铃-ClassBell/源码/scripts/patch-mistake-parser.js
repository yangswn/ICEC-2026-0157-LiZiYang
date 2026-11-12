'use strict';
const fs = require('fs');
const path = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/chaoxing-parser.js';
let text = fs.readFileSync(path, 'utf8');

const start = text.indexOf('function parseMistakeLines(lines, base) {');
const endMarker = '\n}\n\nmodule.exports = {';
const end = text.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('parseMistakeLines block not found');

const replacement = `function parseMistakeLines(lines, base) {
  const out = [];
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/我的答案|我的作答|学生答案/.test(line)) continue;

    // The desktop review page prints labels inline:
    //   我的答案:A 正确答案:A 答案解析:...
    const myMatch = /(?:我的答案|我的作答|学生答案)\\s*[:：]?\\s*(.*?)(?=正确答案|答案解析|试题解析|得分|$)/.exec(line);
    let myAnswer = clean(myMatch ? myMatch[1] : '');
    if (!myAnswer) {
      const fallback = /(?:我的答案|我的作答|学生答案)\\s*[:：]?\\s*(.*)$/.exec(line);
      myAnswer = clean(fallback ? fallback[1] : '');
    }

    let correctAnswer = '';
    const correctInline = /正确答案\\s*[:：]?\\s*(.*?)(?=答案解析|试题解析|得分|$)/.exec(line);
    if (correctInline) correctAnswer = clean(correctInline[1]);
    let analysis = '';
    const analysisInline = /(?:答案解析|试题解析|解析)\\s*[:：]?\\s*(.*)$/.exec(line);
    if (analysisInline) analysis = clean(analysisInline[1]);

    // Question stem: prefer the nearest numbered line and include the lines
    // that follow it up to the options (formulas often sit on their own line).
    let question = '';
    let numbered = -1;
    for (let j = i - 1; j >= Math.max(0, i - 12); j -= 1) {
      const prev = lines[j];
      if (!prev) continue;
      if (/正确答案|答案解析|试题解析|我的答案|得分|批阅|教师点评/.test(prev)) continue;
      if (/^\\d+[.、．)）]/.test(prev)) { numbered = j; break; }
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

    for (let j = i + 1; j < Math.min(lines.length, i + 14); j += 1) {
      const next = lines[j];
      if (/我的答案/.test(next)) break;
      if (!correctAnswer) {
        const hit = /正确答案\\s*[:：]?\\s*(.*?)(?=答案解析|试题解析|得分|$)/.exec(next);
        if (hit) correctAnswer = clean(hit[1]);
      }
      if (!analysis) {
        const hit = /(?:答案解析|试题解析|解析)\\s*[:：]?\\s*(.*)$/.exec(next);
        if (hit) analysis = clean(hit[1]);
      }
      if (correctAnswer && analysis) break;
    }

    if (!correctAnswer && !/错误|不正确|答错/.test(lines.slice(Math.max(0, i - 3), i + 3).join(' '))) continue;
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').toLowerCase();
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
}`;

text = text.slice(0, start) + replacement + text.slice(end);
fs.writeFileSync(path, text, 'utf8');
console.log('parseMistakeLines replaced');
