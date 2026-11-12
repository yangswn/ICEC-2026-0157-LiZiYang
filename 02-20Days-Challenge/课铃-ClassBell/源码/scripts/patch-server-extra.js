'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/server.js';
let s = fs.readFileSync(p, 'utf8');
const done = [];
function rep(from, to, label) {
  if (!s.includes(from)) { console.log('MISS:', label); return; }
  s = s.split(from).join(to);
  done.push(label);
}

/* P0-4: never hand the stored session cookies to a cross-site page. */
rep(
`  if (p === '/api/cx/cookies' && method === 'GET') {
    if (chaoxing.exportCookies().length) return json(res, 200, { cookies: chaoxing.exportCookies() });`,
`  if (p === '/api/cx/cookies' && method === 'GET') {
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'cross-site') {
      return json(res, 403, { error: 'FORBIDDEN_ORIGIN', message: '跨站请求被拒绝' });
    }
    if (chaoxing.exportCookies().length) return json(res, 200, { cookies: chaoxing.exportCookies() });`,
'cookie cross-site guard'
);

/* P2-13: report dropped reminders instead of losing them silently. */
rep(
`  if (p === '/api/reminders/pending' && method === 'GET') {
    scheduler.check();
    processSnoozes();
    const items = reminderQueue.splice(0, reminderQueue.length);
    return json(res, 200, { items });
  }`,
`  if (p === '/api/reminders/pending' && method === 'GET') {
    scheduler.check();
    processSnoozes();
    const items = reminderQueue.splice(0, reminderQueue.length);
    if (reminderDropped > 0) {
      log('reminder_dropped', { meta: { count: reminderDropped } });
      reminderDropped = 0;
    }
    return json(res, 200, { items });
  }`,
'pending drop reset'
);

fs.writeFileSync(p, s, 'utf8');
console.log('applied:', done.join(', '));
