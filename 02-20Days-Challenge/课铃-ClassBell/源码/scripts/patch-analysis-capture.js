'use strict';
const fs = require('fs');
const path = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/chaoxing-parser.js';
let text = fs.readFileSync(path, 'utf8');

const from = `    for (let j = i + 1; j < Math.min(lines.length, i + 14); j += 1) {
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
    }`;

const to = `    // Answers and explanations can span several lines on the review page.
    let analysisOpen = Boolean(analysisInline);
    for (let j = i + 1; j < Math.min(lines.length, i + 20); j += 1) {
      const next = lines[j];
      if (/我的答案/.test(next) || /^\\d+[.、．)）]\\s*[\\(（]?[单多判填]/.test(next)) break;
      if (!correctAnswer) {
        const hit = /正确答案\\s*[:：]?\\s*(.*?)(?=答案解析|试题解析|得分|$)/.exec(next);
        if (hit) correctAnswer = clean(hit[1]);
      }
      const analysisHit = /(?:答案解析|试题解析|解析)\\s*[:：]?\\s*(.*)$/.exec(next);
      if (analysisHit) {
        analysis = clean([analysis, analysisHit[1]].filter(Boolean).join(' '));
        analysisOpen = true;
      } else if (analysisOpen && !/得分|批阅|教师点评/.test(next)) {
        analysis = clean([analysis, next].filter(Boolean).join(' ')).slice(0, 900);
      } else if (/得分|批阅|教师点评/.test(next)) {
        analysisOpen = false;
      }
      if (correctAnswer && analysis && !analysisOpen) break;
    }`;

if (!text.includes(from)) throw new Error('analysis block not found');
text = text.split(from).join(to);
fs.writeFileSync(path, text, 'utf8');
console.log('analysis capture widened');
