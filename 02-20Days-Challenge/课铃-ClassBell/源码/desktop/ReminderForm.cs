using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Media;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClassBell
{
    internal sealed class ReminderForm : Form
    {
        private readonly int port;
        private readonly Dictionary<string, object> payload;
        private readonly MainForm owner;
        private readonly CoreWebView2Environment environment;
        private WebView2 webView;
        private System.Windows.Forms.Timer lifeTimer;

        // 是否已经按 WebView2 自报的 devicePixelRatio 定过尺寸。
        // 定完之前窗体保持不可见（Opacity=0），避免先按错的尺寸闪一下再跳。
        private bool sizedByPage;

        // 设计尺寸，单位是 **CSS 像素** —— 与 reminder.css 的布局一一对应。
        //
        // 304 这个高度是实测出来的，够用：按 CDP 量到的真实 DOM，
        //   1 行标题：头部 84 + 正文(17+12+6+26+9+14+15+34+12 = 145) + 页脚 28 + 卡片上下留白 14 + 边框 2 = 272；
        //   2 行标题（-webkit-line-clamp: 2 的上限）：标题 26 → 52，需要 298。
        // 所以 304 已经能容纳 2 行标题（余 6px），不需要靠加高窗口来"塞内容"。
        //
        // 真正的问题不是这个数值太小，而是它被当成物理像素用了：
        // 125% 缩放下 440x304 的物理窗口只对应 352x243 的 CSS 视口，比 272 还小，按钮才会被裁。
        private const int DesignWidth = 440;
        private const int DesignHeight = 304;

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        // 按显示器取 DPI。比 GetDpiForWindow 更早可用：不需要等窗口落到目标屏上。
        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }

        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const int MDT_EFFECTIVE_DPI = 0;

        public ReminderForm(int port, Dictionary<string, object> payload, MainForm owner, CoreWebView2Environment environment)
        {
            this.port = port;
            this.payload = payload;
            this.owner = owner;
            this.environment = environment;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = true;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(243, 240, 231);
            AutoScaleMode = AutoScaleMode.None;
            try { Icon = new Icon(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "icon.ico")); } catch { }

            // 尺寸按「提醒将出现的那块屏」的 DPI 算，一次算准再显示，不做"先错后改"。
            // Region 用同一组 Width/Height（都是物理像素），所以先定尺寸再建圆角。
            ApplyPixelSize(ScaleForScreen(TargetScreen()));

            webView = new WebView2 { Dock = DockStyle.Fill };
            webView.DefaultBackgroundColor = Color.FromArgb(243, 240, 231);
            Controls.Add(webView);

            Shown += async (s, e) =>
            {
                PositionWindow();
                try { SystemSounds.Exclamation.Play(); } catch { }
                await InitializeAsync();
            };
            FormClosed += (s, e) => { if (lifeTimer != null) { lifeTimer.Stop(); lifeTimer.Dispose(); } };
        }

        /// <summary>
        /// 取这个窗口所在显示器上的 DPI 比例（150% → 1.5）。
        ///
        /// 为什么必须按窗口所在屏取、而不是系统 DPI：多显示器里两块屏的缩放可能不同，
        /// 用错比例就会在副屏上被裁或撑出屏幕。句柄还没建好时退回系统 DPI。
        /// </summary>
        /// <summary>
        /// 取「某块屏」的缩放比例，用 GetDpiForMonitor 直接问系统，不需要窗口已经在上面。
        ///
        /// 为什么要在显示前就能算准：以前是先显示、再等页面报 devicePixelRatio 去纠正，
        /// 中间会有一段时间窗体的尺寸是错的，只能靠"透明"遮住 —— 那正是"幽灵占位"。
        /// 现在按目标屏的 DPI 先把尺寸算对，页面 dpr 只当校验用。
        /// </summary>
        private static float ScaleForScreen(Screen screen)
        {
            if (screen == null) return 1f;
            try
            {
                var bounds = screen.Bounds;
                var point = new POINT
                {
                    X = bounds.Left + bounds.Width / 2,
                    Y = bounds.Top + bounds.Height / 2
                };
                IntPtr monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
                if (monitor != IntPtr.Zero)
                {
                    uint dpiX, dpiY;
                    if (GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out dpiX, out dpiY) == 0
                        && dpiX >= 72 && dpiX <= 384)
                    {
                        return dpiX / 96f;
                    }
                }
            }
            catch { }
            return SystemDpiScale();
        }

        /// <summary>系统级 DPI 比例，只作为最后兜底（拿不到具体显示器时用）。</summary>
        private static float SystemDpiScale()
        {
            try
            {
                using (var graphics = Graphics.FromHwnd(IntPtr.Zero))
                {
                    float scale = graphics.DpiX / 96f;
                    if (scale >= 0.75f && scale <= 4f) return scale;
                }
            }
            catch { }
            return 1f;
        }

        private float CurrentDpiScale()
        {
            try
            {
                if (IsHandleCreated)
                {
                    uint dpi = GetDpiForWindow(Handle);
                    if (dpi >= 72 && dpi <= 384) return dpi / 96f;   // 75% ~ 400%
                }
                using (var graphics = Graphics.FromHwnd(IntPtr.Zero))
                {
                    float scale = graphics.DpiX / 96f;
                    if (scale >= 0.75f && scale <= 4f) return scale;
                }
            }
            catch { }
            return 1f;
        }

        /// <summary>
        /// 句柄建好之后立刻再算一次：构造时还拿不到这块屏的 DPI，
        /// 只能用系统 DPI 兜底；这里补上窗口真正归属的那块屏。
        /// </summary>
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyPixelSize();
        }

        /// <summary>
        /// 按 DPI 把「设计尺寸（CSS 像素）」换算成窗口的物理像素尺寸，并重建圆角区域。
        ///
        /// 为什么必须换算：WinForms 的 Width/Height 是物理像素，而 WebView2 里的 CSS 像素
        /// 会按系统缩放放大 —— 同一份 reminder.css 在 150% 屏上要占 1.5 倍物理宽高。
        /// 尺寸不跟着放大，CSS 视口就只剩 2/3（实测 294x203），内容被 overflow:hidden 裁掉。
        /// </summary>
        private void ApplyPixelSize()
        {
            ApplyPixelSize(CurrentDpiScale());
        }

        /// <summary>
        /// 按给定比例换算窗口物理尺寸。
        ///
        /// 比例来源要优先用「页面自报的 devicePixelRatio」：
        /// Win32 的 DPI 和 WebView2 实际渲染用的比例在多显示器下可能不一致，
        /// 一旦不一致，CSS 视口就会比设计尺寸大（下方大片空白）或小（按钮被裁）。
        /// </summary>
        private void ApplyPixelSize(float scale)
        {
            if (scale < 0.5f || scale > 4f) scale = 1f;
            int width = (int)Math.Round(DesignWidth * scale);
            int height = (int)Math.Round(DesignHeight * scale);
            if (Width == width && Height == height && Region != null) return;

            MinimumSize = new Size(width, height);
            MaximumSize = new Size(width, height);
            Size = new Size(width, height);

            var old = Region;
            // 圆角半径也按 DPI 放大：18 是 100% 下的视觉半径
            using (var path = RoundedRect(new Rectangle(0, 0, width, height), (int)Math.Round(18 * scale)))
            {
                Region = new Region(path);
            }
            if (old != null) old.Dispose();
        }

        /// <summary>
        /// 窗口被拖到另一块缩放比例不同的显示器时，重算尺寸与圆角。
        /// 不处理的话，换屏之后 CSS 视口又会变小、按钮再次被裁。
        /// </summary>
        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            // 同步先按新屏的 DPI 改尺寸：这一步是立即生效的，拖动跨屏时不会有"中间一帧还按旧尺寸"。
            float newScale = e.DeviceDpiNew > 0 ? e.DeviceDpiNew / 96f : CurrentDpiScale();
            ApplyPixelSize(newScale);
            PositionWindow();

            // 再用页面自报的 dpr 校验一次：只有真的不一致才纠正（极少发生）。
            sizedByPage = false;
            SizeFromPageAsync().ContinueWith(t => { }, System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>提醒窗口该出现在哪块屏：光标所在的那块（和以前一致）。</summary>
        private static Screen TargetScreen()
        {
            try { return Screen.FromPoint(Cursor.Position); }
            catch { return Screen.PrimaryScreen; }
        }

        private void PositionWindow()
        {
            var screen = TargetScreen();
            var area = screen.WorkingArea;
            Location = new Point(area.Right - Width - 24, area.Bottom - Height - 24);
        }

        private async System.Threading.Tasks.Task InitializeAsync()
        {
            try
            {
                var env = environment;
                if (env == null)
                {
                    env = await CoreWebView2Environment.CreateAsync(null,
                        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ClassBell", "WebView2"),
                        null);
                }
                await webView.EnsureCoreWebView2Async(env);
                // 不再按 DPI 二次缩放，避免文字发虚（WebView2 已跟随系统 DPI）
                webView.ZoomFactor = 1.0;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.WebMessageReceived += OnWebMessage;
                string json = HostApi.Json.Serialize(payload);
                string url = "http://127.0.0.1:" + port + "/reminder.html?data=" + Uri.EscapeDataString(json);
                webView.CoreWebView2.Navigate(url);

                // 页面加载完再定尺寸：这时才能读到 WebView2 真正使用的 devicePixelRatio。
                // 定完之前窗体是透明的，避免先按 Win32 DPI 算出的尺寸闪一下。
                webView.CoreWebView2.NavigationCompleted += async (s2, e2) =>
                {
                    try { await SizeFromPageAsync(); } catch { }
                    try { Opacity = 1.0; } catch { }
                };
                lifeTimer = new System.Windows.Forms.Timer { Interval = 10 * 60 * 1000 };
                lifeTimer.Tick += (s, e) => { lifeTimer.Stop(); Close(); };
                lifeTimer.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "无法显示提醒：\n" + ex.Message, "课铃 ClassBell");
                Close();
            }
        }

        /// <summary>
        /// 用页面自报的 devicePixelRatio 定窗口尺寸。
        ///
        /// 这是唯一可靠的比例来源：CSS 视口 = 物理尺寸 / devicePixelRatio，
        /// 只要两边用同一个数，视口就恒等于 440x304，不会出现"窗口特别大"或"按钮被裁"。
        /// 连续取两次是为了避开页面刚加载时 dpr 还没稳定的瞬间。
        /// </summary>
        private async System.Threading.Tasks.Task SizeFromPageAsync()
        {
            if (webView == null || webView.CoreWebView2 == null) return;
            if (sizedByPage) return;

            float ratio = 0f;
            for (int attempt = 0; attempt < 2 && ratio <= 0f; attempt += 1)
            {
                try
                {
                    string raw = await webView.CoreWebView2.ExecuteScriptAsync("window.devicePixelRatio");
                    float parsed;
                    if (raw != null
                        && float.TryParse(raw.Trim('"'), System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out parsed)
                        && parsed >= 0.5f && parsed <= 4f)
                    {
                        ratio = parsed;
                    }
                }
                catch { }
                if (ratio <= 0f) await System.Threading.Tasks.Task.Delay(120);
            }

            if (ratio <= 0f) ratio = CurrentDpiScale();   // 读不到就退回 Win32 DPI
            sizedByPage = true;

            // 只在真的不一致时才改尺寸：正常情况下显示前已经算对，这里什么都不会发生。
            int width = (int)Math.Round(DesignWidth * ratio);
            if (Width == width) return;
            ApplyPixelSize(ratio);
            PositionWindow();
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var message = HostApi.ParseObject(e.WebMessageAsJson);
                if (HostApi.Str(message, "type") != "host") return;
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
                string id = HostApi.Str(message, "id");
                if (method == "openTask")
                {
                    string taskId = args != null && args.Length > 0 ? Convert.ToString(args[0]) : "";
                    owner.OpenTaskFromReminder(taskId);
                }
                if (webView.CoreWebView2 != null)
                    webView.CoreWebView2.ExecuteScriptAsync("window.__hostResolve(" + HostApi.Json.Serialize(id) + ",true,null);");
                Close();
            }
            catch { Close(); }
        }
    }
}
