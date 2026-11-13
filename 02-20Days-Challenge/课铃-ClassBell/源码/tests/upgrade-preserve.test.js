'use strict';

/**
 * 升级必须保住用户数据（任务 / 日志 / cookie）。
 *
 * 背景：1.4.0 第一版“先卸旧版”有缺陷 —— 旧卸载器的延迟 rmdir 把刚装好的
 * 文件和 portable 的 data\ 一起删了，导致任务、日志、登录态全部丢失。
 *
 * 现在安装器的硬约束：
 *   1) 备份 <安装目录>\data 与 %APPDATA%\ClassBell 关键文件；
 *   2) 备份后校验（文件数 + 字节数），不一致就抛异常中止安装，绝不先删后装；
 *   3) 装完恢复缺失的一份并校验；
 *   4) 备份目录保留（滚动留最近 2 份），事后还能手工找回。
 *
 * 这里用代码契约测试锁住这些约束，防止以后被改回去。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'installer', 'Setup.cs'), 'utf8');

test('installer backs up user data before overwriting files', () => {
  // 1) 备份能力存在于 PrepareOverwrite 内部
  const prepareDefAt = setupSource.indexOf('private static string PrepareOverwrite');
  const prepareBlock = setupSource.slice(prepareDefAt, prepareDefAt + 1800);
  assert.ok(prepareBlock.includes('return PreserveUserData(dir);'), 'PrepareOverwrite 必须调用备份');

  // 2) 运行顺序：InstallCore 内先 PrepareOverwrite，再解压覆盖
  const installAt = setupSource.indexOf('internal static void InstallCore');
  const prepareCallAt = setupSource.indexOf('PrepareOverwrite(dir, progress)', installAt);
  const extractCallAt = setupSource.indexOf('ExtractFileWithRetry(entry, target);', installAt);
  assert.ok(prepareCallAt > installAt, 'InstallCore 必须先做备份准备');
  assert.ok(extractCallAt > prepareCallAt, '备份必须在解压覆盖之前完成');
});

test('backup is verified and aborts installation on mismatch', () => {
  assert.ok(setupSource.includes('CopyTreeVerified'), '备份必须带校验');
  assert.ok(setupSource.includes('MeasureTree'), '校验需要统计文件数与字节数');

  // 校验失败必须抛异常（中止安装），而不是只记日志继续
  assert.ok(
    setupSource.includes('备份现有数据失败') || setupSource.includes('已中止安装'),
    '校验失败必须中止安装并给出人话提示'
  );
  const throwOnPortable = /if \(!CopyTreeVerified\(portableData[\s\S]{0,200}throw new Exception/.test(setupSource);
  assert.ok(throwOnPortable, '便携数据校验失败时应 throw');
});

test('logs and cookies are part of the preserved set', () => {
  // 关键文件清单里必须有 cookie；日志目录必须单独复制
  assert.ok(setupSource.includes('cx-cookies.json'), '备份清单必须包含 cx-cookies.json（登录态）');
  assert.ok(setupSource.includes('process_logs'), '备份必须包含 process_logs（运行日志）');
  assert.ok(setupSource.includes('WebView2') || setupSource.includes('install-data'),
    '便携模式应整目录备份（含 WebView2 登录数据）');
});

test('restore runs after extraction and keeps the backup for recovery', () => {
  const restoreCallAt = setupSource.indexOf('RestoreUserData(dir, preservedData)');
  const extractAt = setupSource.indexOf('ExtractFileWithRetry(entry, target);');
  assert.ok(restoreCallAt > extractAt, '恢复必须在解压之后');

  // 不再“装完就删备份”，而是滚动保留最近 2 份
  assert.ok(setupSource.includes('PruneOldBackups'), '应有备份滚动清理');
  assert.ok(!/RestorePreservedData[\s\S]{0,400}Directory\.Delete\(backup, true\)/.test(setupSource),
    '恢复后不应立刻删除备份目录');
});

test('uninstaller never deletes %APPDATA%\\ClassBell in silent mode', () => {
  const uninstaller = fs.readFileSync(path.join(repoRoot, 'installer', 'Uninstaller.cs'), 'utf8');
  assert.ok(uninstaller.includes('bool keepData = true'), '静默卸载必须默认保留数据');
  assert.ok(uninstaller.includes('if (!keepData)'), '只有明确选择才删除数据目录');
});
