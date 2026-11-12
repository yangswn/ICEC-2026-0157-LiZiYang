'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const p = root + 'server/server.js';
let s = fs.readFileSync(p, 'utf8');
const applied = [];
function rep(from, to, label) {
  if (!s.includes(from)) { console.log('MISS:', label); return; }
  s = s.split(from).join(to);
  applied.push(label);
}

/* ---- P0-1 + P0-2: Host allowlist, cross-site and content-type guard ---- */
rep(
`async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}`,
`async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/* Only the local host may talk to this service. Binding to 127.0.0.1 alone does
   not stop DNS rebinding: a hostile page can resolve its own domain to loopback
   and reach these APIs with a foreign Host header. */
const ALLOWED_HOSTS = new Set([
  \`127.0.0.1:\${port}\`,
  \`localhost:\${port}\`,
  \`[::1]:\${port}\`
]);

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  return ALLOWED_HOSTS.has(host);
}

/* Writes must come from our own page: JSON content type + same-origin fetch.
   Browsers cannot set Sec-Fetch-Site from a cross-site page, and text/plain
   simple requests skip preflight, so both are checked. */
function crossSiteWrite(req) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = String(req.headers.origin || '');
  if (origin && !/^http:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/i.test(origin)) return true;
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct && ct !== 'application/json') return true;
  return false;
}`,
'host+csrf helpers'
);

/* ---- P0-3: strict hostname check for the learn-page inspector ---- */
rep(
`    const url = String(body.url || '');
    if (!/^https:\\/\\/[a-z0-9.-]*chaoxing\\.com\\//i.test(url)) {
      return json(res, 400, { ok: false, message: 'only chaoxing urls are allowed' });
    }`,
`    const url = String(body.url || '');
    let target = null;
    try { target = new URL(url); } catch (_) { target = null; }
    const hostName = target ? target.hostname.toLowerCase() : '';
    const chaoxingHost = hostName === 'chaoxing.com' || hostName.endsWith('.chaoxing.com');
    if (!target || target.protocol !== 'https:' || target.username || target.password
        || (target.port && target.port !== '443') || !chaoxingHost) {
      return json(res, 400, { ok: false, error: 'INVALID_URL', message: '仅允许学习通域名' });
    }`,
'inspect url whitelist'
);

/* ---- P1-8: malformed percent-encoding must not hang the request ---- */
rep(
`function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let urlPath = decodeURIComponent(parsed.pathname);
  if (urlPath === '/') urlPath = '/index.html';`,
`function serveStatic(req, res) {
  let parsed;
  try { parsed = new URL(req.url, 'http://127.0.0.1'); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent(parsed.pathname); }
  catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (urlPath === '/favicon.ico') {
    res.writeHead(302, { Location: '/assets/icon.png' });
    res.end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';`,
'static guards'
);

/* ---- server entry: host guard, CSRF guard, error mapping ---- */
rep(
`const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/events') {
    handleApi(req, res).catch((error) => {
      const code = (error && error.code) || 'SERVER_ERROR';
      log('api_error', { ok: false, error, meta: { path: req.url.split('?')[0] } });
      if (!res.headersSent) json(res, 400, { error: code, message: String((error && error.message) || error).slice(0, 200) });
      else res.end();
    });
    return;
  }
  serveStatic(req, res);
});`,
`const API_STATUS = {
  TASK_NOT_FOUND: 404, NOTICE_NOT_FOUND: 404, GEAR_NOT_FOUND: 404, MISTAKE_NOT_FOUND: 404,
  TASK_TITLE_REQUIRED: 422, TASK_DUE_INVALID: 422, MISTAKE_QUESTION_REQUIRED: 422,
  GEAR_NAME_REQUIRED: 422, NOTICE_TITLE_REQUIRED: 422, IMPORT_INVALID_FORMAT: 422,
  IMPORT_INVALID_JSON: 422, TASK_LIMIT_REACHED: 409
};

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) {
    if (req.url.startsWith('/api/') || req.url === '/events') {
      return json(res, 403, { error: 'HOST_NOT_ALLOWED', message: '仅允许本机访问' });
    }
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('仅允许本机访问');
  }
  if (crossSiteWrite(req)) {
    return json(res, 403, { error: 'FORBIDDEN_ORIGIN', message: '跨站请求被拒绝' });
  }
  if (req.url.startsWith('/api/') || req.url === '/events') {
    handleApi(req, res).catch((error) => {
      const code = (error && error.code) || error.message || 'SERVER_ERROR';
      log('api_error', { ok: false, error, meta: { path: req.url.split('?')[0] } });
      if (!res.headersSent) {
        json(res, API_STATUS[code] || 400, { error: code, message: String((error && error.message) || error).slice(0, 200) });
      } else res.end();
    });
    return;
  }
  try { serveStatic(req, res); }
  catch (error) {
    if (!res.headersSent) json(res, 400, { error: 'BAD_REQUEST', message: '请求格式错误' });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});`,
'server guards'
);

/* ---- P1-10: crash instead of running in an undefined state ---- */
rep(
`process.on('uncaughtException', (error) => {`,
`process.on('uncaughtException', (error) => {
  try { log('uncaught_exception', { ok: false, error }); } catch (_) { /* ignore */ }
  try { store.flush(); } catch (_) { /* ignore */ }
  try { telemetry.flush(); } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(1), 60);
  return;`,
'uncaught exit'
);

fs.writeFileSync(p, s, 'utf8');
console.log('applied:', applied.join(', '));
