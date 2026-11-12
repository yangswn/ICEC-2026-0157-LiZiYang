using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ClassBell.Setup
{
    internal static class Uninstaller
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassBell";

        [STAThread]
        private static void Main(string[] args)
        {
            bool silent = Array.IndexOf(args, "/S") >= 0 || Array.IndexOf(args, "--silent") >= 0;
            string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            if (!silent)
            {
                var answer = MessageBox.Show(
                    "确定要卸载课铃 ClassBell 吗？\n\n卸载程序会关闭正在运行的课铃。",
                    "卸载课铃 ClassBell", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
            }

            KillApp();
            try
            {
                DeleteShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "课铃 ClassBell.lnk"));
                string group = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "课铃 ClassBell");
                DeleteShortcut(Path.Combine(group, "课铃 ClassBell.lnk"));
                DeleteShortcut(Path.Combine(group, "卸载课铃.lnk"));
                try { if (Directory.Exists(group)) Directory.Delete(group, true); } catch { }

                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
                    Registry.CurrentUser.DeleteSubKeyTree(@"Software\ClassBell", false);
                    using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (run != null) run.DeleteValue("ClassBell", false);
                    }
                }
                catch { }

                bool keepData = true;
                if (!silent)
                {
                    var data = MessageBox.Show(
                        "是否保留本机的日程与运行日志？\n\n选择“否”将删除 %APPDATA%\\ClassBell 下的全部数据。",
                        "保留本机数据", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    keepData = data == DialogResult.Yes;
                }
                if (!keepData)
                {
                    string appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ClassBell");
                    try { if (Directory.Exists(appData)) Directory.Delete(appData, true); } catch { }
                }

                foreach (string file in Directory.GetFiles(dir))
                {
                    if (string.Equals(file, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)) continue;
                    try { File.Delete(file); } catch { }
                }
                foreach (string sub in Directory.GetDirectories(dir))
                {
                    try { Directory.Delete(sub, true); } catch { }
                }

                var cleanup = new ProcessStartInfo("cmd.exe",
                    "/c timeout /t 2 /nobreak >nul & rmdir /s /q \"" + dir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process.Start(cleanup);

                if (!silent)
                    MessageBox.Show("课铃 ClassBell 已卸载。", "卸载完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                if (!silent)
                    MessageBox.Show("卸载时遇到问题：\n" + ex.Message, "课铃 ClassBell", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void KillApp()
        {
            try
            {
                foreach (var process in Process.GetProcessesByName("ClassBell"))
                {
                    try { if (!process.HasExited) process.Kill(); } catch { }
                }
            }
            catch { }
        }

        private static void DeleteShortcut(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }
}
