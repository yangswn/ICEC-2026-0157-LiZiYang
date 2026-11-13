using System;
using System.Drawing;
using System.Windows.Forms;

namespace ClassBell
{
    /// <summary>
    /// 首次点窗口 × 时弹出的说明框。
    ///
    /// 为什么需要它：点 × 默认只是“隐藏到托盘”，程序继续跑才能到点提醒；
    /// 但这个过程是完全静默的，加上 Win11 会把托盘图标折叠进溢出区，
    /// 用户会误以为程序关不掉 —— 也就是“像流氓软件”的反馈来源。
    ///
    /// 这里明确告诉用户：程序还在跑、为什么还在跑、以及怎么真正退出。
    /// 只弹一次（closeHintShown 存服务端设置）。
    /// </summary>
    internal sealed class CloseHintDialog : Form
    {
        /// <summary>用户选择：true = 立即退出，false = 留在托盘继续用。</summary>
        public bool QuitChosen { get; private set; }

        public CloseHintDialog()
        {
            Text = "课铃会继续在后台运行";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(446, 268);
            BackColor = Color.FromArgb(247, 244, 236);
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label
            {
                Text = "课铃会留在系统托盘继续运行",
                Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
                ForeColor = Color.FromArgb(43, 58, 48),
                AutoSize = false,
                Bounds = new Rectangle(24, 20, 382, 30)
            };

            var body = new Label
            {
                Text = "这样到点才能提醒你。\r\n\r\n"
                     + "想完全退出：点下面「立即退出」，\r\n"
                     + "或右键托盘图标 →「退出课铃」（图标可能折叠在右下角的 ^ 里）。\r\n\r\n"
                     + "之后按 Ctrl+Alt+B 可以随时找回窗口。",
                ForeColor = Color.FromArgb(90, 100, 92),
                AutoSize = false,
                Bounds = new Rectangle(24, 58, 398, 118)
            };

            var hint = new Label
            {
                Text = "之后可以在「偏好设置 → 运行与同步」里关掉这个行为。",
                ForeColor = Color.FromArgb(130, 138, 128),
                Font = new Font("Microsoft YaHei UI", 8F),
                AutoSize = false,
                Bounds = new Rectangle(24, 182, 398, 22)
            };

            var keep = new Button
            {
                Text = "知道了，继续用",
                DialogResult = DialogResult.OK,
                Bounds = new Rectangle(150, 216, 130, 34),
                BackColor = Color.FromArgb(46, 74, 58),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            keep.FlatAppearance.BorderSize = 0;

            var quit = new Button
            {
                Text = "立即退出",
                DialogResult = DialogResult.Cancel,
                Bounds = new Rectangle(290, 216, 116, 34),
                BackColor = Color.FromArgb(196, 85, 67),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            quit.FlatAppearance.BorderSize = 0;
            quit.Click += (s, e) => { QuitChosen = true; };

            Controls.Add(title);
            Controls.Add(body);
            Controls.Add(hint);
            Controls.Add(keep);
            Controls.Add(quit);
            AcceptButton = keep;
            CancelButton = quit;
        }

        /// <summary>
        /// 弹出说明框并返回用户是否选择退出。
        /// 关闭对话框（Esc / 右上角）等同于“继续用”，不会误退出。
        /// </summary>
        public static bool Ask(IWin32Window owner)
        {
            using (var dialog = new CloseHintDialog())
            {
                dialog.ShowDialog(owner);
                return dialog.QuitChosen;
            }
        }
    }
}
