'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/scripts/package-native.js';
let s = fs.readFileSync(p, 'utf8');

const from = [
  'const pkg = {',
  "  name: 'classbell',",
  "  productName: 'ClassBell',",
  "  version: require(path.join(root, 'package.json')).version,",
  "  description: '课铃 ClassBell - 课程作业自动识别与到期提醒工具',",
  "  main: 'server/server.js',",
  "  license: 'MIT'",
  '};'
].join('\n');

const to = [
  'const pkg = {',
  "  name: 'classbell',",
  "  productName: 'ClassBell',",
  "  version: require(path.join(root, 'package.json')).version,",
  "  description: '课铃 ClassBell - 课程作业自动识别与到期提醒工具',",
  "  main: 'server/server.js',",
  "  license: 'MIT',",
  '  scripts: {',
  '    start: \'node server/server.js --port=48765\',',
  '    test: \'node tests/run-all.js\'',
  '  }',
  '};'
].join('\n');

if (!s.includes(from)) throw new Error('pkg block not found');
s = s.replace(from, to);

const anchor = "for (const name of ['README.md', 'LICENSE']) {";
const extra = [
  "// Ship the tests too, so `npm test` works from an installed copy instead of",
  "// only from the development checkout.",
  "if (fs.existsSync(path.join(root, 'tests'))) {",
  "  copy(path.join(root, 'tests'), path.join(outDir, 'tests'));",
  "}",
  '',
  anchor
].join('\n');

if (!s.includes(anchor)) throw new Error('readme anchor not found');
s = s.replace(anchor, extra);

fs.writeFileSync(p, s, 'utf8');
console.log('packaging updated');
