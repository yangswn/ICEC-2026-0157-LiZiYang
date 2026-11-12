'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/server/server.js';
let s = fs.readFileSync(p, 'utf8');

const from = "process.on('uncaughtException', (error) => log('uncaught_exception', { ok: false, error }));";
const to = [
  "process.on('uncaughtException', (error) => {",
  "  try { log('uncaught_exception', { ok: false, error }); } catch (_) { /* ignore */ }",
  "  try { store.flush(); } catch (_) { /* ignore */ }",
  "  try { telemetry.flush(); } catch (_) { /* ignore */ }",
  "  try { telemetry.writeIndex(); } catch (_) { /* ignore */ }",
  "  // Running on after an unhandled exception leaves the service in an unknown",
  "  // state; exit and let the host report it instead of serving bad data.",
  "  setTimeout(() => process.exit(1), 60);",
  "});"
].join('\n');

if (!s.includes(from)) throw new Error('uncaught handler not found');
s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
console.log('uncaughtException patched');
