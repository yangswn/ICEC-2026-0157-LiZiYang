using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace ClassBell
{
    /// <summary>
    /// 桌面浮窗：常驻桌面的一小块，只显示「下一项任务 + 倒计时」。
    ///
    /// 为什么需要：用户反馈「存在感太低、平时都挂在后台」，主窗口关了就想不起来用。
    /// 这一块的作用就是把下一项截止时间一直摆在眼前。
    ///
    /// 三条硬性约束（踩过就知道后果）：
    ///  1. 不抢焦点 —— 用 WS_EX_NOACTIVATE + ShowWithoutActivation，任何情况下都不调 Activate()，
    ///     否则用户正在打字时浮窗一刷新，输入框就丢了焦点。
    ///  2. 全屏应用时让路 —— 看视频、打游戏时浮窗挡在画面上会被骂。检测到前台全屏就隐藏。
    ///  3. 位置必须能找回来 —— 记住的位置可能落在已拔掉的显示器上，要能回落到主屏。
    /// </summary>
    internal sealed class FloatWindow : Form
    {
        /* ------------------------------------------------------------ Win32 */

        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")]
        private static extern IntPtr GetShellWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        private const uint MONITOR_DEFAULTTONEAREST = 2;

        /* -------------------------------------------------------- 外观参数 */

        private const double IdleOpacity = 0.92;
        private const int BaseWidth = 300;
        private const int BaseHeight = 84;
        private const int EdgeMargin = 24;

        // 与主界面 CSS 变量同一套色：米色纸面 + 墨色文字 + 金色强调
        private static readonly Color PaperColor = Color.FromArgb(243, 240, 231);
        private static readonly Color InkColor = Color.FromArgb(27, 39, 34);
        private static readonly Color MutedColor = Color.FromArgb(115, 123, 116);
        private static readonly Color LineColor = Color.FromArgb(213, 205, 187);
        private static readonly Color GoldColor = Color.FromArgb(200, 154, 68);
        private static readonly Color LateColor = Color.FromArgb(196, 85, 67);

        /* ------------------------------------------------------------ 状态 */

        private readonly MainForm owner;
        private readonly Label titleLabel;
        private readonly Label countdownLabel;
        private readonly Label tagLabel;
        private readonly Timer tickTimer;
        private readonly Timer fullscreenTimer;
        private readonly Timer fadeTimer;

        private TaskInfo current;
        private float uiScale = 1.1f;
        // 屏幕 DPI 比例（150% 缩放 = 1.5）。像素尺寸要乘它，字号不用 ——
        // Font 的点值由 GDI+ 按 DPI 自动放大，再乘一次就变成"大字塞小盒"。
        private float dpiScale = 1f;
        private bool dragging;
        private Point dragStart;
        private Point dragOrigin;
        private bool suppressHide;
        private int fadeStep;
        private bool hiddenForFullscreen;
        // 位置只在拖动结束时上报一次，拖动过程中不要每帧写设置
        private bool positionDirty;
        // 自己记双击：两次左键按下且时间/位置接近就算双击（不依赖系统 WM_LBUTTONDBLCLK）
        private DateTime lastClickAt = DateTime.MinValue;
        // 弹菜单前的前台窗口：菜单关掉后把焦点还回去
        private IntPtr focusBeforeMenu = IntPtr.Zero;
        private Point lastClickPoint;

        /// <summary>当前要显示的任务（宿主从 /api/state 里挑出来的）。</summary>
        internal sealed class TaskInfo
        {
            public string Title = "";
            public string Course = "";
            public DateTime? DueAt;
            public string Category = "";
            public bool Overdue;
        }

        internal FloatWindow(MainForm owner)
        {
            this.owner = owner;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = PaperColor;
            DoubleBuffered = true;
            // 92% 半透明：既看得出存在，又不至于糊住底下内容
            Opacity = IdleOpacity;
            Text = "课铃浮窗";

            titleLabel = new Label
            {
                AutoSize = false,
                BackColor = Color.Transparent,
                ForeColor = InkColor,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Bold),
                Text = "今天没有待办"
            };

            countdownLabel = new Label
            {
                AutoSize = false,
                BackColor = Color.Transparent,
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = ""
            };

            tagLabel = new Label
            {
                AutoSize = false,
                BackColor = Color.Transparent,
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleRight,
                Font = new Font("Microsoft YaHei UI", 8F),
                Text = ""
            };

            Controls.Add(titleLabel);
            Controls.Add(countdownLabel);
            Controls.Add(tagLabel);

            DetectDpiScale();
            ApplyScale(uiScale);
            BuildMenu();
            HookDrag();

            // 窗口本身也要绑：点在文字之间的空隙时事件落在窗体上，不绑就"双击没反应"。
            DoubleClick += (s, e) => OpenMain();
            titleLabel.DoubleClick += (s, e) => OpenMain();
            countdownLabel.DoubleClick += (s, e) => OpenMain();
            tagLabel.DoubleClick += (s, e) => OpenMain();

            // 倒计时每秒走，状态每 30 秒向宿主要一次（宿主已经把 30 秒轮询接好了）
            tickTimer = new Timer { Interval = 1000 };
            tickTimer.Tick += (s, e) => RenderCountdown();
            tickTimer.Start();

            fullscreenTimer = new Timer { Interval = 1500 };
            fullscreenTimer.Tick += (s, e) => SyncFullscreen();
            fullscreenTimer.Start();

            fadeTimer = new Timer { Interval = 40 };
            fadeTimer.Tick += (s, e) => FadeTick();
        }

        /// <summary>
        /// 不抢焦点的关键：这个属性让 Show() 不走激活流程。
        /// </summary>
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // NOACTIVATE：点击也不激活；TOOLWINDOW：不占 Alt+Tab
                cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        /* ------------------------------------------------------------ 菜单 */

        private void BuildMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开课铃", null, (s, e) => OpenMain());
            menu.Items.Add("设置", null, (s, e) => OpenMain("settings"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("隐藏浮窗", null, (s, e) => owner.HideFloatWindow());
            // 三个 Label 铺满整块，右键基本都落在它们身上。
            // 子控件不继承窗体的 ContextMenuStrip，必须逐个挂，否则右键永远没反应。
            ContextMenuStrip = menu;
            titleLabel.ContextMenuStrip = menu;
            countdownLabel.ContextMenuStrip = menu;
            tagLabel.ContextMenuStrip = menu;

            // 弹菜单前必须让窗口能激活：NOACTIVATE 的窗口弹 ToolStripDropDown 时拿不到焦点，
            // 菜单收不到"点别处"的消息就永远不关，一直盖在浮窗上把后续点击全吃掉。
            menu.Opening += (s2, e2) =>
            {
                focusBeforeMenu = GetForegroundWindow();
                AllowActivation(true);
                SetForegroundWindow(Handle);
            };
            menu.Closed += (s2, e2) =>
            {
                AllowActivation(false);
                // 焦点还给用户原来的窗口：他只是右键看了一下菜单，不该被打断
                if (focusBeforeMenu != IntPtr.Zero && focusBeforeMenu != Handle)
                {
                    try { SetForegroundWindow(focusBeforeMenu); } catch { }
                }
                focusBeforeMenu = IntPtr.Zero;
                PostMessage(Handle, 0x0000, IntPtr.Zero, IntPtr.Zero);
            };
        }

        /// <summary>在鼠标位置弹菜单。主动调用以保证"先允许激活、再弹"的顺序。</summary>
        private void ShowFloatMenu()
        {
            try
            {
                if (ContextMenuStrip == null) return;
                AllowActivation(true);
                SetForegroundWindow(Handle);
                ContextMenuStrip.Show(Cursor.Position);
            }
            catch { }
        }

        private void OpenMain(string page = null)
        {
            owner.OpenMainWindow(page);
        }

        /* ------------------------------------------------------------ 拖动 */

        /// <summary>
        /// 整块都能拖：三个 Label 也挂同一套事件，
        /// 否则鼠标落在文字上就拖不动（用户会以为浮窗坏了）。
        /// </summary>
        private void HookDrag()
        {
            foreach (Control control in AllDraggables())
            {
                control.MouseDown += OnDragStart;
                control.MouseMove += OnDragMove;
                control.MouseUp += OnDragEnd;
            }
        }

        private IEnumerable<Control> AllDraggables()
        {
            yield return this;
            yield return titleLabel;
            yield return countdownLabel;
            yield return tagLabel;
        }

        private void OnDragStart(object sender, MouseEventArgs e)
        {
            // 右键在这里就地处理：主动弹菜单比依赖 ContextMenuStrip 自动触发更可控
            if (e.Button == MouseButtons.Right)
            {
                ShowFloatMenu();
                return;
            }
            if (e.Button != MouseButtons.Left) return;

            // Clicks 是 WinForms 自己数的：第二下会是 2。
            // 比等 WM_LBUTTONDBLCLK / DoubleClick 事件可靠（那两条在这个窗口上实测不触发）。
            if (e.Clicks >= 2)
            {
                dragging = false;
                OpenMain();
                return;
            }
            Point screenPoint = sender == this ? PointToScreen(e.Location) : ((Control)sender).PointToScreen(e.Location);

            // 自己判双击：系统的双击消息在无边框/不抢焦点的窗口上不可靠，
            // 而且两次点击可能一次落 Label、一次落窗体背景，事件源都不一样。
            var now = DateTime.UtcNow;
            bool doubleClick = (now - lastClickAt).TotalMilliseconds < SystemInformation.DoubleClickTime
                && Math.Abs(screenPoint.X - lastClickPoint.X) <= 6
                && Math.Abs(screenPoint.Y - lastClickPoint.Y) <= 6;
            if (doubleClick)
            {
                lastClickAt = DateTime.MinValue;
                dragging = false;
                OpenMain();
                return;
            }
            lastClickAt = now;
            lastClickPoint = screenPoint;

            var point = sender == this ? e.Location : PointToClient(((Control)sender).PointToScreen(e.Location));
            dragging = true;
            // 这里不要设 Capture：捕获切换会把双击的第二下打断（实测只剩一次 MouseDown）。
            // 移出窗口收不到 MouseUp 的问题改由 MouseMove 里的按键检查兜底。
            positionDirty = false;
            dragStart = point;
            dragOrigin = Location;
        }

        private void OnDragMove(object sender, MouseEventArgs e)
        {
            if (!dragging) return;
            // 没有按键按着了说明 MouseUp 丢了（拖到窗口外松手），这里补一次收尾
            if (Control.MouseButtons == MouseButtons.None)
            {
                EndDrag();
                return;
            }
            var screen = sender == this ? PointToScreen(e.Location) : ((Control)sender).PointToScreen(e.Location);
            Location = new Point(screen.X - dragStart.X, screen.Y - dragStart.Y);
            positionDirty = true;
        }

        private void OnDragEnd(object sender, MouseEventArgs e)
        {
            EndDrag();
        }

        /// <summary>结束拖动：夹回可视区并记位置。松手才夹，拖动过程中夹会让窗口"粘"在边上。</summary>
        private void EndDrag()
        {
            if (!dragging) return;
            dragging = false;
            if (!positionDirty) return;
            positionDirty = false;
            Location = ClampToVisible(Location);
            owner.SaveFloatWindowPosition(Location);
        }

        /// <summary>
        /// 捕获被系统收走（Alt+Tab、弹窗抢焦点）时也算拖动结束，
        /// 否则 dragging 会一直为 true，窗口跟着光标乱跑。
        /// </summary>
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            EndDrag();
        }

        /* -------------------------------------------------------- 位置与缩放 */

        /// <summary>
        /// 按主界面字号档位缩放。BaseWidth/Height 是 100% 的尺寸，
        /// 再按 uiScale 线性放大，超出屏幕时靠 ClampToVisible 兜住。
        /// </summary>
        internal void ApplyScale(float scale)
        {
            if (scale < 0.8f) scale = 0.8f;
            if (scale > 1.8f) scale = 1.8f;
            uiScale = scale;

            float px = scale * dpiScale;
            int width = (int)Math.Round(BaseWidth * px);
            int height = (int)Math.Round(BaseHeight * px);
            Size = new Size(width, height);

            int pad = (int)Math.Round(16 * px);

            titleLabel.Bounds = new Rectangle(pad, (int)Math.Round(14 * px), width - pad * 2, (int)Math.Round(26 * px));
            countdownLabel.Bounds = new Rectangle(pad, (int)Math.Round(42 * px), width - pad * 2 - (int)Math.Round(60 * px), (int)Math.Round(22 * px));
            tagLabel.Bounds = new Rectangle(width - pad - (int)Math.Round(74 * px), (int)Math.Round(42 * px), (int)Math.Round(74 * px), (int)Math.Round(22 * px));

            titleLabel.Font = new Font("Microsoft YaHei UI", 10.5F * scale, FontStyle.Bold);
            countdownLabel.Font = new Font("Microsoft YaHei UI", 9F * scale, FontStyle.Regular);
            tagLabel.Font = new Font("Microsoft YaHei UI", 8F * scale, FontStyle.Regular);

            ApplyRoundRegion();
            if (!dragging) Location = ClampToVisible(Location);
        }

        /// <summary>
        /// 开关 WS_EX_NOACTIVATE。平时保持"点了也不抢焦点"，
        /// 只有弹右键菜单这种确实需要焦点的地方临时打开。
        /// </summary>
        private void AllowActivation(bool allowed)
        {
            try
            {
                int ex = GetWindowLong(Handle, -20);
                int next = allowed ? (ex & ~WS_EX_NOACTIVATE) : (ex | WS_EX_NOACTIVATE);
                if (next != ex) SetWindowLong(Handle, -20, next);
            }
            catch { }
        }

        /// <summary>读当前屏幕的 DPI 比例。拿不到就按 100% 处理。</summary>
        private void DetectDpiScale()
        {
            try
            {
                using (var graphics = Graphics.FromHwnd(IntPtr.Zero))
                {
                    dpiScale = graphics.DpiX / 96f;
                }
            }
            catch { dpiScale = 1f; }
            if (dpiScale < 0.75f || dpiScale > 4f) dpiScale = 1f;
        }

        /// <summary>圆角靠 Region 裁出来，比 TransparencyKey 干净（不会有一圈杂边）。</summary>
        private void ApplyRoundRegion()
        {
            int radius = (int)Math.Round(12 * uiScale * dpiScale);
            using (var path = new GraphicsPath())
            {
                int d = radius * 2;
                path.AddArc(0, 0, d, d, 180, 90);
                path.AddArc(Width - d - 1, 0, d, d, 270, 90);
                path.AddArc(Width - d - 1, Height - d - 1, d, d, 0, 90);
                path.AddArc(0, Height - d - 1, d, d, 90, 90);
                path.CloseFigure();
                var old = Region;
                Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }

        /// <summary>
        /// 把窗口夹回「仍然看得见」的范围。
        /// 拖动到屏幕外、或者记住的位置落在已断开的显示器上，都走这里。
        /// </summary>
        internal static Point ClampToVisible(Point point, Size size)
        {
            var screen = Screen.FromPoint(point);
            var area = screen.WorkingArea;

            // 位置完全不在任何屏幕里（拔掉显示器）→ 回主屏右下角
            if (!IsPointOnAnyScreen(point))
            {
                var primary = Screen.PrimaryScreen.WorkingArea;
                return new Point(primary.Right - size.Width - EdgeMargin, primary.Bottom - size.Height - EdgeMargin);
            }

            int x = Math.Max(area.Left, Math.Min(point.X, area.Right - size.Width));
            int y = Math.Max(area.Top, Math.Min(point.Y, area.Bottom - size.Height));
            return new Point(x, y);
        }

        private static bool IsPointOnAnyScreen(Point point)
        {
            foreach (var screen in Screen.AllScreens)
            {
                if (screen.Bounds.Contains(point)) return true;
            }
            return false;
        }

        private Point ClampToVisible(Point point)
        {
            return ClampToVisible(point, Size);
        }

        /// <summary>默认位置：主屏右下角，距边缘 24px。</summary>
        internal static Point DefaultPosition(Size size)
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            return new Point(area.Right - size.Width - EdgeMargin, area.Bottom - size.Height - EdgeMargin);
        }

        /* ---------------------------------------------------------- 全屏检测 */

        /// <summary>
        /// 前台窗口是否占满整块显示器。
        /// 用「窗口矩形 ⊇ 显示器矩形」判断，比查窗口样式可靠：
        /// 全屏视频、游戏、PPT 放映都会把窗口铺满，而普通最大化窗口会避开任务栏。
        /// </summary>
        internal static bool IsFullscreenForeground()
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero) return false;
            if (foreground == GetDesktopWindow() || foreground == GetShellWindow()) return false;

            // 桌面本身（Progman / WorkerW）铺满屏幕但不是"全屏应用"，别误判
            var cls = new StringBuilder(64);
            GetClassName(foreground, cls, cls.Capacity);
            string name = cls.ToString();
            if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd") return false;

            RECT windowRect;
            if (!GetWindowRect(foreground, out windowRect)) return false;

            IntPtr monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            if (!GetMonitorInfo(monitor, ref info)) return false;

            var mon = info.rcMonitor;
            // 容差 2px：有些全屏窗口会比自己显示器小一两像素
            return windowRect.Left <= mon.Left + 2
                && windowRect.Top <= mon.Top + 2
                && windowRect.Right >= mon.Right - 2
                && windowRect.Bottom >= mon.Bottom - 2;
        }

        private void SyncFullscreen()
        {
            try
            {
                bool fullscreen = IsFullscreenForeground();
                if (fullscreen && Visible)
                {
                    hiddenForFullscreen = true;
                    Hide();
                }
                else if (!fullscreen && hiddenForFullscreen && !suppressHide)
                {
                    hiddenForFullscreen = false;
                    // 这次回来不再"淡出"一次，直接显示
                    ShowWindowWithoutStealingFocus();
                }
            }
            catch { }
        }

        /// <summary>
        /// 显示但不抢焦点。Show() 配合 ShowWithoutActivation 已经够用，
        /// 这里额外确保 Opacity 回到正常值（可能刚从淡出里出来）。
        /// </summary>
        internal void ShowWindowWithoutStealingFocus()
        {
            if (IsDisposed) return;
            suppressHide = false;
            fadeTimer.Stop();
            Opacity = IdleOpacity;
            if (!Visible) Show();
        }

        /* ------------------------------------------------------------ 内容 */

        /// <summary>
        /// 宿主送来新的下一项任务。null 表示没有待办：
        /// 先显示「今天没有待办」，3 秒后再淡出。
        /// </summary>
        internal void SetTask(TaskInfo task)
        {
            current = task;
            if (task == null)
            {
                titleLabel.Text = "今天没有待办";
                countdownLabel.Text = "休息一下，或者安排点别的";
                countdownLabel.ForeColor = MutedColor;
                tagLabel.Text = "";
                ScheduledFadeOut();
                return;
            }

            titleLabel.Text = Shorten(task.Title, 18);
            titleLabel.ForeColor = task.Overdue ? LateColor : InkColor;
            tagLabel.Text = task.Category;
            countdownLabel.ForeColor = task.Overdue ? LateColor : MutedColor;
            RenderCountdown();
        }

        private void RenderCountdown()
        {
            if (current == null) return;
            if (!current.DueAt.HasValue)
            {
                countdownLabel.Text = "无截止时间";
                return;
            }
            var diff = current.DueAt.Value - DateTime.Now;
            bool late = diff.TotalSeconds < 0;
            var abs = diff.Duration();
            string core;
            if (abs.TotalDays >= 1) core = string.Format("{0} 天 {1:00} 小时", (int)abs.TotalDays, abs.Hours);
            else if (abs.TotalHours >= 1) core = string.Format("{0} 小时 {1:00} 分", (int)abs.TotalHours, abs.Minutes);
            else if (abs.TotalMinutes >= 1) core = string.Format("{0} 分 {1:00} 秒", (int)abs.TotalMinutes, abs.Seconds);
            else core = string.Format("{0} 秒", abs.Seconds);

            countdownLabel.Text = (late ? "已超时 " : "还有 ") + core;
            countdownLabel.ForeColor = late ? LateColor : MutedColor;
        }

        private static string Shorten(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max) + "…";
        }

        /* ------------------------------------------------------------ 淡出 */

        /// <summary>
        /// 没有待办时淡出。3 秒缓冲是给用户看清「今天没有待办」这句话的机会，
        /// 淡完就隐藏，不占屏幕。
        /// </summary>
        private void ScheduledFadeOut()
        {
            if (!Visible) return;
            fadeStep = -1;
            fadeTimer.Stop();
            var delay = new Timer { Interval = 3000 };
            delay.Tick += (s, e) =>
            {
                delay.Stop();
                delay.Dispose();
                if (current != null) return;   // 这 3 秒里又来了新任务，就别淡出了
                fadeStep = 0;
                fadeTimer.Start();
            };
            delay.Start();
        }

        private void FadeTick()
        {
            if (fadeStep < 0) { fadeTimer.Stop(); return; }
            fadeStep += 1;
            double next = IdleOpacity - fadeStep * 0.09;
            if (next <= 0.02)
            {
                fadeTimer.Stop();
                Opacity = IdleOpacity;   // 复位，下次显示还是 92%
                if (!hiddenForFullscreen) Hide();
                return;
            }
            Opacity = next;
        }

        /* ------------------------------------------------------------ 交互 */



        protected override void OnMouseEnter(EventArgs e2)
        {
            base.OnMouseEnter(e2);
            if (!Visible) return;
            fadeTimer.Stop();
            Opacity = 1.0;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!Visible || dragging) return;
            Opacity = IdleOpacity;
        }

        /// <summary>
        /// 浮窗永远不主动退出：用户点它的关闭区域（这里没有）或者系统关它时，
        /// 只隐藏，下次状态刷新还能再出来。
        /// </summary>
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (tickTimer != null) { tickTimer.Stop(); tickTimer.Dispose(); }
                if (fullscreenTimer != null) { fullscreenTimer.Stop(); fullscreenTimer.Dispose(); }
                if (fadeTimer != null) { fadeTimer.Stop(); fadeTimer.Dispose(); }
            }
            base.Dispose(disposing);
        }
    }
}