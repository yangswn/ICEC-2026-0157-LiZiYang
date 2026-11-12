'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Telemetry } = require('../server/telemetry');

test('writes JSONL, mirrors it and summarizes the last seven days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-log-'));
  const mirror = path.join(dir, 'repo');
  const telemetry = new Telemetry({ dataDir: path.join(dir, 'data'), mirrorDir: mirror, appVersion: '1.0.0' });
  telemetry.log('app_start', { meta: { dev: true } });
  telemetry.log('sync_complete', { durationMs: 128, meta: { tasks: 3 } });
  telemetry.log('sync_failed', { ok: false, error: new Error('offline') });

  const summary = telemetry.summary();
  assert.equal(summary.days.length, 7);
  assert.equal(summary.today.events, 3);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.totals.syncs, 1);
  assert.ok(fs.existsSync(path.join(mirror, 'process_logs')));
  const files = fs.readdirSync(path.join(mirror, 'process_logs')).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(mirror, 'process_logs', files[0]), 'utf8');
  assert.match(raw, /sync_complete/);
  assert.doesNotMatch(raw, /password/i);
});

test('recentEvents returns newest first and redacts error objects to code/message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-log-'));
  const telemetry = new Telemetry({ dataDir: dir, appVersion: '1.0.0' });
  telemetry.log('task_added', { meta: { category: 'homework' } });
  const err = new Error('network down');
  err.code = 'ENETUNREACH';
  telemetry.log('sync_failed', { ok: false, error: err });
  const recent = telemetry.recentEvents(10);
  assert.equal(recent[0].event, 'sync_failed');
  assert.equal(recent[0].ok, false);
  assert.match(recent[0].error, /ENETUNREACH/);
});

test('writes a 7-day index and exports it with the JSONL files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-log-'));
  const exportDir = path.join(dir, 'export');
  const telemetry = new Telemetry({ dataDir: dir, appVersion: '1.0.0' });
  telemetry.log('app_start');
  telemetry.log('heartbeat');
  telemetry.writeIndex();
  const index = JSON.parse(fs.readFileSync(path.join(telemetry.logDir, 'index.json'), 'utf8'));
  assert.equal(index.totals.events, 2);
  assert.equal(index.days.length, 7);
  assert.equal(index.totals.activeDays, 1);
  const copied = telemetry.copyAllTo(exportDir);
  assert.ok(copied.copied >= 2);
  assert.ok(fs.existsSync(path.join(exportDir, 'index.json')));
});

