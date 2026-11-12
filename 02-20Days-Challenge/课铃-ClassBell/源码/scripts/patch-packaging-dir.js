'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/scripts/package-native.js';
let s = fs.readFileSync(p, 'utf8');

const from = [
  "if (fs.existsSync(path.join(root, 'tests'))) {",
  "  copy(path.join(root, 'tests'), path.join(outDir, 'tests'));",
  "}"
].join('\n');

const to = [
  "if (fs.existsSync(path.join(root, 'tests'))) {",
  "  copyDir(path.join(root, 'tests'), path.join(outDir, 'tests'));",
  "}"
].join('\n');

if (!s.includes(from)) throw new Error('tests copy block not found');
s = s.replace(from, to);

/* add the recursive helper next to the existing file copy helper */
const anchor = 'const pkg = {';
const helper = [
  'function copyDir(src, dest) {',
  '  fs.mkdirSync(dest, { recursive: true });',
  '  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {',
  '    const from = path.join(src, entry.name);',
  '    const to = path.join(dest, entry.name);',
  '    if (entry.isDirectory()) copyDir(from, to);',
  '    else fs.copyFileSync(from, to);',
  '  }',
  '}',
  '',
  anchor
].join('\n');

if (!s.includes(anchor)) throw new Error('pkg anchor not found');
s = s.replace(anchor, helper);

fs.writeFileSync(p, s, 'utf8');
console.log('copyDir added');
