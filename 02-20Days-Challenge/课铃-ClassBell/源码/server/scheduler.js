'use strict';

function minutesOfDay(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return 0;
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
}

function inQuietHours(settings, date = new Date()) {
  const quiet = settings && settings.quietHours;
  if (!quiet || !quiet.enabled) return false;
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  const now = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function reminderKey(offset, dueAt) {
  return `o${offset}@${dueAt}`;
}

class ReminderScheduler {
  constructor({ store, telemetry, onFire }) {
    this.store = store;
    this.telemetry = telemetry;
    this.onFire = onFire;
    this.timer = null;
    this.checking = false;
    this.lastCheckAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), 20_000);
    setTimeout(() => this.check(), 2500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check(now = new Date()) {
    if (this.checking) return [];
    this.checking = true;
    this.lastCheckAt = now.toISOString();
    const fired = [];
    try {
      const tasks = this.store.state.tasks.filter((t) => t.status === 'pending');
      for (const task of tasks) {
        const due = new Date(task.dueAt).getTime();
        if (!Number.isFinite(due)) continue;
        const offsets = Array.isArray(task.reminderOffsets) ? task.reminderOffsets : [];
        const candidates = [];
        for (const offset of offsets) {
          const fireAt = due - Number(offset) * 60_000;
          const late = now.getTime() - fireAt;
          if (late < 0) continue;
          // Do not replay reminders that are more than a day stale.
          if (late > 24 * 3600_000) continue;
          if ((task.remindersSent || []).includes(reminderKey(offset, task.dueAt))) continue;
          candidates.push({ offset, fireAt, late });
        }
        if (!candidates.length) continue;
        candidates.sort((a, b) => a.late - b.late);
        const chosen = candidates[0];
        const staleKeys = candidates.slice(1).map((c) => reminderKey(c.offset, task.dueAt));
        if (staleKeys.length) this.store.markRemindersSent(task.id, staleKeys);
        this.store.markRemindersSent(task.id, [reminderKey(chosen.offset, task.dueAt)]);
        this.store.state.metrics.totalReminders += 1;
        const silent = inQuietHours(this.store.state.settings, now) || !this.store.state.settings.sound;
        const payload = {
          taskId: task.id,
          title: task.title,
          course: task.course,
          category: task.category,
          priority: task.priority,
          dueAt: task.dueAt,
          offset: chosen.offset,
          lateMinutes: Math.max(0, Math.round(chosen.late / 60_000)),
          silent,
          firedAt: now.toISOString()
        };
        this.telemetry.log('reminder_fired', {
          meta: {
            offset_min: chosen.offset,
            late_min: payload.lateMinutes,
            silent,
            category: task.category
          }
        });
        fired.push(payload);
        try { this.onFire(payload); } catch (err) {
          this.telemetry.log('reminder_dispatch_error', { ok: false, error: err });
        }
      }
    } finally {
      this.checking = false;
    }
    return fired;
  }

  /** Suppress every outstanding reminder for a task (user closed the popup). */
  dismiss(taskId) {
    const task = this.store.state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const keys = (task.reminderOffsets || []).map((offset) => reminderKey(offset, task.dueAt));
    this.store.markRemindersSent(taskId, keys);
  }
}

module.exports = { ReminderScheduler, inQuietHours, reminderKey };
