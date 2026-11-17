'use strict';

/**
 * 渲染层：错题本里图片地址的改写。
 *
 * 为什么单独一个文件：这段逻辑要用单测覆盖（允许哪些域名、失败怎么办），
 * 而 app.js 一加载就会碰 DOM，没法在 node 里 require。
 * 这里只做纯字符串处理，浏览器里挂到 window，node 里挂到 module.exports。
 */

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CampusMediaSrc = api;
}(typeof window !== 'undefined' ? window : null, function build() {
  'use strict';

  /** 只允许学习通域名。带点的后缀写法可以挡住 evil-chaoxing.com 这类绕过。 */
  const ALLOWED_HOST_SUFFIX = '.chaoxing.com';
  const ALLOWED_EXACT_HOST = 'chaoxing.com';

  /** 代理接口路径。服务端会再校验一次域名，双保险。 */
  const PROXY_PATH = '/api/media';

  function isAllowedHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    if (host === ALLOWED_EXACT_HOST) return true;
    return host.endsWith(ALLOWED_HOST_SUFFIX);
  }

  /**
   * 把外部图片地址改写成走本地代理的地址。
   *
   * 为什么统一改成 https：旧数据里有 http:// 的图片，页面本身是受限来源，
   * 直接加载有混合内容风险；服务端取图不受这个限制，所以在这一层统一升级。
   *
   * 不合法的地址一律返回空串（宁可不显示，也不要放进一个能加载任意地址的 src）。
   *
   * @param {string} raw 原始地址
   * @returns {string} 代理地址，或空串
   */
  function proxyImageSrc(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    let url;
    try {
      url = new URL(value);
    } catch (_) {
      // 相对地址：只有本就是本站路径的才放行（保持同源，不会被拿去当外部代理）
      if (value.startsWith('/') && !value.startsWith('//')) return value;
      return '';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    if (!isAllowedHost(url.hostname)) return '';
    url.protocol = 'https:';
    return `${PROXY_PATH}?u=${encodeURIComponent(url.toString())}`;
  }

  /**
   * 改写一段 HTML 里所有 <img src>。
   *
   * 只动 src 属性；改写不了（域名不在白名单）的图片直接删掉 ——
   * 留着的话浏览器会去加载它，CSP 拦下来是一张裂图，不如不给它机会。
   */
  function rewriteImageSources(html) {
    const source = String(html == null ? '' : html);
    return source.replace(/<img\b([^>]*)>/gi, (whole, attrs) => {
      const srcMatch = /src\s*=\s*"([^"]*)"/i.exec(attrs) || /src\s*=\s*'([^']*)'/i.exec(attrs);
      const proxied = srcMatch ? proxyImageSrc(srcMatch[1]) : '';
      if (!proxied) return '';
      const rest = attrs.replace(/\s*src\s*=\s*("[^"]*"|'[^']*')/i, '');
      return `<img${rest} src="${proxied}">`;
    });
  }

  return { proxyImageSrc, rewriteImageSources, isAllowedHost, PROXY_PATH };
}));