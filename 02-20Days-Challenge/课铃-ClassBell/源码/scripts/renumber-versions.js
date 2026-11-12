'use strict';
/**
 * 版本号规范化（用户要求）：
 *   1.0.9 之后的发布不允许出现 1.0.10 这种“两位补丁号”。
 *   语义化版本规则：功能/安全批 → 次版本 +1（1.1.0）；其后的修复 → 补丁 +1（1.1.1、1.1.2…）。
 *
 * 历史映射：
 *   1.0.10 → 1.1.0   （Host/CSRF/域名白名单等安全加固 + P1 缺陷修复）
 *   1.0.11 → 1.1.1   （安装包内置 WebView2 引导程序）
 *   1.0.12 → 1.1.2   （每月重复漂移 / 过期重复任务滚动）
 *   1.0.13 → 1.1.3   （导出日志走宿主另存为）
 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const read = (f) => fs.readFileSync(root + f, 'utf8');
const write = (f, s) => fs.writeFileSync(root + f, s, 'utf8');

const MAP = {
  '1.0.10': '1.1.0',
  '1.0.11': '1.1.1',
  '1.0.12': '1.1.2',
  '1.0.13': '1.1.3'
};
const CURRENT = '1.1.3';

/* 1) package.json 是唯一版本源 */
const pkg = JSON.parse(read('package.json'));
pkg.version = CURRENT;
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

/* 2) CHANGELOG 标题重编号 */
let changelog = read('CHANGELOG.md');
for (const [from, to] of Object.entries(MAP)) {
  changelog = changelog.split(`## ${from} —`).join(`## ${to} —`);
}
// 版本规则说明也改成新规则，避免下次又出现 1.0.10
changelog = changelog.replace(
  '> 版本规则：每次对外发布都递增版本号（`package.json` 的 `version`），构建脚本会自动同步程序集版本、安装器版本、安装包文件名和界面版本号。',
  [
    '> 版本规则（语义化版本）：`主.次.补丁`。',
    '> - 功能、安全或行为变更 → **次版本 +1**（例如 1.0.9 → 1.1.0）；',
    '> - 只修缺陷 → **补丁 +1**（例如 1.1.0 → 1.1.1）；',
    '> - 不再使用 `1.0.10` 这种两位补丁号。',
    '> `package.json` 的 `version` 是唯一版本源，构建脚本会自动同步程序集版本、安装器版本、安装包文件名与界面版本号。'
  ].join('\n')
);
write('CHANGELOG.md', changelog);

/* 3) 文档中的安装包名 */
for (const file of ['README.md', 'docs/作业提交说明.md', 'docs/使用手册.md', 'docs/测试记录.md']) {
  write(file, read(file).replace(/ClassBell-Setup-1\.0\.\d+\.exe/g, `ClassBell-Setup-${CURRENT}.exe`));
}

/* 4) 界面里的版本号（构建也会同步，这里先保证仓库一致） */
let html = read('src/renderer/index.html');
html = html.replace(/id="foot-version">v[^<]+</, `id="foot-version">v${CURRENT}<`);
html = html.replace(/id="about-version">v[^<]+</, `id="about-version">v${CURRENT}<`);
write('src/renderer/index.html', html);

console.log('current version set to', CURRENT);
