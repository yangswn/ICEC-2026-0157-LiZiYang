'use strict';
const fs = require('fs');
const p = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/desktop/MainForm.cs';
let s = fs.readFileSync(p, 'utf8');

const from = [
  '            catch (Exception ex)',
  '            {',
  '                MessageBox.Show(this, "课铃启动失败：\\n" + ex.Message + "\\n\\n日志目录：" + Path.Combine(dataDir, "process_logs"),',
  '                    "课铃 ClassBell", MessageBoxButtons.OK, MessageBoxIcon.Error);',
  '                exiting = true;',
  '                Close();',
  '            }'
].join('\n');

const to = [
  '            catch (Exception ex)',
  '            {',
  '                // Most "it will not start on my PC" reports are a missing',
  '                // WebView2 Runtime. In that case the UI is still usable in a',
  '                // normal browser, so fall back instead of refusing to run.',
  '                if (LooksLikeMissingWebView2(ex) && port > 0)',
  '                {',
  '                    ShowBrowserFallback(ex);',
  '                    return;',
  '                }',
  '                MessageBox.Show(this, "课铃启动失败：\\n" + ex.Message + "\\n\\n日志目录：" + Path.Combine(dataDir, "process_logs"),',
  '                    "课铃 ClassBell", MessageBoxButtons.OK, MessageBoxIcon.Error);',
  '                exiting = true;',
  '                Close();',
  '            }'
].join('\n');

if (!s.includes(from)) throw new Error('startup catch block not found');
s = s.replace(from, to);

const anchor = '        private int FindFreePort()';
const helpers = [
  '        private static bool LooksLikeMissingWebView2(Exception ex)',
  '        {',
  '            string text = (ex.GetType().Name + " " + ex.Message + " " + (ex.InnerException != null ? ex.InnerException.Message : "")).ToLowerInvariant();',
  '            return text.Contains("webview2") || text.Contains("corewebview2") || text.Contains("edge runtime")',
  '                || text.Contains("not installed") || text.Contains("0x80070002");',
  '        }',
  '',
  '        /// <summary>',
  '        /// Without the WebView2 Runtime the embedded browser cannot start, but the',
  '        /// local service already works. Open it in the default browser so the user',
  '        /// still gets tasks, reminders in-app and logs, and tell them how to fix it.',
  '        /// </summary>',
  '        private void ShowBrowserFallback(Exception ex)',
  '        {',
  '            try',
  '            {',
  '                if (webView != null) { Controls.Remove(webView); webView.Dispose(); webView = null; }',
  '                if (splash != null) { splash.Text = "当前电脑缺少 WebView2 运行时\\r\\n已用默认浏览器打开课铃"; }',
  '                ShowInTaskbar = true;',
  '                Show();',
  '                WindowState = FormWindowState.Normal;',
  '                Activate();',
  '            }',
  '            catch { }',
  '            try { Process.Start("http://127.0.0.1:" + port + "/"); } catch { }',
  '            MessageBox.Show(this,',
  '                "这台电脑没有 Microsoft Edge WebView2 运行时，课铃的内嵌窗口无法启动。\\n\\n"',
  '                + "已用默认浏览器打开课铃，任务、提醒设置和日志都可以正常使用。\\n\\n"',
  '                + "要恢复桌面弹窗提醒，请安装 WebView2 运行时后重新打开课铃：\\n"',
  '                + "https://developer.microsoft.com/microsoft-edge/webview2/\\n\\n"',
  '                + "错误信息：" + ex.Message,',
  '                "课铃 ClassBell · 缺少 WebView2 运行时", MessageBoxButtons.OK, MessageBoxIcon.Warning);',
  '            SafeLog("webview2 unavailable, browser fallback on port " + port + ": " + ex.Message);',
  '        }',
  '',
  anchor
].join('\n');

if (!s.includes(anchor)) throw new Error('FindFreePort anchor not found');
s = s.replace(anchor, helpers);

fs.writeFileSync(p, s, 'utf8');
console.log('webview2 fallback added');
