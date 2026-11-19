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

            // 尺寸与圆角一起算：Region 用的是同一组 Width/Height（都是物理像素），
            // 先设尺寸再建 Region，否则会拿旧尺寸裁圆角、底部四角对不上。
            ApplyPixelSize();

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
            float scale = CurrentDpiScale();
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
            ApplyPixelSize();
            PositionWindow();
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

        private void PositionWindow()
        {
            var screen = Screen.FromPoint(Cursor.Position);
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
