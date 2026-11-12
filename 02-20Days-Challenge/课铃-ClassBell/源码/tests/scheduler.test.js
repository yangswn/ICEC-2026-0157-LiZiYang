'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReminderScheduler, inQuietHours, reminderKey } = require('../server/scheduler');

function fixture(task, settings = {}) {
  const state = {
    tasks: [task],
    settings: { sound: true, quietHours: { enabled: false, start: '23:00', end: '07:00' }, ...settings },
    metrics: { totalReminders: 0 }
  };
  const store = {
    state,
    markRemindersSent(id, keys) {
      const t = state.tasks.find((x) => x.id === id);
      t.remindersSent = [...new Set([...(t.remindersSent || []), ...keys])];
    }
  };
  const fired = [];
  const telemetry = { log() {} };
  const scheduler = new ReminderScheduler({ store, telemetry, onFire: (p) => fired.push(p) });
  return { scheduler, fired, state };
}

test('fires a reminder inside its offset window and only once', () => {
  const due = new Date(Date.now() + 5 * 60000).toISOString();
  const { scheduler, fired } = fixture({
    id: 't1', title: '测试', course: '', category: 'homework', priority: 'normal',
    dueAt: due, status: 'pending', reminderOffsets: [10], remindersSent: []
  });
  const first = scheduler.check(new Date());
  assert.equal(first.length, 1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].offset, 10);
  const second = scheduler.check(new Date());
  assert.equal(second.length, 0);
});

test('does not fire before the reminder time', () => {
  const due = new Date(Date.now() + 3 * 3600000).toISOString();
  const { scheduler, fired } = fixture({
    id: 't2', title: '测试', course: '', category: 'homework', priority: 'normal',
    dueAt: due, status: 'pending', reminderOffsets: [10], remindersSent: []
  });
  assert.equal(scheduler.check(new Date()).length, 0);
  assert.equal(fired.length, 0);
});

test('dismiss suppresses every outstanding reminder for the task', () => {
  const due = new Date(Date.now() + 5 * 60000).toISOString();
  const task = {
    id: 't3', title: '测试', course: '', category: 'homework', priority: 'normal',
    dueAt: due, status: 'pending', reminderOffsets: [60, 10], remindersSent: []
  };
  const { scheduler } = fixture(task);
  scheduler.dismiss('t3');
  assert.deepEqual(task.remindersSent.sort(), [
    reminderKey(10, due), reminderKey(60, due)
  ].sort());
});

test('quiet hours wrap around midnight', () => {
  const settings = { quietHours: { enabled: true, start: '23:00', end: '07:00' } };
  assert.equal(inQuietHours(settings, new Date(2026, 10, 9, 23, 30)), true);
  assert.equal(inQuietHours(settings, new Date(2026, 10, 10, 6, 30)), true);
  assert.equal(inQuietHours(settings, new Date(2026, 10, 10, 12, 0)), false);
});

