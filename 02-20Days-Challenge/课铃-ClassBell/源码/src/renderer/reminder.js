'use strict';

const api = window.campus;
const $ = (s) => document.querySelector(s);

let payload = null;
let countTimer = null;
let chimePlayed = false;

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDue(iso) {
  const d = new Date(iso);
  const months = d.getMonth() + 1;
  const days = d.getDate();
  return `${months}月${days}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function countdown(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const late = diff < 0;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  let core;
  if (days >= 1) core = `${days} 天 ${hours} 小时`;
  else if (hours >= 1) core = `${hours} 小时 ${minutes} 分`;
  else if (minutes >= 1) core = `${minutes} 分 ${seconds} 秒`;
  else core = `${seconds} 秒`;
  return late ? `已超时 ${core}` : `剩余 ${core}`;
}

function kickerFor(p) {
  if (p.preview) return '提醒预览';
  if (p.snoozed) return '稍后提醒';
  const diff = new Date(p.dueAt).getTime() - Date.now();
  if (diff < 0) return '截止时间已过';
  if (diff < 60 * 60 * 1000) return `距离截止还有 ${Math.max(1, Math.ceil(diff / 60000))} 分钟`;
  if (diff < 24 * 60 * 60 * 1000) return `距离截止还有 ${Math.max(1, Math.ceil(diff / 3600000))} 小时`;
  return `距离截止还有 ${Math.max(1, Math.ceil(diff / 86400000))} 天`;
}

function render(p) {
  payload = p;
  document.title = `课铃提醒 · ${p.title || '任务'}`;
  $('#r-kicker').textContent = kickerFor(p);
  $('#r-course').textContent = p.course || (p.category === 'exam' ? '考试提醒' : '课程任务');
  $('#r-title').textContent = p.title || '任务提醒';
  $('#r-due').textContent = `截止 ${fmtDue(p.dueAt)}`;
  $('#r-count').textContent = countdown(p.dueAt);
  $('#r-actions').style.display = 'flex';

  if (p.preview) {
    $('#r-kicker').textContent = '提醒预览';
    $('#r-snooze').hidden = true;
    $('#r-done').hidden = true;
    $('#r-open').textContent = '知道了';
    $('#r-hint').textContent = '这是测试弹窗 · 按 Esc 关闭';
  } else {
    $('#r-snooze').hidden = false;
    $('#r-done').hidden = false;
    $('#r-open').textContent = '查看任务';
    $('#r-hint').textContent = '按 Esc 关闭 · 稍后仍会提醒';
  }

  if (!p.silent) playChime();
  if (countTimer) clearInterval(countTimer);
  countTimer = setInterval(() => {
    if (payload) $('#r-count').textContent = countdown(payload.dueAt);
  }, 1000);
}

function playChime() {
  if (chimePlayed) return;
  chimePlayed = true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime + 0.03;
    const notes = [
      { f: 523.25, t: 0, d: 0.42 },
      { f: 659.25, t: 0.16, d: 0.42 },
      { f: 783.99, t: 0.34, d: 0.62 }
    ];
    const master = ctx.createGain();
    master.gain.value = 0.075;
    master.connect(ctx.destination);
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.f;
      gain.gain.setValueAtTime(0.0001, now + note.t);
      gain.gain.exponentialRampToValueAtTime(1, now + note.t + 0.028);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.t + note.d);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + note.t);
      osc.stop(now + note.t + note.d + 0.05);
    }
    setTimeout(() => ctx.close().catch(() => {}), 1400);
  } catch (_) { /* sound is optional */ }
}

function act(action, minutes) {
  if (!payload) { window.close(); return; }
  if (payload.preview) {
    api.reminderAction('close', '', 0).catch(() => {});
    return;
  }
  api.reminderAction(action, payload.taskId, minutes || 0, payload.firedAt).catch(() => {});
}

$('#r-close').addEventListener('click', () => act('close'));
$('#r-snooze').addEventListener('click', () => act('snooze', 10));
$('#r-open').addEventListener('click', () => act('open'));
$('#r-done').addEventListener('click', () => act('done'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); act('close'); }
  if (event.key === 'Enter' && !event.target.closest('button')) { event.preventDefault(); act('open'); }
});

api.onReminderData((data) => render(data));

try {
  const raw = new URLSearchParams(location.search).get('data');
  if (raw) render(JSON.parse(raw));
} catch (_) { /* wait for host message */ }
