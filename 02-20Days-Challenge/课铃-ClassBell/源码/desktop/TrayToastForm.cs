using System;
using System.Drawing;
using System.Windows.Forms;

namespace ClassBell
{
    /// <summary>
    /// 收进托盘时右下角的轻提示（几秒自动消失）。
    ///
    /// 为什么需要：Win11 会把新托盘图标折叠进溢出区（^），用户看不到，
    /// 就以为“课铃被关掉了”。Windows 没有公开 API 能把图标强制固定到托盘，
    /// 所以用这个确定性反馈补上“程序还在跑”的感知。
    ///
    /// 实现取舍：
    ///  - 不用 Opacity（分层窗口在个别显卡/远程桌面下会不渲染），
    /// 改为普通的无边框窗口；
    ///  - 给窗口一个标题，便于排查与窗口枚举；
    ///  - 置顶 + BringToFront，确保出现在最上层。
    /// </summary>
    internal sealed class TrayToastForm : Form
    {
        private readonly Timer life;
        private readonly int lifeMs;
        private int elapsed;

        // 布局算出来的字体要跟窗体一起释放，否则每次弹窗都漏两个 GDI 句柄
        private readonly ToastLayout.Metrics metrics;

        /// <param name="lifeMs">显示多久，毫秒。</param>
        /// <param name="heading">窗口标题 + 大字标题。</param>
        /// <param name="detail">下面两行小字；null 表示用默认的"收进托盘"文案。</param>
        /// <param name="uiScale">界面大小设置；调用方传 CurrentUiScale()。</param>
        /// <param name="dpiScale">屏幕 DPI 比例；传 0 表示自己探测。</param>
        public TrayToastForm(
            int lifeMs = 6000,
            string heading = null,
            string[] detail = null,
            float uiScale = 1.1f,
            float dpiScale = 0f)
        {
            this.lifeMs = lifeMs;
            string head = string.IsNullOrWhiteSpace(heading) ? "课铃仍在运行" : heading;
            string text1 = detail != null && detail.Length > 0 ? detail[0] : "窗口已收进托盘（可能折叠在右下角的 ^ 里）";
            string text2 = detail != null && detail.Length > 1 ? detail[1] : "Ctrl+Alt+B 找回窗口 · 右键托盘图标可退出";
            float dpi = dpiScale > 0f ? dpiScale : DetectDpiScale();

            Text = head;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(38, 54, 44);
            MaximizeBox = false;
            MinimizeBox = false;
            // 自己做缩放：交给 WinForms 自动缩放会和下面的手工计算叠加，变成双倍
            AutoScaleMode = AutoScaleMode.None;

            // 宽度上限取工作区宽度减去两侧各 24px 的边距，窄屏上也不会顶出去
            var workingArea = Screen.PrimaryScreen.WorkingArea;
            metrics = ToastLayout.Compute(
                uiScale, dpi, head, text1, text2, ToastLayout.DefaultMeasure,
                Math.Max(ToastLayout.MinTextWidth, workingArea.Width - 48));

            ClientSize = new Size(metrics.ClientWidth, metrics.ClientHeight);

            var title = new Label
            {
                Name = "toastTitle",
                Text = head,
                ForeColor = Color.FromArgb(247, 244, 233),
                Font = metrics.TitleFont,
                AutoSize = false,
                Bounds = metrics.Title
            };

            var line1 = new Label
            {
                Name = "toastLine1",
                Text = text1,
                ForeColor = Color.FromArgb(203, 214, 204),
                Font = metrics.LineFont,
                AutoSize = false,
                Bounds = metrics.Line1
            };

            var line2 = new Label
            {
                Name = "toastLine2",
                Text = text2,
                ForeColor = Color.FromArgb(203, 214, 204),
                Font = metrics.LineFont,
                AutoSize = false,
                Bounds = metrics.Line2
            };

            Controls.Add(title);
            Controls.Add(line1);
            Controls.Add(line2);

            // 贴在主屏右下角、任务栏上方；窗口比预期高时也不会算出屏幕外坐标
            Location = ToastLayout.PlaceBottomRight(workingArea, Width, Height, 24);

            life = new Timer { Interval = 100 };
            life.Tick += (s, e) =>
            {
                elapsed += life.Interval;
                if (elapsed >= lifeMs)
                {
                    life.Stop();
                    Close();
                }
            };
            life.Start();

            Click += (s, e) => { life.Stop(); Close(); };
            foreach (Control control in Controls)
            {
                control.Click += (s, e) => { life.Stop(); Close(); };
            }
        }

        /// <summary>
        /// 探测当前屏幕的 DPI 比例（150% 屏返回 1.5）。
        /// 拿不到就按 100% 处理，保证不会因为探测失败把弹窗画歪。
        /// </summary>
        private static float DetectDpiScale()
        {
            try
            {
                using (var graphics = Graphics.FromHwnd(IntPtr.Zero))
                {
                    float scale = graphics.DpiX / 96f;
                    return (scale >= 0.75f && scale <= 4f) ? scale : 1f;
                }
            }
            catch { return 1f; }
        }

        /// <summary>窗体销毁时释放布局算出来的字体；漏掉的话每弹一次就漏两个 GDI 句柄。</summary>
        protected override void Dispose(bool disposing)
        {
            if (disposing && metrics != null)
            {
                if (metrics.TitleFont != null) metrics.TitleFont.Dispose();
                if (metrics.LineFont != null) metrics.LineFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
