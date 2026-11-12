'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['.git', 'dist', 'node_modules', '.preview', '.test-data', '.cache', '.npm-cache']);
const exts = new Set(['.cs', '.js', '.json', '.html', '.css', '.md', '.ps1', '.nsi', '.nsh', '.txt', '.xml', '.yml', '.yaml']);
let changed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      if (full.includes(`${path.sep}process_logs${path.sep}`)) continue;
      walk(full);
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      const before = fs.readFileSync(full, 'utf8');
      const after = before.split('ClassBell').join('ClassBell').split('课铃').join('课铃');
      if (after !== before) {
        fs.writeFileSync(full, after, 'utf8');
        changed++;
        console.log('updated', path.relative(root, full));
      }
    }
  }
}

walk(root);
console.log('files changed:', changed);
