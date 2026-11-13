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

        public TrayToastForm(int lifeMs = 6000)
        {
            this.lifeMs = lifeMs;

            Text = "课铃仍在运行";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(38, 54, 44);
            ClientSize = new Size(392, 116);
            MaximizeBox = false;
            MinimizeBox = false;

            var title = new Label
            {
                Text = "课铃正在后台运行",
                ForeColor = Color.FromArgb(247, 244, 233),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                AutoSize = false,
                Bounds = new Rectangle(18, 12, 356, 26)
            };

            var line1 = new Label
            {
                Text = "窗口已收进托盘（可能折叠在右下角的 ^ 里）",
                ForeColor = Color.FromArgb(203, 214, 204),
                Font = new Font("Microsoft YaHei UI", 9F),
                AutoSize = false,
                Bounds = new Rectangle(18, 42, 356, 22)
            };

            var line2 = new Label
            {
                Text = "Ctrl+Alt+B 找回窗口 · 右键托盘图标可退出",
                ForeColor = Color.FromArgb(203, 214, 204),
                Font = new Font("Microsoft YaHei UI", 9F),
                AutoSize = false,
                Bounds = new Rectangle(18, 64, 356, 22)
            };

            Controls.Add(title);
            Controls.Add(line1);
            Controls.Add(line2);

            // 贴在主屏右下角、任务栏上方
            var area = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(area.Right - Width - 24, area.Bottom - Height - 24);

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
    }
}
