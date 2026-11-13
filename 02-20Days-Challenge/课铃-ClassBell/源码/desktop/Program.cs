using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ClassBell
{
    internal static class Program
    {
        /// <summary>
        /// 单实例锁的名字。
        ///
        /// 关键点：
        ///  1. 必须带 `Local\` 前缀：跨会话/服务场景下才不会跑到 Global 命名空间；
        ///  2. **便携版与安装版必须共用同一个名字** —— 它们共用同一个 WebView2
        ///     用户数据目录（%APPDATA%\ClassBell\WebView2），而该目录同一时间只能被
        ///     一组进程独占。两个实例同时初始化 WebView2 会直接 E_ABORT。
        /// </summary>
        private const string MutexName = @"Local\ClassBell.SingleInstance";

        /// <summary>已有实例时，通知它把窗口叫到前台用的窗口消息。</summary>
        private const string ShowMessageName = "ClassBell.ShowWindow";

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string message);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [STAThread]
        private static void Main(string[] args)
        {
            // 诊断模式（自动化测试用）：两个独立进程分别「占住」和「尝试抢占」同名互斥体
            if (Array.IndexOf(args, "--self-test-hold") >= 0)
            {
                RunMutexHold(args);
                return;
            }
            if (Array.IndexOf(args, "--self-test-try") >= 0)
            {
                RunMutexTry(args);
                return;
            }

            // 逃生通道：调试两个版本时跳过检测
            bool allowMulti = Array.IndexOf(args, "--allow-multi") >= 0;

            Mutex mutex = null;
            bool createdNew = true;
            if (!allowMulti)
            {
                try
                {
                    // 注意：这一步必须在 WebView2 初始化（MainForm.StartAsync）之前完成，
                    // 否则会先崩在 E_ABORT，再判断就没意义了。
                    mutex = new Mutex(true, MutexName, out createdNew);
                }
                catch
                {
                    // 拿不到互斥体（极端权限问题）时不要阻止启动
                    createdNew = true;
                }
            }

            if (!createdNew)
            {
                bool raised = TryActivateExistingInstance();
                ShowAlreadyRunning(raised);
                if (mutex != null)
                {
                    try { mutex.Dispose(); } catch { }
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool hidden = Array.IndexOf(args, "--hidden") >= 0;
            try
            {
                Application.Run(new MainForm(hidden));
            }
            finally
            {
                // 正常退出时释放锁，避免下次启动被自己挡住
                if (mutex != null)
                {
                    try { mutex.ReleaseMutex(); } catch { }
                    try { mutex.Dispose(); } catch { }
                }
            }
        }

        /// <summary>
        /// 已有实例在跑：用一句人话告诉用户，而不是抛出 E_ABORT。
        /// </summary>
        private static void ShowAlreadyRunning(bool raised)
        {
            string body = "课铃已经在运行了（图标可能在右下角 ^ 里）。\r\n\r\n"
                        + "要从托盘打开，或先退出正在运行的课铃再启动本次。";
            if (raised)
            {
                body += "\r\n\r\n已尝试把已打开的课铃窗口切到前台。";
            }
            try
            {
                MessageBox.Show(body, "课铃已经在运行",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch { }
        }

        /// <summary>
        /// 尽力把已有实例的窗口叫到前台：先广播自定义窗口消息，
        /// 再退化为“按标题找窗口 → ShowWindow”。全部失败也不影响主流程。
        /// </summary>
        private static bool TryActivateExistingInstance()
        {
            bool signalled = false;

            try
            {
                int msg = RegisterWindowMessage(ShowMessageName);
                if (msg != 0)
                {
                    PostMessage((IntPtr)0xFFFF, msg, IntPtr.Zero, IntPtr.Zero);
                    signalled = true;
                }
            }
            catch { }

            try
            {
                using (var show = EventWaitHandle.OpenExisting("ClassBell.ShowWindow"))
                {
                    show.Set();
                    signalled = true;
                }
            }
            catch { }

            return BringExistingToFront() || signalled;
        }

        private static bool BringExistingToFront()
        {
            int current = Process.GetCurrentProcess().Id;
            IntPtr found = IntPtr.Zero;

            try
            {
                EnumWindows((hWnd, lParam) =>
                {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    if (pid == current) return true;

                    var title = new StringBuilder(256);
                    GetWindowText(hWnd, title, title.Capacity);
                    if (title.ToString().StartsWith("课铃 ClassBell", StringComparison.Ordinal))
                    {
                        found = hWnd;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch { }

            if (found != IntPtr.Zero)
            {
                try
                {
                    // 隐藏到托盘的窗口需要先显示再激活
                    ShowWindow(found, 9);
                    SetForegroundWindow(found);
                    return true;
                }
                catch { }
            }

            // 退路：按进程找主窗口
            try
            {
                foreach (var process in Process.GetProcessesByName("ClassBell"))
                {
                    if (process.Id == current) continue;
                    var handle = process.MainWindowHandle;
                    if (handle == IntPtr.Zero) continue;
                    ShowWindow(handle, 9);
                    SetForegroundWindow(handle);
                    return true;
                }
            }
            catch { }

            return false;
        }

        /// <summary>诊断模式下允许指定互斥体名字，避免与正在运行的真实实例抢锁。</summary>
        private static string SelfTestMutexName(string[] args)
        {
            foreach (string arg in args)
            {
                if (arg.StartsWith("--mutex=", StringComparison.OrdinalIgnoreCase))
                {
                    string name = arg.Substring("--mutex=".Length).Trim();
                    if (!string.IsNullOrWhiteSpace(name)) return name;
                }
            }
            return MutexName;
        }

        /* ------------------------------------------------------- 诊断自测 */

        /// <summary>
        /// 自测：占住互斥体并告诉外部“已就绪”，保持一段时间（默认 20 秒）。
        /// 用法：ClassBell.exe --self-test-hold &lt;readyFile&gt; [holdMs]
        /// </summary>
        private static void RunMutexHold(string[] args)
        {
            int index = Array.IndexOf(args, "--self-test-hold");
            string readyFile = index + 1 < args.Length ? args[index + 1] : "";
            int holdMs = 20000;
            if (index + 2 < args.Length) int.TryParse(args[index + 2], out holdMs);

            bool created = false;
            string error = "";
            Mutex mutex = null;
            try
            {
                mutex = new Mutex(true, SelfTestMutexName(args), out created);
                if (!string.IsNullOrWhiteSpace(readyFile))
                {
                    File.WriteAllText(readyFile,
                        "{\"createdNew\":" + (created ? "true" : "false") + "}",
                        new UTF8Encoding(false));
                }
                Thread.Sleep(Math.Max(1000, holdMs));
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
            }
            finally
            {
                if (mutex != null)
                {
                    try { mutex.ReleaseMutex(); } catch { }
                    try { mutex.Dispose(); } catch { }
                }
            }
        }

        /// <summary>
        /// 自测：尝试抢占同名互斥体，把结果写成 JSON。
        /// 用法：ClassBell.exe --self-test-try &lt;outFile&gt;
        /// </summary>
        private static void RunMutexTry(string[] args)
        {
            int index = Array.IndexOf(args, "--self-test-try");
            string outFile = index + 1 < args.Length ? args[index + 1] : "";

            bool created = true;
            string error = "";
            try
            {
                using (var mutex = new Mutex(true, SelfTestMutexName(args), out created))
                {
                    // 只关心“能不能拿到”，拿到就立刻退出
                }
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
            }

            string json = "{\"createdNew\":" + (created ? "true" : "false")
                        + ",\"error\":\"" + (error ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
            try
            {
                if (!string.IsNullOrWhiteSpace(outFile))
                    File.WriteAllText(outFile, json, new UTF8Encoding(false));
            }
            catch { }
        }
    }
}
