'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');

const VERSION = '1.0.10';

/* every doc points at the current installer */
for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  let text = read(file).replace(/ClassBell-Setup-1\.0\.\d+\.exe/g, `ClassBell-Setup-${VERSION}.exe`);
  write(file, text);
}

/* README: describe the hardening fixes and the test story accurately */
let readme = read('README.md');

readme = readme.replace(
  '当前结果：23 项单元测试全部通过',
  '当前结果：37 项单元测试全部通过'
);
readme = readme.replace(
  '`npm test`                 # 23 项单元测试',
  '`npm test`                 # 37 项单元测试'
);
readme = readme.replaceAll('23 项', '37 项');

if (!readme.includes('## 安全边界')) {
  readme = readme.replace(
    '## 构建',
    [
      '## 安全边界',
      '',
      '本地服务只监听 `127.0.0.1`，并在此基础上加了三层限制：',
      '',
      '- **Host 校验**：只接受 `127.0.0.1:<端口>` / `localhost:<端口>`，阻断 DNS rebinding 读取；',
      '- **同源写保护**：写请求必须是 `application/json`、同源 `Sec-Fetch-Site`，拒绝跨站 CSRF；',
      '- **Cookie 读取隔离**：`/api/cx/cookies` 拒绝跨站来源，学习通会话只在本机流转。',
      '',
      '`/api/mistakes/inspect` 只允许 `https` 且主机名严格等于 `chaoxing.com` 或其子域。',
      '',
      '## 构建'
    ].join('\n')
  );
}
write('README.md', readme);

/* CHANGELOG */
let changelog = read('CHANGELOG.md');
changelog = changelog.replace(
  '# Changelog',
  [
    '# Changelog',
    '',
    `## ${VERSION} — 2026-11-10`,
    '',
    '外部测试报告（14 项缺陷）修复批次。',
    '',
    '### Security',
    '',
    '- Host 校验：只接受本机 Host，阻断 DNS rebinding 读取任务、设置与学习通 Cookie；',
    '- 写请求同源校验：拒绝 `text/plain` 跨站简单请求（CSRF）；',
    '- `/api/mistakes/inspect` 改用 URL 解析严格限定 `chaoxing.com` 及其子域，修复白名单绕过；',
    '- `/api/cx/cookies` 拒绝跨站来源读取；',
    '- 畸形 URL 不再让请求永久挂起；未捕获异常记录后退出，不再带坏状态继续服务。',
    '',
    '### Fixed',
    '',
    '- 编辑任务（含只改备注）不再让已弹过的提醒重弹；',
    '- 备份导入按 `sourceKey`/标题+截止时间去重，并恢复 `settings`；重复导入不再翻倍；',
    '- 静音时段拒绝 `99:99` 这类非法时间，布尔设置不再被字符串 `"false"` 误存为 `true`；',
    '- 「测试弹窗」失败会给出提示，并加 `unhandledrejection` 兜底；',
    '- 错题解析支持「未作答」与整行复制粘贴的紧凑文本；',
    '- 业务错误返回 404/422 等语义化状态码，不再一律 `SERVER_ERROR` 400。',
    '',
    '### Changed',
    '',
    '- 缺少 WebView2 运行时的电脑不再直接报错退出：自动用默认浏览器打开课铃，并说明如何安装运行时；',
    '- 安装目录内附带 `tests/`，`npm test` 在安装副本里也能跑；',
    '- 环境变量新增 `CLASSBELL_LOG_MIRROR` / `CLASSBELL_HEARTBEAT_MS`，旧名继续兼容。',
    ''
  ].join('\n')
);
write('CHANGELOG.md', changelog);

console.log('docs updated for', VERSION);
