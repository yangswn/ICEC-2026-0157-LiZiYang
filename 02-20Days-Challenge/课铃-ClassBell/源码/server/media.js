'use strict';

/**
 * 学习通图片的本地代理。
 *
 * 为什么需要它：错题本里的公式图托管在 p.ananas.chaoxing.com，是外部域名，
 * 而页面 CSP 只允许 img-src 'self' data:。三条实测事实决定了光改 CSP 不够干净：
 *   1. CSP 限制 → 放开就要写 *.chaoxing.com，等于为一个展示功能削弱整个页面的图片策略；
 *   2. 图床不带浏览器 UA 直接 403（要 UA），这是渲染进程无法控制的部分；
 *   3. 旧数据里还有 http:// 开头的图片，页面本身是受限来源，直接加载会有混合内容风险。
 *
 * 走本地代理能一次覆盖三条：
 *   1. CSP 完全不动，图片仍然从 'self' 取；
 *   2. UA 由服务端自己加；
 *   3. http/https 统一在服务端取，浏览器只会看到 http://127.0.0.1/... 这一个来源。
 *
 * 安全边界（这是关键，代理很容易做成 SSRF）：
 *   - 只允许学习通域名（chaoxing.com 及其子域），其它一律拒绝；
 *   - 只允许 http/https，拒绝带账号密码、非标准端口的地址；
 *   - 上游跳转后的最终地址也要重新校验，防止被 302 到内网；
 *   - 只接受能识别成图片的响应（按 content-type 和文件头双重判断）；
 *   - 限制单张图大小，超出直接放弃。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 学习通域名后缀。注意用带点的形式，避免 evil-chaoxing.com 这种绕过。 */
const ALLOWED_HOST_SUFFIX = '.chaoxing.com';
const ALLOWED_EXACT_HOST = 'chaoxing.com';

/** 单张图片上限。公式图通常几十 KB，4MB 已经非常宽松。 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 上游超时。图片比接口慢一点没关系，但不能一直挂着。 */
const TIMEOUT_MS = 10000;

/**
 * 图床要求浏览器 UA（实测不带 UA 返回 403），这里固定成常见的 Edge UA。
 * 不跟随调用方的 UA，避免把这个值变成可控输入。
 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const REFERER = 'https://mooc1.chaoxing.com/';

/** 缓存文件数上限：超过就不再写新文件（不删旧文件，避免任何删除动作）。 */
const MAX_CACHE_FILES = 600;

/** 内存缓存条数：页面上滚来滚去时避免重复读盘。 */
const MEMORY_CACHE_LIMIT = 80;

class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** 判断主机名是否属于学习通。 */
function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === ALLOWED_EXACT_HOST) return true;
  return host.endsWith(ALLOWED_HOST_SUFFIX);
}

/**
 * 校验并解析图片地址。不合法返回 null —— 调用方据此直接拒绝，
 * 不做"尽力而为"的修正（含糊的修正最容易留下绕过口子）。
 *
 * @param {string} raw 原始地址
 * @returns {URL|null}
 */
function parseMediaUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  if (!isAllowedHost(url.hostname)) return null;
  return url;
}

/**
 * 按文件头判断图片类型。
 *
 * 为什么不只看 content-type：图床偶尔返回 application/octet-stream，
 * 只认 content-type 会把正常图片判成非法；而只认文件头又可能被伪造。
 * 两个都看：content-type 说图片就收，或者文件头认得出图片也收。
 *
 * @returns {string|null} MIME 类型
 */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  const head = buffer.slice(0, 200).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return null;
}

class MediaService {
  /**
   * @param {{dataDir:string, fetchImpl?:Function, telemetry?:object, maxBytes?:number, timeoutMs?:number}} options
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.cwd();
    this.fetchImpl = options.fetchImpl || null;
    this.telemetry = options.telemetry || null;
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.cacheDir = path.join(this.dataDir, 'media-cache');
    this.memory = new Map();
  }

  /** 缓存文件路径：用地址的 sha1 当文件名，避免路径穿越和超长文件名。 */
  cachePaths(url) {
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 32);
    return { file: path.join(this.cacheDir, key), index: path.join(this.cacheDir, `${key}.txt`) };
  }

  /** 读磁盘缓存。命中返回 {body, contentType}，否则 null。读失败当作没缓存。 */
  readCache(url) {
    try {
      const { file, index } = this.cachePaths(url);
      if (!fs.existsSync(file)) return null;
      const body = fs.readFileSync(file);
      if (!body.length || body.length > this.maxBytes) return null;
      // 类型优先按文件头认，认不出再退回随文件写的类型
      let contentType = sniffImageType(body);
      if (!contentType && fs.existsSync(index)) {
        contentType = fs.readFileSync(index, 'utf8').trim() || null;
      }
      if (!contentType) return null;
      return { body, contentType };
    } catch (_) {
      return null;
    }
  }

  /**
   * 写磁盘缓存。任何失败都静默忽略 —— 缓存是优化，不是功能依赖。
   * 超过文件数上限就不再写（不删文件，避免动用户目录里的东西）。
   */
  writeCache(url, body, contentType) {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      if (fs.readdirSync(this.cacheDir).length >= MAX_CACHE_FILES * 2) return;
      const { file, index } = this.cachePaths(url);
      fs.writeFileSync(file, body);
      fs.writeFileSync(index, String(contentType || ''), 'utf8');
    } catch (_) {
      // 只读盘、磁盘满、权限不足都不影响这次返回
    }
  }

  /**
   * 取一张图。命中缓存直接返回；否则带 UA/Referer 去学习通取。
   *
   * @param {string} rawUrl
   * @returns {Promise<{body:Buffer, contentType:string, cached:boolean}>}
   * @throws {MediaError} INVALID_MEDIA_URL / MEDIA_FETCH_FAILED / MEDIA_NOT_IMAGE / MEDIA_TOO_LARGE
   */
  async get(rawUrl) {
    const url = parseMediaUrl(rawUrl);
    if (!url) throw new MediaError('INVALID_MEDIA_URL', '只允许学习通图片地址');
    const target = url.toString();

    const fromMemory = this.memory.get(target);
    if (fromMemory) return { ...fromMemory, cached: true };

    const fromDisk = this.readCache(target);
    if (fromDisk) {
      this.remember(target, fromDisk);
      return { ...fromDisk, cached: true };
    }

    const doFetch = this.fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await doFetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': REFERER
        }
      });
    } catch (error) {
      throw new MediaError('MEDIA_FETCH_FAILED', '图片下载失败');
    } finally {
      clearTimeout(timer);
    }

    if (!res || !res.ok) {
      throw new MediaError('MEDIA_FETCH_FAILED', `图床返回 ${res ? res.status : '无响应'}`);
    }

    // 跳转后的最终地址也要校验：否则一个 302 就能把代理变成访问内网的工具
    const finalUrl = res.url || target;
    if (!parseMediaUrl(finalUrl)) {
      throw new MediaError('INVALID_MEDIA_URL', '图片地址跳转到了非学习通域名');
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > this.maxBytes) {
      throw new MediaError('MEDIA_TOO_LARGE', '图片太大');
    }

    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) throw new MediaError('MEDIA_FETCH_FAILED', '图床返回空内容');
    if (body.length > this.maxBytes) throw new MediaError('MEDIA_TOO_LARGE', '图片太大');

    const headerType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const sniffed = sniffImageType(body);
    const contentType = sniffed || (headerType.startsWith('image/') ? headerType : '');
    if (!contentType) throw new MediaError('MEDIA_NOT_IMAGE', '返回内容不是图片');

    this.remember(target, { body, contentType });
    this.writeCache(target, body, contentType);
    return { body, contentType, cached: false };
  }

  /** 记进内存缓存，超出条数就丢掉最早的一条（只是内存，不涉及文件）。 */
  remember(url, entry) {
    if (this.memory.size >= MEMORY_CACHE_LIMIT) {
      const oldest = this.memory.keys().next().value;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(url, entry);
  }

  /** 缓存目录大小，供状态接口展示（可选）。 */
  cacheStats() {
    try {
      const entries = fs.readdirSync(this.cacheDir).filter((name) => !name.endsWith('.txt'));
      return { files: entries.length };
    } catch (_) {
      return { files: 0 };
    }
  }
}

module.exports = {
  MediaService,
  MediaError,
  parseMediaUrl,
  isAllowedHost,
  sniffImageType,
  MAX_BYTES,
  BROWSER_UA
};