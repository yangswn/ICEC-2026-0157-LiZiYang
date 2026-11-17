'use strict';

/**
 * 1.10.1：错题本公式图裂图修复。
 *
 * 覆盖三件事：
 *   1. 图片地址从哪来（解析阶段的地址 → 渲染阶段的代理地址）；
 *   2. 取不到图时怎么降级（服务端返回错误码，渲染层换占位）；
 *   3. 安全边界（代理只认学习通域名，不能变成任意 URL / 内网代理）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const {
  MediaService,
  MediaError,
  parseMediaUrl,
  isAllowedHost,
  sniffImageType
} = require('../server/media.js');
const rendererMedia = require('../src/renderer/media-src.js');

/* 一张最小合法 PNG（1x1），用来验证"真的是图片才收" */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

function makeService(over = {}) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'media-'));
  fs.mkdirSync(dir, { recursive: true });
  return new MediaService({ dataDir: dir, ...over });
}

/** 造一个假的 fetch 响应。 */
function fakeResponse({ ok = true, status = 200, headers = {}, body = TINY_PNG, url = '' } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok,
    status,
    url,
    headers: { get: (name) => map.get(String(name).toLowerCase()) || null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

/* ======================================================== 地址白名单 */

test('only chaoxing hosts are accepted by the server-side parser', () => {
  assert.ok(parseMediaUrl('https://p.ananas.chaoxing.com/star3/origin/a.png'));
  assert.ok(parseMediaUrl('http://p.ananas.chaoxing.com/star3/origin/a.jpg'));
  assert.ok(parseMediaUrl('https://mooc1.chaoxing.com/x.png'));
  assert.ok(parseMediaUrl('https://chaoxing.com/x.png'));
});

test('the proxy refuses to become a general purpose fetcher', () => {
  // 任意外站
  assert.equal(parseMediaUrl('https://evil.com/x.png'), null);
  // 后缀相似但不同域：不能靠字符串包含判断
  assert.equal(parseMediaUrl('https://evil-chaoxing.com/x.png'), null);
  assert.equal(parseMediaUrl('https://chaoxing.com.evil.com/x.png'), null);
  // 本机与内网
  assert.equal(parseMediaUrl('http://127.0.0.1/x.png'), null);
  assert.equal(parseMediaUrl('http://localhost:8080/x.png'), null);
  assert.equal(parseMediaUrl('http://10.0.0.5/x.png'), null);
  assert.equal(parseMediaUrl('http://169.254.169.254/latest/meta-data/'), null);
  // 非 http(s) 协议
  assert.equal(parseMediaUrl('file:///C:/Windows/win.ini'), null);
  assert.equal(parseMediaUrl('javascript:alert(1)'), null);
  assert.equal(parseMediaUrl('data:image/png;base64,AAAA'), null);
  // 带账号密码 / 非标准端口
  assert.equal(parseMediaUrl('https://user:pass@p.ananas.chaoxing.com/a.png'), null);
  assert.equal(parseMediaUrl('https://p.ananas.chaoxing.com:8443/a.png'), null);
  // 空值
  assert.equal(parseMediaUrl(''), null);
  assert.equal(parseMediaUrl(null), null);
});

test('isAllowedHost requires the exact domain or a real subdomain', () => {
  assert.equal(isAllowedHost('chaoxing.com'), true);
  assert.equal(isAllowedHost('P.Ananas.Chaoxing.COM'), true);
  assert.equal(isAllowedHost('chaoxing.com.cn'), false);
  assert.equal(isAllowedHost('notchaoxing.com'), false);
});

/* ==================================================== 渲染层地址改写 */

test('renderer rewrites chaoxing images to the local proxy', () => {
  const src = rendererMedia.proxyImageSrc('https://p.ananas.chaoxing.com/star3/origin/a.png');
  assert.equal(src, '/api/media?u=' + encodeURIComponent('https://p.ananas.chaoxing.com/star3/origin/a.png'));
});

test('renderer upgrades http images to https before proxying', () => {
  const src = rendererMedia.proxyImageSrc('http://p.ananas.chaoxing.com/star3/origin/a.jpg');
  assert.ok(src.startsWith('/api/media?u='));
  assert.ok(decodeURIComponent(src).includes('https://p.ananas.chaoxing.com/'), '要升级成 https，避免混合内容');
});

test('renderer never leaves an external src behind', () => {
  assert.equal(rendererMedia.proxyImageSrc('https://evil.com/x.png'), '');
  assert.equal(rendererMedia.proxyImageSrc('javascript:alert(1)'), '');
  assert.equal(rendererMedia.proxyImageSrc('data:image/png;base64,AAAA'), '');
  assert.equal(rendererMedia.proxyImageSrc(''), '');
  // 同源绝对路径保留
  assert.equal(rendererMedia.proxyImageSrc('/assets/a.png'), '/assets/a.png');
});

test('rewriteImageSources handles both quote styles and drops bad images', () => {
  const html = '<img class="cx-inline-img" src="https://p.ananas.chaoxing.com/a.png" alt="x">'
    + "<img src='http://p.ananas.chaoxing.com/b.jpg'>"
    + '<img src="https://evil.com/c.png">'
    + '文字部分不变';

  const out = rendererMedia.rewriteImageSources(html);
  assert.equal((out.match(/\/api\/media\?u=/g) || []).length, 2, '两张学习通图都要走代理');
  assert.equal(out.includes('evil.com'), false, '外站图片直接去掉，不留裂图');
  assert.ok(out.includes('alt="x"'), '其它属性要保留');
  assert.ok(out.includes('文字部分不变'));
});

test('rewriteImageSources is safe on empty and missing html', () => {
  assert.equal(rendererMedia.rewriteImageSources(''), '');
  assert.equal(rendererMedia.rewriteImageSources(null), '');
  assert.equal(rendererMedia.rewriteImageSources(undefined), '');
});

/* ==================================================== 服务端取图行为 */

test('fetches an image with a browser UA and caches it', async () => {
  const calls = [];
  const service = makeService({
    fetchImpl: async (url, options) => {
      calls.push({ url, ua: options.headers['User-Agent'] });
      return fakeResponse({ headers: { 'content-type': 'image/png' }, url });
    }
  });

  const first = await service.get('https://p.ananas.chaoxing.com/a.png');
  assert.equal(first.contentType, 'image/png');
  assert.equal(first.cached, false);
  assert.ok(first.body.length > 0);
  assert.match(calls[0].ua, /Mozilla/, '图床不带浏览器 UA 会 403，必须自己补');

  const second = await service.get('https://p.ananas.chaoxing.com/a.png');
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, '第二次走缓存，不再打图床');
});

test('a second service instance reuses the on-disk cache', async () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp', 'media-disk-'));
  fs.mkdirSync(dir, { recursive: true });

  const writer = new MediaService({
    dataDir: dir,
    fetchImpl: async (url) => fakeResponse({ headers: { 'content-type': 'image/png' }, url })
  });
  await writer.get('https://p.ananas.chaoxing.com/cached.png');

  // 新实例 + 一个必定失败的 fetch：能拿到图就说明读的是磁盘缓存
  const reader = new MediaService({
    dataDir: dir,
    fetchImpl: async () => { throw new Error('should not fetch'); }
  });
  const hit = await reader.get('https://p.ananas.chaoxing.com/cached.png');
  assert.equal(hit.cached, true);
  assert.equal(hit.contentType, 'image/png');
});

test('upstream 403 becomes a typed error instead of a crash', async () => {
  const service = makeService({
    fetchImpl: async () => fakeResponse({ ok: false, status: 403, body: Buffer.alloc(0) })
  });
  await assert.rejects(
    () => service.get('https://p.ananas.chaoxing.com/a.png'),
    (error) => error instanceof MediaError && error.code === 'MEDIA_FETCH_FAILED'
  );
});

test('an html error page is rejected as not-an-image', async () => {
  const service = makeService({
    fetchImpl: async () => fakeResponse({
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html>无权限</html>')
    })
  });
  await assert.rejects(
    () => service.get('https://p.ananas.chaoxing.com/a.png'),
    (error) => error instanceof MediaError && error.code === 'MEDIA_NOT_IMAGE'
  );
});

test('oversized images are refused', async () => {
  const service = makeService({
    maxBytes: 16,
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' }, body: Buffer.alloc(64, 7) })
  });
  await assert.rejects(
    () => service.get('https://p.ananas.chaoxing.com/big.png'),
    (error) => error instanceof MediaError && error.code === 'MEDIA_TOO_LARGE'
  );
});

test('a redirect to a non-chaoxing host is refused', async () => {
  const service = makeService({
    fetchImpl: async (url) => fakeResponse({
      headers: { 'content-type': 'image/png' },
      url: 'http://169.254.169.254/latest/meta-data/'
    })
  });
  await assert.rejects(
    () => service.get('https://p.ananas.chaoxing.com/redirect.png'),
    (error) => error instanceof MediaError && error.code === 'INVALID_MEDIA_URL'
  );
});

test('invalid urls are rejected before any request is made', async () => {
  let called = 0;
  const service = makeService({ fetchImpl: async () => { called += 1; return fakeResponse(); } });
  await assert.rejects(
    () => service.get('https://evil.com/x.png'),
    (error) => error instanceof MediaError && error.code === 'INVALID_MEDIA_URL'
  );
  assert.equal(called, 0, '校验不通过在本地就拒绝，不发请求');
});

test('sniffImageType recognises the formats chaoxing serves', () => {
  assert.equal(sniffImageType(TINY_PNG), 'image/png');
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('RIFF....WEBP', 'ascii')), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('<html>', 'ascii')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

/* ============================================ 页面侧接线（防止以后被改回去） */

test('the page loads the media helper and uses it in mistake cards', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'app.js'), 'utf8');

  assert.ok(html.includes('media-src.js'), '页面要加载 media-src.js');
  assert.ok(app.includes('CampusMediaSrc'), 'app.js 要使用它');
  assert.ok(app.includes('rewriteImageSources'), '题干和选项的图片要改写');
  assert.ok(app.includes('installImageFallback'), '要有单张图失败的降级');
});

test('csp still keeps images same-origin only', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
  const m = /img-src([^;"]+)/i.exec(html);
  assert.ok(m, '要有 img-src 指令');
  const value = m[1].trim();
  assert.ok(value.includes("'self'"));
  assert.equal(/chaoxing/i.test(value), false, '不允许把外部域名写进 CSP —— 图片走本地代理');
});