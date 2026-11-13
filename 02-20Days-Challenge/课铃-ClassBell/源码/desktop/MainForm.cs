using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace ClassBell
{
    internal sealed class MainForm : Form
    {
        private readonly string appDir;
        private readonly string dataDir;
        private readonly bool startHidden;
        private WebView2 webView;
        private Label splash;
        private Process backend;
        private StreamWriter backendLog;
        private NotifyIcon tray;
        private ToolStripMenuItem pendingItem;
        private ToolStripMenuItem autoLaunchItem;
        private System.Windows.Forms.Timer reminderTimer;
        private System.Windows.Forms.Timer statusTimer;
        private Queue<Dictionary<string, object>> reminderQueue = new Queue<Dictionary<string, object>>();
        private ReminderForm reminderForm;
        private LoginForm loginForm;
        private bool exiting;
        private bool closeToTray = true;
        // 是否已经给用户解释过“点 × 只是隐藏到托盘”（存服务端设置，只弹一次）
        private bool closeHintShown;
        // 是否已经弹过托盘气泡（只弹一次）
        private bool trayHintShown;
        // 保持引用，避免 Timer 被 GC 回收后托盘图标不再刷新
        private System.Windows.Forms.Timer trayPromoteTimer;
        // 托盘图标对象必须长期持有，否则 GC 后托盘会显示空白或消失
        private Icon trayIcon;
        // 轻提示每个会话只弹一次
        private bool trayToastShown;
        private System.Windows.Forms.Timer trayKeepAliveTimer;
        private bool settingsLoaded;
        private bool pollingReminders;
        private int port;
        private EventWaitHandle showEvent;

        public CoreWebView2Environment WebViewEnvironment { get; private set; }

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string message);

        private static readonly int ShowMessage = RegisterWindowMessage("ClassBell.ShowWindow");

        private const int HotKeyId = 0x4B1;
        private const int WmHotKey = 0x0312;
        private bool hotKeyRegistered;

        /// <summary>
        /// 注意：这里故意 **不** 再按 DPI 缩放。
        /// WebView2 已经跟随系统 DPI 渲染（150% 时自动放大），
        /// 之前又乘了 96/dpi 做一次补偿，等于把页面缩回去，
        /// 小数缩放会把文字渲染发虚 —— 这就是用户反馈“页面很糊”的原因。
        /// 字号大小交给用户在“界面大小”里选择。
        /// </summary>
        private void ApplyDpiZoom()
        {
            if (webView != null) webView.ZoomFactor = 1.0;
        }

        public MainForm(bool hidden)
        {
            startHidden = hidden;
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            dataDir = ResolveDataDir();
            Text = "课铃 ClassBell";
            StartPosition = FormStartPosition.CenterScreen;
            Width = 1280;
            Height = 860;
            MinimumSize = new Size(1040, 700);
            BackColor = Color.FromArgb(243, 240, 231);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
            RestoreWindowState();
            try { Icon = new Icon(Path.Combine(appDir, "assets", "icon.ico")); } catch { }

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(243, 240, 231);
            Controls.Add(webView);

            splash = new Label();
            splash.Dock = DockStyle.Fill;
            splash.Text = "课铃正在启动…";
            splash.TextAlign = ContentAlignment.MiddleCenter;
            splash.Font = new Font("Microsoft YaHei UI", 13F);
            splash.ForeColor = Color.FromArgb(90, 100, 92);
            splash.BackColor = Color.FromArgb(243, 240, 231);
            Controls.Add(splash);
            splash.BringToFront();

            CreateTray();
            try
            {
                showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "ClassBell.ShowWindow");
                var waiter = new Thread(() =>
                {
                    while (true)
                    {
                        try
                        {
                            showEvent.WaitOne();
                            BeginInvoke(new Action(ShowMain));
                        }
                        catch { break; }
                    }
                });
                waiter.IsBackground = true;
                waiter.Start();
            }
            catch { }
            Shown += async (s, e) => await StartAsync();
            FormClosing += OnFormClosing;
            Resize += (s, e) => { if (WindowState == FormWindowState.Minimized && closeToTray) HideToTray(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                hotKeyRegistered = RegisterHotKey(Handle, HotKeyId, 0x0002 | 0x0001, (uint)Keys.B);
            }
            catch { }
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            if (hotKeyRegistered)
            {
                try { UnregisterHotKey(Handle, HotKeyId); } catch { }
                hotKeyRegistered = false;
            }
            base.OnHandleDestroyed(e);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmHotKey && m.WParam.ToInt32() == HotKeyId)
            {
                ShowMain();
                return;
            }
            if (m.Msg == ShowMessage)
            {
                ShowMain();
                return;
            }
            base.WndProc(ref m);
        }

        private string ResolveDataDir()
        {
            string portable = Path.Combine(appDir, "data");
            if (File.Exists(Path.Combine(portable, "data.json"))) return portable;
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ClassBell");
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return dir;
            }
            catch
            {
                // Some locked-down Windows profiles deny %APPDATA%. Fall back
                // to a portable data folder next to the executable.
                string fallback = Path.Combine(appDir, "data");
                Directory.CreateDirectory(fallback);
                return fallback;
            }
        }

        private async Task StartAsync()
        {
            if (startHidden)
            {
                ShowInTaskbar = false;
                Hide();
            }
            try
            {
                port = FindFreePort();
                HostApi.Port = port;
                StartBackend();
                bool ready = await WaitForHealthAsync();
                if (!ready) throw new Exception("本地服务未能在限定时间内启动。");
                await InitializeWebViewAsync();
                if (tray != null) tray.Visible = true;
                await RestoreLoginAsync();
                await LoadSettingsOnceAsync();
                StartTimers();
                await PollStatusAsync();
                ShowTrayHintOnce();
                // Explorer 可能要过一会儿才登记托盘项，启动后多试几次
                trayPromoteTimer = new System.Windows.Forms.Timer { Interval = 4000 };
                int promoteTries = 0;
                trayPromoteTimer.Tick += (s2, e2) =>
                {
                    PromoteTrayIcon();
                    promoteTries += 1;
                    if (promoteTries >= 4) trayPromoteTimer.Stop();
                };
                trayPromoteTimer.Start();
                // Explorer 崩溃/重启会让所有托盘图标消失，定时补回一次。
                var trayKeepAlive = new System.Windows.Forms.Timer { Interval = 30000 };
                trayKeepAlive.Tick += (s3, e3) =>
                {
                    try
                    {
                        if (tray != null && !tray.Visible) tray.Visible = true;
                        PromoteTrayIcon();
                    }
                    catch { }
                };
                trayKeepAlive.Start();
                trayKeepAliveTimer = trayKeepAlive;
                PromoteTrayIcon();
            }
            catch (Exception ex)
            {
                // Most "it will not start on my PC" reports are a missing
                // WebView2 Runtime. In that case the UI is still usable in a
                // normal browser, so fall back instead of refusing to run.
                if (LooksLikeMissingWebView2(ex) && port > 0)
                {
                    ShowBrowserFallback(ex);
                    return;
                }
                MessageBox.Show(this, "课铃启动失败：\n" + ex.Message + "\n\n日志目录：" + Path.Combine(dataDir, "process_logs"),
                    "课铃 ClassBell", MessageBoxButtons.OK, MessageBoxIcon.Error);
                exiting = true;
                Close();
            }
        }

        private static bool LooksLikeMissingWebView2(Exception ex)
        {
            string text = (ex.GetType().Name + " " + ex.Message + " " + (ex.InnerException != null ? ex.InnerException.Message : "")).ToLowerInvariant();
            return text.Contains("webview2") || text.Contains("corewebview2") || text.Contains("edge runtime")
                || text.Contains("not installed") || text.Contains("0x80070002");
        }

        /// <summary>
        /// Without the WebView2 Runtime the embedded browser cannot start, but the
        /// local service already works. Open it in the default browser so the user
        /// still gets tasks, reminders in-app and logs, and tell them how to fix it.
        /// </summary>
        private void ShowBrowserFallback(Exception ex)
        {
            try
            {
                if (webView != null) { Controls.Remove(webView); webView.Dispose(); webView = null; }
                if (splash != null) { splash.Text = "当前电脑缺少 WebView2 运行时\r\n已用默认浏览器打开课铃"; }
                ShowInTaskbar = true;
                Show();
                WindowState = FormWindowState.Normal;
                Activate();
            }
            catch { }
            try { Process.Start("http://127.0.0.1:" + port + "/"); } catch { }
            MessageBox.Show(this,
                "这台电脑没有 Microsoft Edge WebView2 运行时，课铃的内嵌窗口无法启动。\n\n"
                + "已用默认浏览器打开课铃，任务、提醒设置和日志都可以正常使用。\n\n"
                + "要恢复桌面弹窗提醒，请安装 WebView2 运行时后重新打开课铃：\n"
                + "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
                + "错误信息：" + ex.Message,
                "课铃 ClassBell · 缺少 WebView2 运行时", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            SafeLog("webview2 unavailable, browser fallback on port " + port + ": " + ex.Message);
        }

        private int FindFreePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int value = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return value;
        }

        private string ResolveNode()
        {
            string local = Path.Combine(appDir, "runtime", "node.exe");
            if (File.Exists(local)) return local;
            return "node.exe";
        }

        private void StartBackend()
        {
            string server = Path.Combine(appDir, "server", "server.js");
            if (!File.Exists(server)) throw new Exception("缺少本地服务文件：" + server);
            backendLog = new StreamWriter(Path.Combine(dataDir, "server.log"), true);
            backendLog.AutoFlush = true;
            var psi = new ProcessStartInfo(ResolveNode());
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = appDir;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.Arguments = "\"" + server + "\" --port=" + port + " --data-dir=\"" + dataDir + "\"";
            backend = new Process();
            backend.StartInfo = psi;
            backend.OutputDataReceived += (s, e) => { if (e.Data != null) SafeLog("OUT " + e.Data); };
            backend.ErrorDataReceived += (s, e) => { if (e.Data != null) SafeLog("ERR " + e.Data); };
            backend.Start();
            backend.BeginOutputReadLine();
            backend.BeginErrorReadLine();
        }

        private void SafeLog(string line)
        {
            try
            {
                lock (backendLog)
                {
                    backendLog.WriteLine(DateTime.Now.ToString("s") + " " + line);
                }
            }
            catch { }
        }

        private async Task<bool> WaitForHealthAsync()
        {
            for (int i = 0; i < 60; i++)
            {
                if (backend != null && backend.HasExited) return false;
                try
                {
                    var text = await HostApi.GetJsonAsync("/api/health");
                    return text.Contains("\"ok\":true");
                }
                catch { }
                await Task.Delay(250);
            }
            return false;
        }

        private async Task RestoreLoginAsync()
        {
            try
            {
                if (webView.CoreWebView2 == null) return;
                int injected = await InjectPersistedCookiesAsync();
                var cookies = await webView.CoreWebView2.CookieManager.GetCookiesAsync("https://i.chaoxing.com/");
                bool hasUid = false;
                var list = new List<Dictionary<string, string>>();
                foreach (var cookie in cookies)
                {
                    if (cookie.Name == "_uid" || cookie.Name == "UID" || cookie.Name == "puid") hasUid = true;
                    list.Add(new Dictionary<string, string>
                    {
                        { "name", cookie.Name },
                        { "value", cookie.Value },
                        { "domain", cookie.Domain },
                        { "path", cookie.Path }
                    });
                }
                if (!hasUid) return;
                await HostApi.PostJsonAsync("/api/cx/cookies", new Dictionary<string, object> { { "cookies", list } });
                SafeLog("restored persisted Chaoxing cookies: " + list.Count + ", injected " + injected);
            }
            catch (Exception ex)
            {
                SafeLog("restore cookies failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Chaoxing login cookies are session scoped, so WebView2 forgets them when
        /// the host exits. The backend keeps a copy; put it back before the login
        /// window opens so the user is not asked to log in again.
        /// </summary>
        private async Task<int> InjectPersistedCookiesAsync()
        {
            int injected = 0;
            try
            {
                var payload = HostApi.ParseObject(await HostApi.GetJsonAsync("/api/cx/cookies"));
                object raw;
                if (payload == null || !payload.TryGetValue("cookies", out raw) || raw == null) return 0;
                var items = raw as System.Collections.IEnumerable;
                if (items == null) return 0;
                foreach (var entry in items)
                {
                    var map = entry as Dictionary<string, object>;
                    if (map == null) continue;
                    string name = HostApi.Str(map, "name");
                    string value = HostApi.Str(map, "value");
                    string domain = HostApi.Str(map, "domain", ".chaoxing.com");
                    string path = HostApi.Str(map, "path", "/");
                    if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(value)) continue;
                    try
                    {
                        var cookie = webView.CoreWebView2.CookieManager.CreateCookie(name, value, domain, path);
                        webView.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
                        injected++;
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                SafeLog("inject cookies failed: " + ex.Message);
            }
            return injected;
        }

        private async Task InitializeWebViewAsync()
        {
            string userData = Path.Combine(dataDir, "WebView2");
            var options = new CoreWebView2EnvironmentOptions();
            string debugPort = Environment.GetEnvironmentVariable("CAMPUSPULSE_DEBUG_PORT");
            if (!string.IsNullOrWhiteSpace(debugPort))
                options.AdditionalBrowserArguments = "--remote-debugging-port=" + debugPort;
            var env = await CoreWebView2Environment.CreateAsync(null, userData, options);
            WebViewEnvironment = env;
            await webView.EnsureCoreWebView2Async(env);
            ApplyDpiZoom();
            webView.CoreWebView2.Settings.AreDevToolsEnabled = !string.IsNullOrWhiteSpace(debugPort);
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            webView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                splash.Visible = false;
                if (e.IsSuccess)
                    webView.CoreWebView2.ExecuteScriptAsync("document.body.classList.add('native-shell')");
            };
            webView.CoreWebView2.Navigate(HostApi.BaseUrl + "/");
        }

        private async Task LoadSettingsOnceAsync()
        {
            try
            {
                var root = HostApi.ParseObject(await HostApi.GetJsonAsync("/api/state"));
                // 注意层级：/api/state 返回 { state: { settings }, stats, meta }，
                // settings 在 state 节点里，不在根节点。这里曾经取错，
                // 导致一次性标记（closeHintShown / trayHintShown）每次都被读成默认值。
                var stateNode = root.ContainsKey("state") ? root["state"] as Dictionary<string, object> : null;
                var settings = (stateNode != null && stateNode.ContainsKey("settings"))
                    ? stateNode["settings"] as Dictionary<string, object>
                    : null;
                if (settings != null)
                {
                    closeToTray = HostApi.Bool(settings, "closeToTray", true);
                    closeHintShown = HostApi.Bool(settings, "closeHintShown", false);
                    trayHintShown = HostApi.Bool(settings, "trayHintShown", false);
                    SetAutoLaunch(HostApi.Bool(settings, "autoLaunch", true));
                    autoLaunchItem.Checked = HostApi.Bool(settings, "autoLaunch", true);
                }
                settingsLoaded = true;
            }
            catch { settingsLoaded = true; }
        }

        private void StartTimers()
        {
            reminderTimer = new System.Windows.Forms.Timer { Interval = 5000 };
            reminderTimer.Tick += async (s, e) => await PollRemindersAsync();
            reminderTimer.Start();
            statusTimer = new System.Windows.Forms.Timer { Interval = 30000 };
            statusTimer.Tick += async (s, e) => await PollStatusAsync();
            statusTimer.Start();
            var first = new System.Windows.Forms.Timer { Interval = 1200 };
            first.Tick += async (s, e) =>
            {
                first.Stop();
                first.Dispose();
                await PollRemindersAsync();
            };
            first.Start();
        }

        private async Task PollRemindersAsync()
        {
            if (pollingReminders || exiting) return;
            pollingReminders = true;
            try
            {
                var root = HostApi.ParseObject(await HostApi.GetJsonAsync("/api/reminders/pending"));
                var items = root.ContainsKey("items") ? root["items"] as IList : null;
                if (items != null)
                {
                    foreach (var entry in items)
                    {
                        var item = entry as Dictionary<string, object>;
                        if (item != null) reminderQueue.Enqueue(item);
                    }
                }
                ShowNextReminder();
            }
            catch { }
            finally { pollingReminders = false; }
        }

        private async Task PollStatusAsync()
        {
            try
            {
                var root = HostApi.ParseObject(await HostApi.GetJsonAsync("/api/state"));
                var stats = root.ContainsKey("stats") ? root["stats"] as Dictionary<string, object> : null;
                // settings 在 state 节点里（与 LoadSettingsOnceAsync 保持一致），
                // 这样设置页切换后，几秒内的轮询就能把新值带到宿主。
                var stateNode = root.ContainsKey("state") ? root["state"] as Dictionary<string, object> : null;
                var settings = (stateNode != null && stateNode.ContainsKey("settings"))
                    ? stateNode["settings"] as Dictionary<string, object>
                    : null;
                if (stats != null)
                {
                    int pending = 0;
                    try { pending = Convert.ToInt32(stats["pending"]); } catch { }
                    pendingItem.Text = "待完成 " + pending + " 项";
                    tray.Text = "课铃 ClassBell · " + pending + " 项待完成";
                }
                if (settings != null && settingsLoaded)
                {
                    closeToTray = HostApi.Bool(settings, "closeToTray", true);
                    closeHintShown = HostApi.Bool(settings, "closeHintShown", false);
                    trayHintShown = HostApi.Bool(settings, "trayHintShown", false);
                    autoLaunchItem.Checked = HostApi.Bool(settings, "autoLaunch", true);
                }
            }
            catch { }
        }

        private void ShowNextReminder()
        {
            if (reminderForm != null || reminderQueue.Count == 0 || exiting) return;
            var payload = reminderQueue.Dequeue();
            reminderForm = new ReminderForm(HostApi.Port, payload, this, WebViewEnvironment);
            reminderForm.FormClosed += (s, e) =>
            {
                reminderForm = null;
                BeginInvoke(new Action(ShowNextReminder));
            };
            reminderForm.Show();
        }

        public void OpenTaskFromReminder(string taskId)
        {
            ShowMain();
            try
            {
                if (webView.CoreWebView2 != null)
                    webView.CoreWebView2.ExecuteScriptAsync("window.__campusOpenTask(" + HostApi.Json.Serialize(taskId) + ")");
            }
            catch { }
        }

        public void ShowPreview()
        {
            var payload = new Dictionary<string, object>
            {
                { "taskId", "" },
                { "title", "期中大作业：课程设计报告" },
                { "course", "软件工程" },
                { "category", "homework" },
                { "priority", "important" },
                { "dueAt", DateTime.Now.AddHours(1).ToString("o") },
                { "offset", 60 },
                { "lateMinutes", 0 },
                { "silent", false },
                { "preview", true },
                { "firedAt", DateTime.Now.ToString("o") }
            };
            reminderQueue.Enqueue(payload);
            ShowNextReminder();
        }

        private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> message;
            try { message = HostApi.ParseObject(e.WebMessageAsJson); }
            catch { return; }
            if (HostApi.Str(message, "type") != "host") return;
            string id = HostApi.Str(message, "id");
            string method = HostApi.Str(message, "method");
            var argsValue = message.ContainsKey("args") ? message["args"] : null;
            var args = argsValue as object[];
            if (args == null)
            {
                var list = argsValue as IList;
                if (list != null)
                {
                    args = new object[list.Count];
                    list.CopyTo(args, 0);
                }
            }
            try
            {
                switch (method)
                {
                    case "windowAction":
                        DoWindowAction(Arg(args, 0));
                        Respond(id, true, null);
                        break;
                    case "quit":
                        Respond(id, true, null);
                        exiting = true;
                        Close();
                        break;
                    case "openLogin":
                        Respond(id, true, null);
                        ShowLogin();
                        break;
                    case "scanLoginPage":
                        {
                            // autoOpen = true 只有“用户主动点扫描”才会传；
                            // 自动扫描必须传 false，否则关掉窗口后每 6 秒又被弹出来。
                            bool autoOpen = args != null && args.Length > 0 && Convert.ToBoolean(args[0]);
                            if (loginForm == null || loginForm.IsDisposed)
                            {
                                if (autoOpen) ShowLogin();
                                Respond(id, true, new Dictionary<string, object> { { "needLogin", true } });
                                break;
                            }
                            var json = await loginForm.ReadPageTextAsync();
                            if (string.IsNullOrWhiteSpace(json))
                            {
                                Respond(id, true, new Dictionary<string, object> { { "needLogin", true } });
                                break;
                            }
                            try
                            {
                                var page = HostApi.ParseObject(json);
                                page["needLogin"] = false;
                                Respond(id, true, page);
                            }
                            catch
                            {
                                Respond(id, true, new Dictionary<string, object> { { "needLogin", true } });
                            }
                        }
                        break;
                    // 导出走宿主保存对话框：WebView2 里的 <a download> 在部分机器上
                    // 会被静默拦截，用户点了却什么都没发生。由 C# 落盘更可靠。
                    case "saveLogs":
                        Respond(id, true, await SaveExportAsync("/api/logs/export", "ClassBell-process_logs", ".jsonl", "日志文件 (*.jsonl)|*.jsonl"));
                        break;
                    case "saveData":
                        Respond(id, true, await SaveExportAsync("/api/data/export", "ClassBell-backup", ".json", "备份文件 (*.json)|*.json"));
                        break;
                    case "chooseFolder":
                        Respond(id, true, ChooseFolder());
                        break;
                    case "openPath":
                        OpenPath(Arg(args, 0));
                        Respond(id, true, null);
                        break;
                    // 设置页切换「关闭窗口时最小化到托盘」后，立刻更新宿主行为，
                    // 不必等 30 秒的状态轮询。
                    case "applyCloseToTray":
                        closeToTray = Convert.ToBoolean(args != null && args.Length > 0 ? args[0] : true);
                        Respond(id, true, null);
                        break;
                    case "setAutoLaunch":
                        bool enabled = Convert.ToBoolean(args != null && args.Length > 0 ? args[0] : false);
                        SetAutoLaunch(enabled);
                        Respond(id, true, null);
                        break;
                    case "testReminder":
                        ShowPreview();
                        Respond(id, true, null);
                        break;
                    case "openTask":
                        Respond(id, true, null);
                        OpenTaskFromReminder(Arg(args, 0));
                        break;
                    case "closeReminder":
                        Respond(id, true, null);
                        if (reminderForm != null) reminderForm.Close();
                        break;
                    case "openExternal":
                        OpenExternal(Arg(args, 0));
                        Respond(id, true, null);
                        break;
                    default:
                        Respond(id, false, new Dictionary<string, object> { { "message", "未知的本机操作" } });
                        break;
                }
            }
            catch (Exception ex)
            {
                Respond(id, false, new Dictionary<string, object> { { "message", ex.Message } });
            }
            await Task.CompletedTask;
        }

        private static string Arg(object[] args, int index)
        {
            if (args == null || args.Length <= index || args[index] == null) return "";
            return Convert.ToString(args[index]);
        }

        private void Respond(string id, bool ok, object payload)
        {
            if (webView == null || webView.CoreWebView2 == null) return;
            try
            {
                string json = payload == null ? "null" : HostApi.Json.Serialize(payload);
                string script = "window.__hostResolve(" + HostApi.Json.Serialize(id) + "," + (ok ? "true" : "false") + "," + HostApi.Json.Serialize(json) + ");";
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }

        private void DoWindowAction(string action)
        {
            if (action == "minimize") WindowState = FormWindowState.Minimized;
            else if (action == "maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            else if (action == "close") HideToTray();
        }

        /// <summary>
        /// 从本地服务取一份导出内容，弹出“另存为”后写入磁盘。
        /// 返回 { path, bytes }；用户取消时 path 为空。
        /// </summary>
        private async Task<Dictionary<string, object>> SaveExportAsync(string apiPath, string filePrefix, string extension, string filter)
        {
            string body;
            try
            {
                body = await HostApi.GetTextAsync(apiPath);
            }
            catch (Exception ex)
            {
                SafeLog("export fetch failed: " + ex.Message);
                throw new Exception("无法从本地服务获取导出内容：" + ex.Message);
            }

            string suggested = filePrefix + "-" + DateTime.Now.ToString("yyyyMMdd-HHmm") + extension;
            string target = null;
            using (var dialog = new SaveFileDialog())
            {
                dialog.Title = "保存导出文件";
                dialog.FileName = suggested;
                dialog.Filter = filter + "|所有文件 (*.*)|*.*";
                dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                dialog.OverwritePrompt = true;
                if (dialog.ShowDialog(this) == DialogResult.OK) target = dialog.FileName;
            }
            if (string.IsNullOrWhiteSpace(target))
                return new Dictionary<string, object> { { "path", "" }, { "bytes", 0 } };

            // 统一写 UTF-8 无 BOM，避免 Excel / Git 工具读出乱码
            File.WriteAllText(target, body, new UTF8Encoding(false));
            var info = new FileInfo(target);
            SafeLog("export saved: " + info.Length + " bytes");
            return new Dictionary<string, object>
            {
                { "path", target },
                { "bytes", info.Length }
            };
        }

        private string ChooseFolder()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 GitHub 仓库根目录（日志会镜像到 process_logs）";
                dialog.ShowNewFolderButton = true;
                return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : "";
            }
        }

        private void OpenPath(string path)
        {
            if (path == "__DATA__") path = dataDir;
            else if (path == "__LOGS__") path = Path.Combine(dataDir, "process_logs");
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
            Process.Start("explorer.exe", "\"" + path + "\"");
        }

        private void OpenExternal(string url)
        {
            Uri uri;
            if (Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps)
                Process.Start(url);
        }

        private void ShowLogin()
        {
            if (loginForm != null && !loginForm.IsDisposed)
            {
                loginForm.Show();
                loginForm.Activate();
                return;
            }
            loginForm = new LoginForm(dataDir, this, WebViewEnvironment);
            loginForm.FormClosed += (s, e) => loginForm = null;
            loginForm.Show(this);
        }

        private void ShowMain()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            ShowInTaskbar = true;
            Show();
            Activate();
            BringToFront();
        }

        private void HideToTray()
        {
            SaveWindowState();
            ShowInTaskbar = false;
            Hide();
            if (tray != null) tray.Visible = true;
            PromoteTrayIcon();

            // Win11 可能把图标折叠进 ^，用户看不到就会以为程序被关掉；
            // 这里给一次确定性反馈（每个会话只弹一次，避免打扰）。
            if (!trayToastShown)
            {
                trayToastShown = true;
                try
                {
                    var toast = new TrayToastForm();
                    toast.Show();
                    toast.BringToFront();
                }
                catch (Exception ex) { SafeLog("tray toast failed: " + ex.Message); }
            }
        }

        private string WindowStateFile
        {
            get { return Path.Combine(dataDir, "window.json"); }
        }

        private void RestoreWindowState()
        {
            try
            {
                if (!File.Exists(WindowStateFile)) return;
                var state = HostApi.ParseObject(File.ReadAllText(WindowStateFile));
                int x = Convert.ToInt32(state["x"]);
                int y = Convert.ToInt32(state["y"]);
                int w = Convert.ToInt32(state["w"]);
                int h = Convert.ToInt32(state["h"]);
                if (w < MinimumSize.Width || h < MinimumSize.Height) return;
                var rect = new Rectangle(x, y, w, h);
                bool visible = false;
                foreach (var screen in Screen.AllScreens)
                {
                    var overlap = Rectangle.Intersect(screen.WorkingArea, rect);
                    if (overlap.Width > 120 && overlap.Height > 80)
                    {
                        visible = true;
                        break;
                    }
                }
                if (!visible) return;
                StartPosition = FormStartPosition.Manual;
                Bounds = rect;
                if (HostApi.Bool(state, "maximized", false)) WindowState = FormWindowState.Maximized;
            }
            catch { }
        }

        private void SaveWindowState()
        {
            try
            {
                var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                var state = new Dictionary<string, object>
                {
                    { "x", bounds.X },
                    { "y", bounds.Y },
                    { "w", bounds.Width },
                    { "h", bounds.Height },
                    { "maximized", WindowState == FormWindowState.Maximized }
                };
                File.WriteAllText(WindowStateFile, HostApi.Json.Serialize(state));
            }
            catch { }
        }

        private void CreateTray()
        {
            // 优先用 exe 内嵌图标：不依赖文件、句柄最稳。
            Icon icon = null;
            try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }
            if (icon == null)
            {
                try { icon = new Icon(Path.Combine(appDir, "assets", "icon.ico"), 16, 16); }
                catch { }
            }
            if (icon == null) icon = SystemIcons.Application;
            // 存到字段，防止被 GC 回收后托盘图标变空白/消失
            trayIcon = icon;
            tray = new NotifyIcon();
            tray.Icon = icon;
            tray.Text = "课铃 ClassBell";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开课铃（Ctrl+Alt+B）", null, (s, e) => ShowMain());
            pendingItem = new ToolStripMenuItem("待完成 0 项") { Enabled = false };
            menu.Items.Add(pendingItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("新建日程", null, (s, e) =>
            {
                ShowMain();
                try
                {
                    if (webView.CoreWebView2 != null)
                        webView.CoreWebView2.ExecuteScriptAsync("window.__campusNewTask()");
                }
                catch { }
            });
            menu.Items.Add("立即同步学习通", null, async (s, e) =>
            {
                try
                {
                    await HostApi.PostJsonAsync("/api/cx/sync", new Dictionary<string, object>());
                    await PollStatusAsync();
                }
                catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            autoLaunchItem = new ToolStripMenuItem("开机自动启动");
            autoLaunchItem.CheckOnClick = true;
            autoLaunchItem.Click += async (s, e) =>
            {
                SetAutoLaunch(autoLaunchItem.Checked);
                try
                {
                    await HostApi.PostJsonAsync("/api/settings", new Dictionary<string, object> { { "autoLaunch", autoLaunchItem.Checked } });
                }
                catch { }
            };
            menu.Items.Add(autoLaunchItem);
            menu.Items.Add("退出课铃", null, (s, e) =>
            {
                exiting = true;
                Close();
            });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowMain();
            tray.Click += (s, e) => ShowMain();
        }

        /// <summary>
        /// Win11 默认把新出现的托盘图标折叠进“溢出区”，用户会以为程序没在运行。
        /// 这里把本程序的托盘项标记为 IsPromoted，让它固定显示在托盘区。
        /// 只写当前用户、只改匹配本 exe 的项；找不到条目时安静跳过。
        /// </summary>
        private void PromoteTrayIcon()
        {
            try
            {
                string exe = Application.ExecutablePath;
                string keyPath = @"Control Panel\NotifyIconSettings";
                using (var root = Registry.CurrentUser.OpenSubKey(keyPath, true))
                {
                    if (root == null) return;
                    foreach (string sub in root.GetSubKeyNames())
                    {
                        try
                        {
                            using (var item = root.OpenSubKey(sub, true))
                            {
                                if (item == null) continue;
                                string path = item.GetValue("ExecutablePath") as string;
                                string tip = item.GetValue("InitialTooltip") as string;
                                bool mine = (!string.IsNullOrEmpty(path) && string.Equals(path, exe, StringComparison.OrdinalIgnoreCase))
                                         || (!string.IsNullOrEmpty(tip) && tip.Contains("课铃"));
                                if (!mine) continue;
                                item.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        private void SetAutoLaunch(bool enabled)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key == null) return;
                    if (enabled) key.SetValue("ClassBell", "\"" + Application.ExecutablePath + "\" --hidden");
                    else key.DeleteValue("ClassBell", false);
                }
            }
            catch { }
        }

        /// <summary>
        /// 托盘图标第一次可用时，用气泡告诉用户“课铃在托盘里”。
        /// Win11 默认把新图标折叠进溢出区，不提示的话用户根本不知道它还在跑。
        /// </summary>
        private void ShowTrayHintOnce()
        {
            if (trayHintShown || tray == null) return;
            trayHintShown = true;
            try
            {
                tray.BalloonTipTitle = "课铃正在托盘运行";
                tray.BalloonTipText = "点 × 只是隐藏窗口，到点仍会提醒。想彻底退出：右键托盘图标 →「退出课铃」。";
                tray.BalloonTipIcon = ToolTipIcon.Info;
                tray.ShowBalloonTip(5000);
            }
            catch { }
            PersistFlag("trayHintShown", true);
        }

        /// <summary>把一次性标记写回服务端设置（失败不影响使用）。</summary>
        private async void PersistFlag(string key, bool value)
        {
            try
            {
                await HostApi.PostJsonAsync("/api/settings", new Dictionary<string, object> { { key, value } });
            }
            catch { }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            SaveWindowState();
            if (!exiting && closeToTray)
            {
                e.Cancel = true;

                // 第一次点 ×：先解释清楚“为什么还在跑”，并给出真正的退出按钮。
                // 只弹一次，标记存服务端（WebView2 数据被清也不会重复弹）。
                if (!closeHintShown)
                {
                    closeHintShown = true;
                    PersistFlag("closeHintShown", true);
                    bool quit = CloseHintDialog.Ask(this);
                    if (quit)
                    {
                        exiting = true;
                        Close();
                        return;
                    }
                }

                HideToTray();
                return;
            }
            exiting = true;
            try { if (showEvent != null) showEvent.Close(); } catch { }
            StopBackend();
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
        }

        private void StopBackend()
        {
            try
            {
                if (backend != null && !backend.HasExited)
                {
                    try
                    {
                        HostApi.PostJsonAsync("/api/shutdown", new Dictionary<string, object>()).Wait(1200);
                    }
                    catch { }
                    if (!backend.WaitForExit(3500))
                    {
                        backend.Kill();
                        backend.WaitForExit(1500);
                    }
                }
            }
            catch { }
            try { if (backendLog != null) backendLog.Dispose(); } catch { }
        }
    }
}
