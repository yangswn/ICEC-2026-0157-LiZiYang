'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const p = root + 'server/store.js';
let s = fs.readFileSync(p, 'utf8');
const done = [];
function rep(from, to, label) {
  if (!s.includes(from)) { console.log('MISS:', label); return; }
  s = s.split(from).join(to);
  done.push(label);
}

/* ---- P1-5: editing a task must not re-fire reminders already sent ---- */
rep(
`  if (task.dueAt !== base.dueAt) task.remindersSent = [];
  if (input.reminderOffsets) task.remindersSent = [];
  return task;`,
`  if (task.dueAt !== base.dueAt) {
    task.remindersSent = [];
  } else if (input.reminderOffsets) {
    // Keep the reminder keys that are still valid for the remaining offsets,
    // otherwise editing a note re-arms every reminder that already fired.
    const valid = new Set(task.reminderOffsets.map((o) => \`o\${o}@\${task.dueAt}\`));
    task.remindersSent = (task.remindersSent || []).filter((k) => valid.has(k));
  }
  return task;`,
'remindersSent preservation'
);

/* ---- P1-7: validate quiet hours range and coerce booleans strictly ---- */
rep(
`      } else if (key === 'quietHours') {
        const q = patch[key] || {};
        next.quietHours = {
          enabled: Boolean(q.enabled),
          start: /^\\d{2}:\\d{2}$/.test(q.start) ? q.start : '23:00',
          end: /^\\d{2}:\\d{2}$/.test(q.end) ? q.end : '07:00'
        };`,
`      } else if (key === 'quietHours') {
        const q = patch[key] || {};
        const TIME_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;
        next.quietHours = {
          enabled: q.enabled === true || q.enabled === 'true',
          start: TIME_RE.test(q.start || '') ? q.start : (next.quietHours.start || '23:00'),
          end: TIME_RE.test(q.end || '') ? q.end : (next.quietHours.end || '07:00')
        };`,
'quiet hours validation'
);

rep(
`      } else {
        next[key] = Boolean(patch[key]);
      }`,
`      } else {
        // "false" (string) used to sneak in as true; only accept real booleans.
        next[key] = patch[key] === true || patch[key] === 'true';
      }`,
'boolean coercion'
);

/* ---- P1-6: import restores settings and de-duplicates by sourceKey ---- */
rep(
`    const existing = new Map(this.state.tasks.map((t) => [t.id, t]));
    for (const task of valid) {
      if (existing.has(task.id)) task.id = uid('t_');
      existing.set(task.id, task);
    }
    this.state.tasks = [...existing.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt));`,
`    const knownKeys = new Set(this.state.tasks.map((t) => t.sourceKey).filter(Boolean));
    const knownSignatures = new Set(this.state.tasks.map((t) => \`\${t.title}::\${t.dueAt}\`));
    const stats = { imported: 0, skipped: 0 };
    for (const task of valid) {
      if (task.sourceKey && knownKeys.has(task.sourceKey)) { stats.skipped += 1; continue; }
      const signature = \`\${task.title}::\${task.dueAt}\`;
      if (knownSignatures.has(signature)) { stats.skipped += 1; continue; }
      if (this.state.tasks.some((t) => t.id === task.id)) task.id = uid('t_');
      this.state.tasks.push(task);
      if (task.sourceKey) knownKeys.add(task.sourceKey);
      knownSignatures.add(signature);
      stats.imported += 1;
    }
    this.state.tasks.sort((a, b) => a.dueAt.localeCompare(b.dueAt));`,
'import dedupe'
);

rep(
`    this.scheduleSave();
    return { imported: valid.length, total: this.state.tasks.length };
  }`,
`    // A backup carries settings; restoring them is what users expect.
    if (parsed.settings && typeof parsed.settings === 'object') {
      try { this.updateSettings(parsed.settings); } catch (_) { /* ignore bad settings */ }
    }
    this.scheduleSave();
    return { imported: stats.imported, skipped: stats.skipped, total: this.state.tasks.length };
  }`,
'import settings'
);

fs.writeFileSync(p, s, 'utf8');
console.log('applied:', done.join(', '));
