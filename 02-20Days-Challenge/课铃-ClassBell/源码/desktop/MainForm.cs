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
        // 桌面浮窗：显示下一项任务，常驻桌面
        private FloatWindow floatWindow;
        private bool floatWindowEnabled = true;
        // 用户手动点过「隐藏浮窗」：只在本次运行内有效，不写盘。
        // 有它才能让「隐藏」是真的隐藏 —— 否则下一轮轮询又给显示回来。
        private bool floatHiddenByUser;
        // 托盘菜单里的「桌面浮窗」勾选项：托盘与设置页两个开关靠它同步状态
        private ToolStripMenuItem floatTrayItem;
        // 浮窗位置缓存：轮询里读设置、拖动后回写，避免每次都从 JSON 里取
        private string floatWindowPos = "";
        // 最近一次 /api/state 的 settings 节点：浮窗按 uiScale 缩放要用
        private Dictionary<string, object> latestSettings;
        // 浮窗与提醒弹窗的字号各自独立（1.1 = 110%）。
        // 设置页改完会立刻通过 applySurfaceScale 推过来，这里只是缓存。
        private float floatScaleValue = 1.1f;
        private float toastScaleValue = 1.1f;
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
                CreateFloatWindow();
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
                var friendly = DescribeStartupFailure(ex);
                MessageBox.Show(this, friendly.Body + "\n\n日志目录：" + Path.Combine(dataDir, "process_logs"),
                    friendly.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                exiting = true;
                Close();
            }
        }

        /// <summary>
        /// 把启动失败的异常翻译成用户能看懂的话。
        /// 设计原则：能识别的给“人话 + 下一步怎么办”；识别不了的保留原文（便于报障），
        /// 调用方仍会附上日志目录。
        /// </summary>
        private static FriendlyFailure DescribeStartupFailure(Exception ex)
        {
            string text = CollectErrorText(ex);
            int code = 0;
            try
            {
                if (ex is System.Runtime.InteropServices.COMException)
                    code = ((System.Runtime.InteropServices.COMException)ex).HResult;
                if (code == 0 && ex.InnerException is System.Runtime.InteropServices.COMException)
                    code = ((System.Runtime.InteropServices.COMException)ex.InnerException).HResult;
            }
            catch { }

            // 0x80040004 = E_ABORT：几乎总是“另一个实例占着同一个 WebView2 数据目录”
            bool aborted = code == unchecked((int)0x80040004)
                           || text.IndexOf("E_ABORT", StringComparison.OrdinalIgnoreCase) >= 0
                           || text.IndexOf("0x80040004", StringComparison.OrdinalIgnoreCase) >= 0;

            if (aborted)
            {
                return new FriendlyFailure(
                    "课铃打不开：已经有另一个课铃在运行",
                    "课铃的内嵌浏览器同一时间只能被一个课铃使用。\r\n\r\n"
                    + "现在很可能还有另一个课铃在后台（图标折叠在右下角 ^ 里），\r\n"
                    + "它占着同一份浏览器数据，所以这次启动被中止了。\r\n\r\n"
                    + "接下来怎么办：\r\n"
                    + "1) 在右下角 ^ 里找到课铃图标，右键 →「退出课铃」；\r\n"
                    + "2) 或者打开任务管理器，结束所有 ClassBell.exe；\r\n"
                    + "3) 再重新打开课铃。");
            }

            if (LooksLikeMissingWebView2(ex))
            {
                return new FriendlyFailure(
                    "课铃打不开：缺少浏览器组件",
                    "这台电脑没有安装 Microsoft Edge WebView2 运行时，课铃的界面需要它才能显示。\r\n\r\n"
                    + "接下来怎么办：安装 WebView2 运行时后重新打开课铃；\r\n"
                    + "安装包内已自带该组件，重新运行一次安装包通常就能补上。");
            }

            if (code == unchecked((int)0x80070005) || text.IndexOf("拒绝访问", StringComparison.Ordinal) >= 0)
            {
                return new FriendlyFailure(
                    "课铃打不开：没有写入权限",
                    "课铃需要在自己的数据目录里读写文件，但系统拒绝了。\r\n\r\n"
                    + "接下来怎么办：检查安全软件是否拦截了课铃；\r\n"
                    + "或把课铃安装到你有权限的目录（例如文档目录）后重试。");
            }

            // 识别不了的：原文照旧，便于报障
            return new FriendlyFailure("课铃启动失败", "课铃启动失败：\r\n" + ex.Message);
        }

        private static string CollectErrorText(Exception ex)
        {
            var builder = new System.Text.StringBuilder();
            var current = ex;
            int depth = 0;
            while (current != null && depth < 5)
            {
                builder.Append(current.GetType().Name).Append(' ').Append(current.Message).Append(' ');
                current = current.InnerException;
                depth += 1;
            }
            return builder.ToString();
        }

        private struct FriendlyFailure
        {
            public readonly string Title;
            public readonly string Body;
            public FriendlyFailure(string title, string body) { Title = title; Body = body; }
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

                    // 浮窗设置：位置只在设置页改过时更新（拖动时本地已经是最新值）
                    string savedPos = HostApi.Str(settings, "floatWindowPos", "");
                    if (!string.IsNullOrWhiteSpace(savedPos)) floatWindowPos = savedPos;
                    bool enabled = HostApi.Bool(settings, "floatWindow", true);
                    if (enabled != floatWindowEnabled)
                    {
                        floatWindowEnabled = enabled;
                        if (!enabled && floatWindow != null) floatWindow.Hide();
                    }
                }

                SyncFloatWindow(stateNode);
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
                latestSettings = settings;
                if (settings != null && settingsLoaded)
                {
                    closeToTray = HostApi.Bool(settings, "closeToTray", true);
                    closeHintShown = HostApi.Bool(settings, "closeHintShown", false);
                    trayHintShown = HostApi.Bool(settings, "trayHintShown", false);
                    autoLaunchItem.Checked = HostApi.Bool(settings, "autoLaunch", true);

                    // 设置页关掉浮窗后，最多等一个轮询周期它就消失
                    bool wanted = HostApi.Bool(settings, "floatWindow", true);
                    if (wanted != floatWindowEnabled)
                    {
                        floatWindowEnabled = wanted;
                        if (!wanted && floatWindow != null) floatWindow.Hide();
                    }
                    // 设置页改的开关，托盘菜单要跟着变（两个入口必须互相同步）
                    SyncFloatTrayCheck();

                    // 位置也跟着设置走：拖动保存会写回去，这里读回来保持一致；
                    // 少了这句，"重新打开浮窗"会落到默认角而不是记住的位置。
                    string polledPos = HostApi.Str(settings, "floatWindowPos", "");

                    // 字号也读回来：设置页改的会立刻推过来，这里兜住"直接改配置文件"的情况
                    float polledFloatScale = (float)Convert.ToDouble(settings.ContainsKey("floatScale") ? settings["floatScale"] : 1.1);
                    if (polledFloatScale >= 0.8f && polledFloatScale <= 1.8f) floatScaleValue = polledFloatScale;
                    float polledToastScale = (float)Convert.ToDouble(settings.ContainsKey("toastScale") ? settings["toastScale"] : 1.1);
                    if (polledToastScale >= 0.8f && polledToastScale <= 1.8f) toastScaleValue = polledToastScale;
                    if (!string.IsNullOrWhiteSpace(polledPos)) floatWindowPos = polledPos;
                }

                // 每 30 秒把「下一项任务」推给浮窗
                SyncFloatWindow(stateNode);
            }
            catch { }
        }

        /// <summary>
        /// 把最新状态推给浮窗。没有待办时传 null，由浮窗自己显示「今天没有待办」再淡出。
        /// </summary>
        private void SyncFloatWindow(Dictionary<string, object> stateNode)
        {
            if (floatWindow == null) return;
            try
            {
                // 用户手动隐藏过就别再自动弹 —— 否则「隐藏」这个按钮等于没有。
                // 这是上一版最要命的 bug：只判 floatWindowEnabled，隐藏完 30 秒又冒出来。
                if (!floatWindowEnabled || floatHiddenByUser)
                {
                    if (floatWindow.Visible) floatWindow.Hide();
                    SyncFloatTrayCheck();
                    return;
                }

                floatWindow.ApplyScale(CurrentFloatScale());
                var next = ComputeNextTask(stateNode);
                floatWindow.SetTask(next);

                // 有任务就确保可见（不抢焦点）；全屏时 FloatWindow 自己会让路
                if (next != null) floatWindow.ShowWindowWithoutStealingFocus();
            }
            catch (Exception ex) { SafeLog("float window sync failed: " + ex.Message); }
        }

        /// <summary>
        /// 从 state.tasks 里挑「下一项」：待完成、有截止时间、按时间升序，
        /// 优先还没过期的第一条；都过期了就取最早那条。
        /// 渲染层 nextPendingTask() 用的是同一套规则，两边必须一致。
        /// </summary>
        private static FloatWindow.TaskInfo ComputeNextTask(Dictionary<string, object> stateNode)
        {
            try
            {
                if (stateNode == null || !stateNode.ContainsKey("tasks")) return null;
                var tasks = stateNode["tasks"] as IList;
                if (tasks == null) return null;

                FloatWindow.TaskInfo best = null;
                DateTime bestDue = DateTime.MaxValue;
                FloatWindow.TaskInfo earliestOverdue = null;
                DateTime earliestDue = DateTime.MaxValue;
                var now = DateTime.Now;

                foreach (var entry in tasks)
                {
                    var task = entry as Dictionary<string, object>;
                    if (task == null) continue;
                    if (HostApi.Str(task, "status") != "pending") continue;
                    if (HostApi.Bool(task, "noDeadline", false)) continue;

                    DateTime due;
                    if (!DateTime.TryParse(HostApi.Str(task, "dueAt"), null,
                        System.Globalization.DateTimeStyles.RoundtripKind, out due)) continue;
                    due = due.ToLocalTime();

                    var info = new FloatWindow.TaskInfo
                    {
                        Title = HostApi.Str(task, "title"),
                        Course = HostApi.Str(task, "course"),
                        DueAt = due,
                        Category = CategoryLabel(HostApi.Str(task, "category")),
                        Overdue = due < now
                    };

                    if (due >= now && due < bestDue) { bestDue = due; best = info; }
                    if (due < now && due < earliestDue) { earliestDue = due; earliestOverdue = info; }
                }

                return best ?? earliestOverdue;
            }
            catch { return null; }
        }

        private static string CategoryLabel(string category)
        {
            switch (category)
            {
                case "homework": return "作业";
                case "exam": return "考试";
                case "schedule": return "日程";
                default: return "任务";
            }
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
                    // 设置页切「桌面浮窗」后立刻生效，不必等 30 秒轮询
                    // 界面大小：立刻同步给浮窗，之后弹出的提醒弹窗也用它
                    // 字号：前端改完立刻推过来，不必等 30 秒轮询。
                    // 第一个参数是作用对象（float / toast），第二个是档位。
                    case "applySurfaceScale":
                        string surface = args != null && args.Length > 0 ? Convert.ToString(args[0]) : "";
                        float scaleValue = (float)Convert.ToDouble(args != null && args.Length > 1 ? args[1] : 1.1);
                        if (scaleValue < 0.8f) scaleValue = 0.8f;
                        if (scaleValue > 1.8f) scaleValue = 1.8f;
                        if (surface == "float")
                        {
                            floatScaleValue = scaleValue;
                            if (floatWindow != null) floatWindow.ApplyScale(scaleValue);
                        }
                        else if (surface == "toast")
                        {
                            toastScaleValue = scaleValue;
                        }
                        Respond(id, true, null);
                        break;
                    case "applyFloatWindow":
                        bool floatOn = Convert.ToBoolean(args != null && args.Length > 0 ? args[0] : true);
                        floatWindowEnabled = floatOn;
                        if (floatOn) ShowFloatWindow(false);
                        else
                        {
                            floatHiddenByUser = false;
                            if (floatWindow != null) floatWindow.Hide();
                        }
                        SyncFloatTrayCheck();
                        Respond(id, true, null);
                        break;
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
                    // 复制文本到剪贴板。页面的 navigator.clipboard 在 WebView2 里
                    // 依赖用户激活与权限授予，实测会被拒；桌面程序直接调系统剪贴板最稳。
                    case "copyText":
                        try
                        {
                            Clipboard.SetText(Arg(args, 0) ?? string.Empty);
                            Respond(id, true, null);
                        }
                        catch (Exception copyError)
                        {
                            Respond(id, false, new Dictionary<string, object> { { "message", copyError.Message } });
                        }
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

        /// <summary>
        /// 第一次创建浮窗。位置从设置里恢复；没设过就落在主屏右下角。
        /// </summary>
        private void CreateFloatWindow()
        {
            try
            {
                if (floatWindow != null) return;
                floatWindow = new FloatWindow(this);
                floatWindow.ApplyScale(CurrentFloatScale());
                floatWindow.StartPosition = FormStartPosition.Manual;
                // 先缩放再算位置：位置依赖真实尺寸，用 300×84 会算到屏幕外
                floatWindow.Location = ResolveFloatPosition(floatWindow.Size);
                ApplyFloatVisibility();
            }
            catch (Exception ex) { SafeLog("float window failed: " + ex.Message); }
        }

        /// <summary>桌面浮窗用的字号档位。</summary>
        private float CurrentFloatScale()
        {
            return floatScaleValue > 0 ? floatScaleValue : 1.1f;
        }

        /// <summary>提醒弹窗用的字号档位（各自独立，和浮窗、主界面都不联动）。</summary>
        private float CurrentToastScale()
        {
            return toastScaleValue > 0 ? toastScaleValue : 1.1f;
        }

        /// <summary>
        /// 恢复浮窗位置。
        /// 解析失败或数值超出 ±100000 一律当没设过、走默认位置；
        /// 解析成功但落在屏幕外或屏幕边缘时，由 ClampToVisible 夹回可见范围（不是回默认角）。
        /// </summary>
        private Point ResolveFloatPosition(Size size)
        {
            try
            {
                Point remembered;
                if (PositionParse.TryParse(floatWindowPos, out remembered))
                {
                    return FloatWindow.ClampToVisible(remembered, size);
                }
            }
            catch { }
            return FloatWindow.DefaultPosition(size);
        }

        /// <summary>
        /// 浮窗右键「隐藏浮窗」。只隐藏、不销毁，下次打开回到原位；
        /// 同时打上 floatHiddenByUser，避免 30 秒轮询又把它显示回来。
        /// </summary>
        internal void HideFloatWindow()
        {
            floatHiddenByUser = true;
            if (floatWindow != null) floatWindow.Hide();
            SyncFloatTrayCheck();
            // 不给提示的话，用户下次想找还是找不到
            ShowFloatHiddenToast();
        }

        /// <summary>
        /// 把浮窗重新显示出来（托盘勾选 / 设置页打开 / 双击托盘图标都走这里）。
        /// 会清掉"本次不显示"的标记，并回到记住的位置。
        /// </summary>
        internal void ShowFloatWindow(bool persist = false)
        {
            floatHiddenByUser = false;
            floatWindowEnabled = true;
            if (floatWindow == null) CreateFloatWindow();
            if (floatWindow == null) return;
            floatWindow.ApplyScale(CurrentFloatScale());
            floatWindow.Location = ResolveFloatPosition(floatWindow.Size);
            floatWindow.ShowWindowWithoutStealingFocus();
            SyncFloatTrayCheck();
            if (persist) PersistFloatWindowSetting(true);
        }

        /// <summary>把开关状态写回设置（托盘菜单改的，设置页要跟着变）。</summary>
        private void PersistFloatWindowSetting(bool enabled)
        {
            try
            {
                var payload = new Dictionary<string, object> { { "floatWindow", enabled } };
                HostApi.PostJsonAsync("/api/settings", payload).ContinueWith(t => { });
            }
            catch { }
        }

        /// <summary>托盘菜单的勾选状态要跟真实状态一致（托盘和设置页互相同步）。</summary>
        private void SyncFloatTrayCheck()
        {
            if (floatTrayItem == null) return;
            floatTrayItem.Checked = floatWindowEnabled && !floatHiddenByUser;
        }

        /// <summary>隐藏后提示一句怎么找回。4 秒后自己消失，不打扰。</summary>
        private void ShowFloatHiddenToast()
        {
            try
            {
                // 专门写清楚"去哪儿找回来"：不提示的话，用户下次想找还是找不到
                var toast = new TrayToastForm(4000, "浮窗已隐藏", new[]
                {
                    "想找回来：右键托盘图标 → 桌面浮窗",
                    "也可以在设置页重新打开「桌面浮窗」"
                }, CurrentToastScale());
                toast.Show();
                toast.BringToFront();
            }
            catch (Exception ex) { SafeLog("float hidden toast failed: " + ex.Message); }
        }

        /// <summary>拖动结束后把位置写回设置（只写一次，不是每一帧都写）。</summary>
        internal void SaveFloatWindowPosition(Point location)
        {
            floatWindowPos = location.X + "," + location.Y;
            try
            {
                var payload = new Dictionary<string, object> { { "floatWindowPos", floatWindowPos } };
                HostApi.PostJsonAsync("/api/settings", payload).ContinueWith(t => { });
            }
            catch { }
        }

        /// <summary>浮窗双击 / 菜单「打开课铃」：把主窗口拉到前台，可选切到某一页。</summary>
        internal void OpenMainWindow(string page = null)
        {
            ShowMain();
            if (string.IsNullOrEmpty(page)) return;
            try
            {
                if (webView.CoreWebView2 != null)
                    webView.CoreWebView2.ExecuteScriptAsync("window.__campusGoPage(" + HostApi.Json.Serialize(page) + ")");
            }
            catch { }
        }

        /// <summary>
        /// 按设置决定浮窗显不显示。分两种情况：
        ///  - 有任务：显示（除非正被全屏应用挡着，那种情况交给 FloatWindow 自己判断）
        ///  - 没任务：显一下「今天没有待办」，由 FloatWindow 淡出
        /// </summary>
        private void ApplyFloatVisibility()
        {
            if (floatWindow == null) return;
            if (!floatWindowEnabled) { floatWindow.Hide(); return; }
            floatWindow.ShowWindowWithoutStealingFocus();
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
                    // 同样跟随界面大小：收进托盘时的提示不该比主界面小一号
                var toast = new TrayToastForm(6000, null, null, CurrentToastScale());
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
            // 浮窗的恢复入口：用户第一直觉就是去托盘找，所以放在「打开课铃」下面。
            // CheckOnClick 负责切换，handler 里立刻显示/隐藏，不等轮询。
            floatTrayItem = new ToolStripMenuItem("桌面浮窗") { CheckOnClick = true, Checked = true };
            floatTrayItem.CheckedChanged += (s2, e2) =>
            {
                floatWindowEnabled = floatTrayItem.Checked;
                if (floatTrayItem.Checked)
                {
                    // 勾上：立刻显示（回到记住的位置），并把偏好写回设置
                    ShowFloatWindow(true);
                }
                else
                {
                    // 取消：立刻隐藏，并关掉「启用浮窗」这个长期偏好
                    floatHiddenByUser = false;
                    if (floatWindow != null) floatWindow.Hide();
                    PersistFloatWindowSetting(false);
                }
            };
            menu.Items.Add(floatTrayItem);
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

            // NotifyIcon.Click 不区分左右键：右键也会走到这里，把窗口顶到前面抢掉焦点，
            // ContextMenuStrip 那一次就弹不出来，用户看到的是“第一次右键打开了窗口”。
            // MouseClick 的 EventArgs 是 MouseEventArgs，能拿到按键，所以左键才打开窗口。
            tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowMain();
            };

            // 双击要单独绑：MouseClick 只给单击，双击时系统会先发两次 MouseClick，
            // ShowMain 是幂等的（只恢复/显示/激活，不重建界面），所以重复调用不会闪、不会重载。
            tray.DoubleClick += (s, e) => ShowMain();
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
