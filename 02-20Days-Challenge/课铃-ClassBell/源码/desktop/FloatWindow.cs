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
    /// 桌面浮窗：常驻桌面的一小块，显示「接下来要做的几项任务 + 倒计时」。
    ///
    /// 为什么需要：用户反馈「存在感太低、平时都挂在后台」，主窗口关了就想不起来用。
    /// 这一块的作用就是把最近的截止时间一直摆在眼前。
    ///
    /// 三条硬性约束（踩过就知道后果）：
    ///  1. 不抢焦点 —— 用 WS_EX_NOACTIVATE + ShowWithoutActivation，任何情况下都不调 Activate()，
    ///     否则用户正在打字时浮窗一刷新，输入框就丢了焦点。
    ///  2. 全屏应用时让路 —— 看视频、打游戏时浮窗挡在画面上会被骂。检测到前台全屏就隐藏。
    ///  3. 位置必须能找回来 —— 记住的位置可能落在已拔掉的显示器上，要能回落到主屏。
    ///
    /// 1.11.0 起支持「同时显示 1~3 条」与「连续调节透明度」：
    ///  - 条数上限 3：浮窗宽度只有 300（100% 下），再多就把桌面竖着占掉一大截；
    ///    而且用户扫一眼能处理的信息也就三条，再多不如回主窗口看。
    ///  - 三条的布局是固定的（不是动态增删控件）：三个 Label 行一直存在，
    ///    只按条数决定显示几行、各放哪儿。这样不会因为频繁增删控件闪一下。
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
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
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

        // SetWindowPos 的标志位：只改 z 序，不动位置尺寸、不激活窗口
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;

        /* -------------------------------------------------------- 外观参数 */

        /// <summary>透明度默认值。与 1.9.0 的常量一致，老用户升级后观感不变。</summary>
        internal const double DefaultOpacity = 0.92;

        /// <summary>
        /// 透明度下限 0.30。
        /// 理由：浮窗是米白纸面 + 深墨文字，压到 30% 以下叠在浅色壁纸上时对比度已经不够，
        /// 「看得见但看不清」比「看不见」更糟；而且太透之后用户也找不到可拖拽的边界。
        /// </summary>
        internal const double MinOpacity = 0.30;

        private const int BaseWidth = 300;
        /// <summary>1 条任务时的基准高度，保持 1.10.3 的外观不变。</summary>
        private const int BaseHeight = 84;
        /// <summary>每多显示一条任务，窗口增加的高度（单行 + 间距）。</summary>
        private const int ExtraRowStride = 28;
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
        // 三行固定存在：index 0 是"最要紧的一条"（两行排版），1/2 是单行
        private readonly Label[] titleLabels = new Label[3];
        private readonly Label[] countdownLabels = new Label[3];
        private readonly Label tagLabel;
        // 主条目右上角那行小字：「下次 明天 12:40」。同系列还有下一期时才显示。
        private readonly Label nextLabel;
        private readonly Timer tickTimer;
        private readonly Timer fullscreenTimer;
        private readonly Timer fadeTimer;

        private readonly List<TaskInfo> current = new List<TaskInfo>();
        private int taskCount = 1;
        private double baseOpacity = DefaultOpacity;
        private bool fading;
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

        /// <summary>当前要显示的任务（宿主从 /api/state 里挑好、排好序送来的）。</summary>
        internal sealed class TaskInfo
        {
            public string Id = "";
            public string Title = "";
            public string Course = "";
            public DateTime? DueAt;
            public string Category = "";
            public string Priority = "normal";
            // 系列键：同一系列的多期只在浮窗占一格（宿主已经分好组，这里只用于显示"下次"）
            public string SeriesId = "";
            // 同一系列的下一期时间；没有下一期就是 null，界面不显示那行小字
            public DateTime? NextDueAt;
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
            Opacity = baseOpacity;
            Text = "课铃浮窗";

            for (int i = 0; i < titleLabels.Length; i += 1)
            {
                titleLabels[i] = NewLabel(ContentAlignment.MiddleLeft);
                countdownLabels[i] = NewLabel(ContentAlignment.MiddleRight);
                // 起个名字：探针要单独确认"倒计时没被截断"，UIA 排查时也认得出是哪块
                titleLabels[i].Name = "title" + i;
                countdownLabels[i].Name = "countdown" + i;
                Controls.Add(titleLabels[i]);
                Controls.Add(countdownLabels[i]);
            }

            tagLabel = NewLabel(ContentAlignment.MiddleRight);
            nextLabel = NewLabel(ContentAlignment.MiddleRight);
            tagLabel.Name = "tag";
            nextLabel.Name = "next";
            Controls.Add(nextLabel);
            Controls.Add(tagLabel);

            DetectDpiScale();
            ApplyScale(uiScale);
            BuildMenu();
            HookDrag();

            // 窗口本身也要绑：点在文字之间的空隙时事件落在窗体上，不绑就"双击没反应"。
            DoubleClick += (s, e) => OpenMain();

            // 倒计时每秒走，状态每 30 秒向宿主要一次（宿主已经把 30 秒轮询接好了）
            tickTimer = new Timer { Interval = 1000 };
            tickTimer.Tick += (s, e) => RenderCountdowns();
            tickTimer.Start();

            fullscreenTimer = new Timer { Interval = 1500 };
            fullscreenTimer.Tick += (s, e) => SyncFullscreen();
            fullscreenTimer.Start();

            fadeTimer = new Timer { Interval = 40 };
            fadeTimer.Tick += (s, e) => FadeTick();
        }

        private static Label NewLabel(ContentAlignment align)
        {
            return new Label
            {
                AutoSize = false,
                BackColor = Color.Transparent,
                ForeColor = InkColor,
                TextAlign = align,
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = ""
            };
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
            // Label 铺满整块，右键基本都落在它们身上。
            // 子控件不继承窗体的 ContextMenuStrip，必须逐个挂，否则右键永远没反应。
            ContextMenuStrip = menu;

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
        /// 整块都能拖：所有 Label 也挂同一套事件，
        /// 否则鼠标落在文字上就拖不动（用户会以为浮窗坏了）。
        /// </summary>
        private void HookDrag()
        {
            foreach (Control control in AllDraggables())
            {
                control.MouseDown += OnDragStart;
                control.MouseMove += OnDragMove;
                control.MouseUp += OnDragEnd;
                control.DoubleClick += (s, e) => OpenMain();
                control.ContextMenuStrip = ContextMenuStrip;
            }
        }

        private IEnumerable<Control> AllDraggables()
        {
            yield return this;
            for (int i = 0; i < titleLabels.Length; i += 1)
            {
                yield return titleLabels[i];
                yield return countdownLabels[i];
            }
            yield return tagLabel;
            yield return nextLabel;
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

        /// <summary>设置同时显示几条（1~3）。改完立刻重排，不用等下次刷新。</summary>
        internal void SetTaskCount(int count)
        {
            int next = Math.Max(1, Math.Min(titleLabels.Length, count));
            if (next == taskCount) return;
            taskCount = next;
            ApplyScale(uiScale);
        }

        /// <summary>
        /// 把浮窗重新提到最前，但不激活、不抢焦点。
        /// 设置页拖透明度时调用：主界面窗口可能盖住浮窗，用户看不到效果就没法判断。
        /// </summary>
        internal void KeepOnTopWithoutFocus()
        {
            if (IsDisposed || !Visible) return;
            try
            {
                SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch { }
        }

        /// <summary>
        /// 设置浮窗透明度（0.30~1.00）。
        /// 淡出过程中不接管，避免和淡出的每一帧打架。
        /// </summary>
        internal void SetBaseOpacity(double opacity)
        {
            double next = Math.Max(MinOpacity, Math.Min(1.0, opacity));
            baseOpacity = next;
            if (!fading && Visible) Opacity = next;
        }

        internal double BaseOpacity
        {
            get { return baseOpacity; }
        }

        /// <summary>
        /// 按主界面字号档位 + 条数重排。
        /// 宽高都以 100% 下的基准值乘 uiScale × dpiScale；
        /// 高度随条数线性增加（每条多一行），所以 1 条时的外观与旧版完全一致。
        /// </summary>
        internal void ApplyScale(float scale)
        {
            if (scale < 0.8f) scale = 0.8f;
            if (scale > 1.8f) scale = 1.8f;
            uiScale = scale;

            float px = scale * dpiScale;
            int count = Math.Max(1, Math.Min(titleLabels.Length, taskCount));

            int width = (int)Math.Round(BaseWidth * px);
            int height = (int)Math.Round((BaseHeight + (count - 1) * ExtraRowStride) * px);
            Size = new Size(width, height);

            int pad = (int)Math.Round(16 * px);
            int titleH = (int)Math.Round(26 * px);
            int lineH = (int)Math.Round(22 * px);
            int gap = (int)Math.Round(6 * px);
            int tagW = (int)Math.Round(74 * px);
            // 单行条目右侧留出倒计时的位置；主条目第二行也要让出 tag 的宽度
            int rightW = (int)Math.Round(96 * px);

            // 第一条：标题一行 + （倒计时 | 优先级标签）一行
            titleLabels[0].Bounds = new Rectangle(pad, (int)Math.Round(14 * px), width - pad * 2, titleH);
            countdownLabels[0].Bounds = new Rectangle(pad, (int)Math.Round(42 * px), width - pad * 2 - tagW - gap, lineH);
            tagLabel.Bounds = new Rectangle(width - pad - tagW, (int)Math.Round(42 * px), tagW, lineH);

            // 第二、三条：单行「标题 …… 倒计时」
            int firstExtraY = (int)Math.Round(70 * px);
            int stride = (int)Math.Round(ExtraRowStride * px);
            for (int i = 1; i < titleLabels.Length; i += 1)
            {
                int y = firstExtraY + (i - 1) * stride;
                titleLabels[i].Bounds = new Rectangle(pad, y, width - pad * 2 - rightW - gap, lineH);
                countdownLabels[i].Bounds = new Rectangle(width - pad - rightW, y, rightW, lineH);
            }

            // 字号只乘 uiScale：点值由 GDI+ 按 DPI 放大，再乘 dpiScale 就成了"大字塞小盒"
            RebuildFont(titleLabels[0], 10.5F * scale, FontStyle.Bold);
            RebuildFont(tagLabel, 8F * scale, FontStyle.Regular);
            RebuildFont(countdownLabels[0], 9F * scale, FontStyle.Regular);
            for (int i = 1; i < titleLabels.Length; i += 1)
            {
                RebuildFont(titleLabels[i], 9F * scale, FontStyle.Regular);
                RebuildFont(countdownLabels[i], 8.5F * scale, FontStyle.Regular);
            }

            ApplyVisibility();
            // 字号和宽度都变了：重排一次（倒计时重新量宽、标题重新截断）
            LayoutRows();
            ApplyRoundRegion();
            if (!dragging) Location = ClampToVisible(Location);
        }

        /// <summary>旧字体要释放，否则每换一次档位就漏一批 GDI 句柄。</summary>
        private static void RebuildFont(Label label, float size, FontStyle style)
        {
            var old = label.Font;
            label.Font = new Font("Microsoft YaHei UI", size, style);
            if (old != null) old.Dispose();
        }

        /// <summary>按当前条数和任务数决定哪些行可见。</summary>
        private void ApplyVisibility()
        {
            int count = Math.Max(1, Math.Min(titleLabels.Length, taskCount));
            for (int i = 0; i < titleLabels.Length; i += 1)
            {
                bool used = i < count;
                titleLabels[i].Visible = used;
                countdownLabels[i].Visible = used;
            }
            tagLabel.Visible = count >= 1;
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
        /// 这里额外把透明度复位到用户设置的值（可能刚从淡出里出来）。
        /// </summary>
        internal void ShowWindowWithoutStealingFocus()
        {
            if (IsDisposed) return;
            suppressHide = false;
            fading = false;
            fadeTimer.Stop();
            Opacity = baseOpacity;
            if (!Visible) Show();
        }

        /* ------------------------------------------------------------ 内容 */

        /// <summary>
        /// 宿主送来排好序的若干条任务（最多 3 条）。
        /// 空列表表示没有待办：先显示「今天没有待办」，3 秒后再淡出。
        /// </summary>
        internal void SetTasks(IList<TaskInfo> tasks)
        {
            current.Clear();
            if (tasks != null)
            {
                foreach (var task in tasks)
                {
                    if (task != null) current.Add(task);
                }
            }

            ApplyVisibility();

            if (current.Count == 0)
            {
                for (int i = 0; i < titleLabels.Length; i += 1)
                {
                    titleLabels[i].Text = "";
                    countdownLabels[i].Text = "";
                }
                nextLabel.Text = "";
                titleLabels[0].Text = "今天没有待办";
                titleLabels[0].ForeColor = InkColor;
                countdownLabels[0].Text = "休息一下，或者安排点别的";
                countdownLabels[0].ForeColor = MutedColor;
                tagLabel.Text = "";
                ScheduledFadeOut();
                return;
            }

            for (int i = 0; i < titleLabels.Length; i += 1)
            {
                if (i >= current.Count) continue;
                // 颜色 = 优先级：紧急红 / 重要金 / 普通墨色。
                // 过期不用颜色区分（倒计时的"超"已经说清楚了），这样两个信号不打架。
                titleLabels[i].ForeColor = PriorityColor(current[i].Priority);
                countdownLabels[i].ForeColor = MutedColor;
            }

            var first = current[0];
            tagLabel.Text = PriorityTag(first);
            tagLabel.ForeColor = PriorityColor(first.Priority);
            nextLabel.Text = FormatNextHint(first.NextDueAt);

            LayoutRows();
        }

        /// <summary>
        /// 重排所有行：先给倒计时量出它真正需要的宽度，剩下的才给标题。
        ///
        /// 为什么要按文字反推宽度：倒计时是**必须完整可读**的信息
        /// （「1 天 01 …」看不出是小时还是分钟），只能让标题去让位。
        /// 标题放不下时截断加省略号，这是可以接受的损失。
        /// </summary>
        private void LayoutRows()
        {
            int count = Math.Max(1, Math.Min(titleLabels.Length, taskCount));
            int pad = (int)Math.Round(16 * uiScale * dpiScale);
            int gap = (int)Math.Round(6 * uiScale * dpiScale);
            int rowWidth = Math.Max(1, ClientSize.Width - pad * 2);
            int titleH = titleLabels[0].Height;

            // 主条目：标题行右侧留给"下次 …"小字
            int hintWidth = 0;
            if (!string.IsNullOrEmpty(nextLabel.Text))
            {
                hintWidth = MeasureWidth(nextLabel.Text, nextLabel.Font) + gap;
                nextLabel.Bounds = new Rectangle(ClientSize.Width - pad - hintWidth + gap, titleLabels[0].Top, hintWidth - gap, Math.Max(1, titleH));
            }
            nextLabel.Visible = hintWidth > 0;

            for (int i = 0; i < titleLabels.Length; i += 1)
            {
                bool used = i < count && i < current.Count;
                if (!used)
                {
                    titleLabels[i].Text = "";
                    countdownLabels[i].Text = "";
                    continue;
                }

                var task = current[i];
                string dueText = FormatCountdown(task.DueAt);
                countdownLabels[i].Text = dueText;

                int dueWidth = MeasureWidth(dueText, countdownLabels[i].Font);

                if (i == 0)
                {
                    // 第一行：标题（右侧扣掉小字）；第二行：倒计时 + 优先级标签
                    int titleWidth = Math.Max(40, rowWidth - (hintWidth > 0 ? hintWidth : 0));
                    titleLabels[0].Bounds = new Rectangle(pad, titleLabels[0].Top, titleWidth, Math.Max(1, titleH));
                    int tagWidth = tagLabel.Width;
                    int dueRoom = Math.Max(40, rowWidth - tagWidth - gap);
                    dueWidth = Math.Min(dueWidth, dueRoom);
                    countdownLabels[0].Bounds = new Rectangle(pad, countdownLabels[0].Top, dueWidth, countdownLabels[0].Height);
                }
                else
                {
                    // 后面几行：单行「标题 …… 倒计时」，倒计时先占位
                    int rowTop = titleLabels[i].Top;
                    int lineH = Math.Max(1, countdownLabels[i].Height);
                    countdownLabels[i].Bounds = new Rectangle(ClientSize.Width - pad - dueWidth, rowTop, dueWidth, lineH);
                    int titleWidth = Math.Max(40, rowWidth - dueWidth - gap);
                    titleLabels[i].Bounds = new Rectangle(pad, rowTop, titleWidth, lineH);
                }

                titleLabels[i].Text = FitOneLine(task.Title, titleLabels[i].Font, titleLabels[i].Bounds.Width);
            }
        }

        /// <summary>量一段单行文字的真实宽度（含少量余量，避免刚好差一像素又显示省略号）。</summary>
        private static int MeasureWidth(string text, Font font)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            const TextFormatFlags flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPadding;
            return TextRenderer.MeasureText(text, font, new Size(int.MaxValue, int.MaxValue), flags).Width + 4;
        }

        /// <summary>
        /// 倒计时文案。压紧成「1 天 1 时」「1 时 52 分」「22 分」这种短格式，
        /// 这样即使后面几行只有半行宽也放得下 —— 前提是这几个字必须完整出现。
        /// 超时用「超」开头，比原来的「已超时 」短一半。
        /// </summary>
        private static string FormatCountdown(DateTime? dueAt)
        {
            if (!dueAt.HasValue) return "无截止";
            var diff = dueAt.Value - DateTime.Now;
            bool late = diff.TotalSeconds < 0;
            var abs = diff.Duration();
            string core;
            if (abs.TotalDays >= 1)
            {
                int days = (int)abs.TotalDays;
                core = abs.Hours > 0 ? string.Format("{0} 天 {1} 时", days, abs.Hours) : string.Format("{0} 天", days);
            }
            else if (abs.TotalHours >= 1)
            {
                int hours = (int)abs.TotalHours;
                core = abs.Minutes > 0 ? string.Format("{0} 时 {1} 分", hours, abs.Minutes) : string.Format("{0} 时", hours);
            }
            else if (abs.TotalMinutes >= 1)
            {
                core = string.Format("{0} 分", (int)abs.TotalMinutes);
            }
            else
            {
                core = string.Format("{0} 秒", Math.Max(0, abs.Seconds));
            }
            return late ? "超 " + core : core;
        }

        /// <summary>
        /// 「下次 明天 12:40」这行小字。没有下一期就返回空串（界面不占位）。
        /// 日期用相对说法：今天 / 明天 / 周X / 月日，都是为了短。
        /// </summary>
        private static string FormatNextHint(DateTime? nextDueAt)
        {
            if (!nextDueAt.HasValue) return "";
            var due = nextDueAt.Value;
            var today = DateTime.Now.Date;
            string day;
            if (due.Date == today) day = "今天";
            else if (due.Date == today.AddDays(1)) day = "明天";
            else if (due.Date > today && due.Date <= today.AddDays(6)) day = "周" + "日一二三四五六"[(int)due.DayOfWeek];
            else day = string.Format("{0}月{1}日", due.Month, due.Day);
            return string.Format("下次 {0} {1:00}:{2:00}", day, due.Hour, due.Minute);
        }
        /// <summary>
        /// 把文字压成单行：放不下就截断并补省略号。
        /// 不用 Label.AutoEllipsis —— 那个只管"超出宽度"，折行还是会发生；
        /// 这里自己量，量完再截，行高就是稳的。
        /// </summary>
        private static string FitOneLine(string text, Font font, int width)
        {
            if (string.IsNullOrEmpty(text)) return "";
            if (width <= 0) return text;
            var flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPadding;
            var unbounded = new Size(int.MaxValue, int.MaxValue);
            if (TextRenderer.MeasureText(text, font, unbounded, flags).Width <= width) return text;

            // 二分找"最长的、加省略号后仍放得下"的前缀，比逐字减快得多
            int low = 0;
            int high = text.Length;
            while (low < high)
            {
                int mid = (low + high + 1) / 2;
                string candidate = text.Substring(0, mid) + "…";
                if (TextRenderer.MeasureText(candidate, font, unbounded, flags).Width <= width) low = mid;
                else high = mid - 1;
            }
            return low <= 0 ? "…" : text.Substring(0, low) + "…";
        }

        /// <summary>宿主只送一条时的兼容入口。</summary>
        internal void SetTask(TaskInfo task)
        {
            SetTasks(task == null ? null : new List<TaskInfo> { task });
        }

        /// <summary>优先级 → 文字颜色。普通用墨色而不是灰色，保证低优先级也看得清。</summary>
        private static Color PriorityColor(string priority)
        {
            switch (priority)
            {
                case "urgent": return LateColor;
                case "important": return GoldColor;
                default: return InkColor;
            }
        }

        /// <summary>
        /// 主条目右侧那个小标签：有优先级就写优先级（最醒目），
        /// 普通优先级则退回去显示任务类型，避免占着地方却不提供信息。
        /// </summary>
        private static string PriorityTag(TaskInfo task)
        {
            if (task.Priority == "urgent") return "紧急";
            if (task.Priority == "important") return "重要";
            return string.IsNullOrEmpty(task.Category) ? "" : task.Category;
        }

        /// <summary>
        /// 每秒刷新倒计时。文案变了才重排 —— 宽度是按文字量出来的，
        /// 不重排的话「59 分」跳到「1 时 0 分」时宽度不够会被截。
        /// </summary>
        private void RenderCountdowns()
        {
            bool changed = false;
            for (int i = 0; i < current.Count && i < countdownLabels.Length; i += 1)
            {
                var task = current[i];
                string text = FormatCountdown(task.DueAt);
                bool late = task.DueAt.HasValue && task.DueAt.Value < DateTime.Now;
                if (countdownLabels[i].Text != text)
                {
                    countdownLabels[i].Text = text;
                    changed = true;
                }
                countdownLabels[i].ForeColor = late ? LateColor : MutedColor;
            }
            if (changed) LayoutRows();
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
            fading = false;
            fadeTimer.Stop();
            var delay = new Timer { Interval = 3000 };
            delay.Tick += (s, e) =>
            {
                delay.Stop();
                delay.Dispose();
                if (current.Count > 0) return;   // 这 3 秒里又来了新任务，就别淡出了
                fadeStep = 0;
                fading = true;
                fadeTimer.Start();
            };
            delay.Start();
        }

        /// <summary>
        /// 逐帧降透明度。
        /// 基线是「用户设置的透明度」而不是写死的 0.92 —— 否则把透明度调到 40% 的用户
        /// 会在淡出时突然跳回 92% 再往下掉，看着像闪了一下。
        /// </summary>
        private void FadeTick()
        {
            if (fadeStep < 0) { fadeTimer.Stop(); fading = false; return; }
            fadeStep += 1;
            double next = baseOpacity - fadeStep * 0.09;
            if (next <= 0.02)
            {
                fadeTimer.Stop();
                fading = false;
                Opacity = baseOpacity;   // 复位，下次显示还是用户设的那个值
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
            fading = false;
            Opacity = 1.0;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!Visible || dragging) return;
            Opacity = baseOpacity;
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
                for (int i = 0; i < titleLabels.Length; i += 1)
                {
                    if (titleLabels[i] != null && titleLabels[i].Font != null) titleLabels[i].Font.Dispose();
                    if (countdownLabels[i] != null && countdownLabels[i].Font != null) countdownLabels[i].Font.Dispose();
                }
                if (tagLabel != null && tagLabel.Font != null) tagLabel.Font.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}