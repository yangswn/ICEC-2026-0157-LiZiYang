'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/store.js';
let s = fs.readFileSync(p, 'utf8');

const from = [
  '        // "false" (string) used to sneak in as true; only accept real booleans.',
  "        next[key] = patch[key] === true || patch[key] === 'true';"
].join('\n');

const to = [
  '        // A string "false" used to be coerced to true; parse it explicitly.',
  '        const raw = patch[key];',
  "        if (typeof raw === 'boolean') next[key] = raw;",
  "        else if (raw === 'true' || raw === '1') next[key] = true;",
  "        else if (raw === 'false' || raw === '0') next[key] = false;"
].join('\n');

if (!s.includes(from)) throw new Error('coercion block not found');
s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
console.log('coercion updated');
