'use strict';

/**
 * 单实例锁的自动化测试（真实进程、真实命名互斥体）。
 *
 * 背景：两个课铃实例共用同一个 WebView2 用户数据目录
 * （%APPDATA%\ClassBell\WebView2），该目录同一时间只能被一组进程独占；
 * 第二个实例初始化 WebView2 会直接 E_ABORT。
 * 修复：在 WebView2 初始化之前先抢 `Local\ClassBell.SingleInstance`。
 *
 * 测试用两个独立进程：
 *   A: --self-test-hold <readyFile> [ms]  占住互斥体
 *   B: --self-test-try  <outFile>         尝试抢占并写出 createdNew
 * 断言 B 拿不到锁 —— 即“第二次获取 Mutex 失败”这条分支生效。
 *
 * 说明：
 *  - 结果文件放在仓库内的 .test-tmp/：受限沙箱下子进程可能无法写系统 %TEMP%；
 *  - 轮询用异步 setTimeout，不要用忙等（会把子进程饿死，导致结果文件迟迟不出现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

function findHostExe() {
  // 先用刚编译的宿主：dist 里的打包产物可能是旧构建，缺少 --self-test-* 诊断模式
  const candidates = [
    path.join(repoRoot, 'desktop', 'ClassBell.exe'),
    path.join(repoRoot, 'dist', 'ClassBell', 'ClassBell.exe')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const hostExe = findHostExe();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForText(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) return text;
      }
    } catch (_) { /* 可能正在写 */ }
    await wait(120);
  }
  return null;
}

test('second instance cannot acquire the single-instance mutex',
  { skip: hostExe ? false : 'ClassBell.exe 未编译（先跑 scripts/build-desktop.ps1）' },
  async () => {
    const workDir = path.join(repoRoot, '.test-tmp', 'mutex-' + Date.now());
    fs.mkdirSync(workDir, { recursive: true });
    const readyFile = path.join(workDir, 'ready.json');
    const outFile = path.join(workDir, 'try.json');

    // 用独立的锁名：本机可能正开着课铃，测试不能依赖“真实锁此刻空闲”
    const mutexName = 'Local\\ClassBell.SingleInstance.Test' + process.pid;
    const holder = spawn(hostExe, ['--self-test-hold', readyFile, '15000', '--mutex=' + mutexName], {
      windowsHide: true,
      stdio: 'ignore'
    });

    try {
      const ready = await waitForText(readyFile, 8000);
      assert.ok(ready, `持有者没有写出 ready 文件（pid=${holder.pid}）`);
      assert.equal(JSON.parse(ready).createdNew, true, '第一个进程本应成为唯一持有者');

      const attempt = spawnSync(hostExe, ['--self-test-try', outFile, '--mutex=' + mutexName], {
        timeout: 20000,
        windowsHide: true
      });
      assert.equal(attempt.status, 0, `尝试进程异常退出：${attempt.stderr || attempt.error || ''}`);

      const raw = await waitForText(outFile, 5000);
      assert.ok(raw, '尝试进程没有写出结果文件');
      const payload = JSON.parse(raw);

      // 这就是 E_ABORT 修复的关键分支
      assert.equal(payload.createdNew, false, '第二个实例本应拿不到互斥体');
      assert.equal(payload.error, '', '拿不到互斥体不应抛异常');
    } finally {
      try { holder.kill(); } catch (_) { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

test('mutex is acquired before WebView2 starts (so no E_ABORT first)', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'desktop', 'Program.cs'), 'utf8');

  assert.ok(source.includes('Local\\ClassBell.SingleInstance'),
    '互斥体名字必须是 Local\\ClassBell.SingleInstance');

  const mutexAt = source.indexOf('new Mutex(true, MutexName');
  const runAt = source.indexOf('Application.Run(new MainForm');
  assert.ok(mutexAt > 0 && runAt > 0, '未找到互斥体或 Application.Run');
  assert.ok(mutexAt < runAt, '互斥体必须在 WebView2 初始化之前获取');

  assert.ok(source.includes('ShowAlreadyRunning'), '缺少“已在运行”的人话提示');
  assert.ok(source.includes('--allow-multi'), '应保留 --allow-multi 逃生通道');
});

test('uninstaller keeps user data by default when run silently', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'installer', 'Uninstaller.cs'), 'utf8');
  assert.ok(source.includes('bool keepData = true'), '静默卸载必须默认保留用户数据');
  assert.ok(source.includes('if (!keepData)'), '只有明确选择才删除数据目录');
  assert.ok(source.includes('/KEEPDIR'), '卸载器应支持 /KEEPDIR 供安装器接管目录清理');
});
