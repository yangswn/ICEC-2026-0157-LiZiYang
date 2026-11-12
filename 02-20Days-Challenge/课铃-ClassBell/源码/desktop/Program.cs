using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ClassBell
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
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
            bool created;
            using (var mutex = new Mutex(true, "ClassBell.WebView2.SingleInstance", out created))
            {
                if (!created)
                {
                    try
                    {
                        int msg = RegisterWindowMessage("ClassBell.ShowWindow");
                        PostMessage((IntPtr)0xFFFF, msg, IntPtr.Zero, IntPtr.Zero);
                    }
                    catch { }
                    try
                    {
                        using (var show = EventWaitHandle.OpenExisting("ClassBell.ShowWindow"))
                        {
                            show.Set();
                        }
                    }
                    catch { }
                    BringExistingToFront();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool hidden = Array.IndexOf(args, "--hidden") >= 0;
                Application.Run(new MainForm(hidden));
            }
        }

        private static void BringExistingToFront()
        {
            int current = Process.GetCurrentProcess().Id;
            IntPtr fallback = IntPtr.Zero;
            EnumWindows((hWnd, lParam) =>
            {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == current) return true;
                var title = new StringBuilder(256);
                GetWindowText(hWnd, title, title.Capacity);
                if (title.ToString() == "课铃 ClassBell")
                {
                    fallback = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);

            if (fallback != IntPtr.Zero)
            {
                ShowWindow(fallback, 9);
                SetForegroundWindow(fallback);
                return;
            }

            foreach (var process in Process.GetProcessesByName("ClassBell"))
            {
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(process.MainWindowHandle, 9);
                    SetForegroundWindow(process.MainWindowHandle);
                    return;
                }
            }
        }
    }
}
