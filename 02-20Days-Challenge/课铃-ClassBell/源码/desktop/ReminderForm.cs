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
            Width = 440;
            Height = 304;
            BackColor = Color.FromArgb(243, 240, 231);
            AutoScaleMode = AutoScaleMode.None;
            try { Icon = new Icon(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "icon.ico")); } catch { }

            using (var path = RoundedRect(new Rectangle(0, 0, Width, Height), 18))
                Region = new Region(path);

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
