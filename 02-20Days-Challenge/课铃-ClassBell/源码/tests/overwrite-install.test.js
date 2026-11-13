'use strict';

/**
 * 覆盖安装（overwrite install）的契约测试。
 *
 * 背景：1.4.x 走“先卸旧版再装”，结果旧卸载器的延迟 rmdir 与新解压撞车，
 * 把刚装好的文件连同 data\ 一起删了（2026-11-13 真实事故）；卸载与重装之间
 * 还有空窗，中途失败就是“软件没了”。
 *
 * 1.5.0 改成标准覆盖安装：不调用 Uninstall.exe、不删目录、不等待、不睡觉，
 * 直接解压覆盖，并给单文件覆盖加三层保护。
 *
 * 这些断言用于防止流程被改回“先卸载”。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'installer', 'Setup.cs'), 'utf8');

test('installer no longer uninstalls the old version', () => {
  assert.ok(!setupSource.includes('UninstallPrevious'), '不应再有 UninstallPrevious');
  assert.ok(!setupSource.includes('WaitForDirectoryRemoved'), '不应再删目录并轮询等待');
  assert.ok(!setupSource.includes('Thread.Sleep(2500)'), '不应再有“等延迟删除”的 2.5 秒睡眠');
  // 安装器不应执行卸载器（shortcut 指向 Uninstall.exe 是允许的，执行才是问题）
  assert.ok(!/FileName\s*=\s*uninstaller/.test(setupSource), '不应把卸载器作为进程启动');
});

test('version check is kept but only decides overwrite vs fresh', () => {
  const i = setupSource.indexOf('private static string PrepareOverwrite');
  assert.ok(i > 0, '缺少 PrepareOverwrite');
  const block = setupSource.slice(i, i + 1600);
  assert.ok(block.includes('ReadInstalledVersion'), '仍要读取已安装版本');
  assert.ok(block.includes('overwrite in place') || block.includes('by overwrite'),
    '同版本/升级都应走覆盖路径');
});

test('process closing logic from 1.3.9 is untouched', () => {
  assert.ok(setupSource.includes('EnsureNoRunningInstances'), '必须保留关闭旧进程的步骤');
  assert.ok(setupSource.includes('FindRunningInstances'), '按路径识别进程的逻辑要保留');
  const installAt = setupSource.indexOf('EnsureNoRunningInstances(dir, progress)');
  const prepareAt = setupSource.indexOf('PrepareOverwrite(dir, progress)');
  assert.ok(installAt > 0 && prepareAt > installAt, '先关进程，再做备份');
});

test('data backup still happens before overwriting', () => {
  const prepareAt = setupSource.indexOf('private static string PrepareOverwrite');
  const preserveCallAt = setupSource.indexOf('PreserveUserData(dir);', prepareAt);
  assert.ok(preserveCallAt > prepareAt, '覆盖前仍要备份用户数据');
  assert.ok(setupSource.includes('CopyTreeVerified'), '备份要校验');
  assert.ok(setupSource.includes('cx-cookies.json'), '备份必须包含登录 cookie');
  assert.ok(setupSource.includes('process_logs'), '备份必须包含运行日志');
});

test('overwrite extraction has three layers of protection', () => {
  assert.ok(setupSource.includes('ExtractFileWithRetry'), '覆盖要经过带重试的辅助函数');

  const i = setupSource.indexOf('private static void ExtractFileWithRetry');
  assert.ok(i > 0, '缺少 ExtractFileWithRetry');
  const block = setupSource.slice(i, i + 1600);

  // 1) 清只读属性
  assert.ok(block.includes('FileAttributes.ReadOnly'), '应清理只读属性');
  assert.ok(block.includes('SetAttributes'), '应重设文件属性');
  // 2) 重试
  assert.ok(block.includes('catch (IOException'), '只对 IO 异常重试');
  assert.ok(block.includes('Thread.Sleep(300)'), '重试间隔 300ms');
  assert.ok(/attempt\s*>=\s*5/.test(block), '最多 5 次');
  // 3) 失败中止并报路径
  assert.ok(block.includes('throw new Exception'), '5 次失败必须抛异常中止');
  assert.ok(block.includes('target'), '异常里要带文件路径');
});

test('uninstaller is still shipped for manual uninstall', () => {
  // 安装器不调用它，但用户主动卸载仍走 Uninstall.exe
  const uninstaller = fs.readFileSync(path.join(repoRoot, 'installer', 'Uninstaller.cs'), 'utf8');
  assert.ok(uninstaller.includes('/S'), '卸载器仍支持静默');
  assert.ok(uninstaller.includes('bool keepData = true'), '静默卸载默认保留数据');
});
