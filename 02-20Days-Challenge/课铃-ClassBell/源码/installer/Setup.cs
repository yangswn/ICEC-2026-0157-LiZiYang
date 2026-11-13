using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ClassBell.Setup
{
    internal static class Program
    {
        internal const string AppName = "课铃 ClassBell";
        internal const string Version = "1.4.2";
        internal const string Publisher = "ClassBell";
        internal const string ExeName = "ClassBell.exe";
        internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassBell";

        [STAThread]
        private static void Main(string[] args)
        {
            TryLog("MAIN args=" + string.Join(" ", args));
            bool silent = Array.IndexOf(args, "/S") >= 0 || Array.IndexOf(args, "--silent") >= 0;
            TryLog("silent=" + silent);
            if (silent)
            {
                string dir = DefaultDir;
                foreach (string arg in args)
                {
                    if (arg.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase))
                        dir = arg.Substring(6).Trim('"');
                }
                try
                {
                    InstallCore(dir, false, null);
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    TryLog("SILENT ERROR " + ex);
                    try { Console.Error.WriteLine("SETUP ERROR\n" + ex); } catch { }
                    Environment.Exit(1);
                }
                return;
            }

            // GUI 模式也接受 --dir=<路径>：预填安装目录（覆盖安装/自动化测试都用得上）
            string initialDir = null;
            foreach (string arg in args)
            {
                if (arg.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase))
                    initialDir = arg.Substring(6).Trim('"');
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(initialDir));
        }

        internal static string DefaultDir
        {
            get
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                string[] candidates =
                {
                    Path.Combine(local, "Programs", "ClassBell"),
                    Path.Combine(local, "ClassBell"),
                    Path.Combine(documents, "ClassBell")
                };
                foreach (string candidate in candidates)
                {
                    try
                    {
                        Directory.CreateDirectory(candidate);
                        string probe = Path.Combine(candidate, ".write-test");
                        File.WriteAllText(probe, "ok");
                        File.Delete(probe);
                        return candidate;
                    }
                    catch { }
                }
                return candidates[0];
            }
        }

        /// <summary>
        /// True when an Edge WebView2 Runtime is already installed for this user or machine.
        /// </summary>
        internal static bool WebView2Installed()
        {
            string[] keys =
            {
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
            };
            foreach (string key in keys)
            {
                foreach (RegistryKey root in new[] { Registry.LocalMachine, Registry.CurrentUser })
                {
                    try
                    {
                        using (RegistryKey sub = root.OpenSubKey(key))
                        {
                            if (sub == null) continue;
                            string version = sub.GetValue("pv") as string;
                            if (!string.IsNullOrWhiteSpace(version) && version != "0.0.0.0") return true;
                        }
                    }
                    catch { }
                }
            }
            return false;
        }

        /// <summary>
        /// Run the bundled Microsoft WebView2 bootstrapper silently. The recipient
        /// should never have to install a runtime by hand; if this fails (no network,
        /// locked-down machine) the app still starts and falls back to the browser.
        /// </summary>
        internal static bool EnsureWebView2(IProgress<int> progress, out string note)
        {
            note = "";
            if (WebView2Installed())
            {
                note = "已检测到 WebView2 运行时";
                return true;
            }
            try
            {
                using (Stream resource = FindResource(".webview2"))
                {
                    if (resource == null)
                    {
                        note = "安装包未内置 WebView2 引导程序";
                        return false;
                    }
                    string temp = Path.Combine(Path.GetTempPath(), "ClassBell-WebView2Setup-" + Guid.NewGuid().ToString("N") + ".exe");
                    try
                    {
                        using (var file = File.Create(temp)) resource.CopyTo(file);
                        if (progress != null) progress.Report(2);
                        var info = new ProcessStartInfo
                        {
                            FileName = temp,
                            Arguments = "/silent /install",
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardError = false,
                            RedirectStandardOutput = false
                        };
                        using (Process proc = Process.Start(info))
                        {
                            if (proc == null) { note = "无法启动 WebView2 安装程序"; return false; }
                            proc.WaitForExit(180000);
                        }
                    }
                    finally
                    {
                        try { File.Delete(temp); } catch { }
                    }
                }
                if (WebView2Installed())
                {
                    note = "WebView2 运行时已自动安装";
                    return true;
                }
                note = "WebView2 未能安装成功，课铃仍可使用浏览器模式";
                return false;
            }
            catch (Exception ex)
            {
                TryLog("webview2 bootstrap failed: " + ex.Message);
                note = "WebView2 安装失败：仍可继续安装课铃";
                return false;
            }
        }

        internal static void InstallCore(string dir, bool desktopShortcut, IProgress<int> progress)
        {
            dir = Path.GetFullPath(dir);
            TryLog("Install to " + dir);

            // 覆盖安装前必须先让旧版本退出：runtime\node.exe 被主程序托管，
            // 直接覆盖会报“文件正由另一进程使用”。
            if (!EnsureNoRunningInstances(dir, progress))
            {
                throw new Exception("课铃仍在运行，已取消安装。请退出课铃后重试。");
            }
            // 先卸旧版：避免旧文件/快捷方式/注册表残留，也避免新旧文件混在一起
            string preservedData = UpgradeFromPrevious(dir, progress);

            string webviewNote;
            EnsureWebView2(progress, out webviewNote);
            Directory.CreateDirectory(dir);

            string zipPath = Path.Combine(dir, ".install-payload-" + Guid.NewGuid().ToString("N") + ".zip");
            using (Stream resource = FindResource(".zip"))
            {
                if (resource == null) throw new Exception("安装包缺少 payload 资源。");
                using (var file = File.Create(zipPath)) resource.CopyTo(file);
            }

            try
            {
                using (var archive = ZipFile.OpenRead(zipPath))
                {
                    int total = archive.Entries.Count;
                    int index = 0;
                    foreach (var entry in archive.Entries)
                    {
                        index++;
                        string target = Path.GetFullPath(Path.Combine(dir, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!target.StartsWith(dir, StringComparison.OrdinalIgnoreCase))
                            throw new Exception("安装包包含非法路径。");
                        if (entry.FullName.EndsWith("/", StringComparison.Ordinal))
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            entry.ExtractToFile(target, true);
                        }
                        if (progress != null) progress.Report(Math.Min(99, index * 100 / Math.Max(1, total)));
                    }
                }
            }
            finally
            {
                try { File.Delete(zipPath); } catch { }
            }

            string exe = Path.Combine(dir, ExeName);
            if (!File.Exists(exe)) throw new Exception("安装包解压后缺少 ClassBell.exe。");

            // 便携版数据在安装目录里，卸载时会被清掉，这里恢复回来
            RestorePreservedData(dir, preservedData);

            try
            {
                if (desktopShortcut)
                    CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), exe, dir);

                string group = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
                Directory.CreateDirectory(group);
                CreateShortcut(Path.Combine(group, AppName + ".lnk"), exe, dir);
                CreateShortcut(Path.Combine(group, "卸载课铃.lnk"), Path.Combine(dir, "Uninstall.exe"), dir);
            }
            catch (Exception ex)
            {
                TryLog("shortcut creation skipped: " + ex);
            }

            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
                {
                    key.SetValue("DisplayName", AppName);
                    key.SetValue("DisplayVersion", Version);
                    key.SetValue("Publisher", Publisher);
                    key.SetValue("DisplayIcon", exe);
                    key.SetValue("InstallLocation", dir);
                    key.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\"");
                    key.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /S");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("EstimatedSize", 96000, RegistryValueKind.DWord);
                }
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\ClassBell"))
                    key.SetValue("InstallDir", dir);
            }
            catch (Exception ex)
            {
                TryLog("registry entries skipped: " + ex);
            }
            if (progress != null) progress.Report(100);
            TryLog("Install complete");
        }

        internal static void LaunchApp(string dir)
        {
            try { Process.Start(Path.Combine(dir, ExeName)); } catch { }
        }

        /// <summary>
        /// 只把“本安装目录内”的进程算作待关闭对象：
        ///   &lt;dir&gt;\ClassBell.exe
        ///   &lt;dir&gt;\runtime\node.exe
        /// 严格按可执行文件全路径比较，绝不按进程名批量杀 —— 用户机器上可能还有
        /// 别的 Node 程序（开发服务器等），误杀会造成数据丢失。
        /// </summary>
        private static List<Process> FindRunningInstances(string dir)
        {
            var found = new List<Process>();
            string root;
            try { root = Path.GetFullPath(dir).TrimEnd('\\'); }
            catch { return found; }

            var names = new[] { "ClassBell", "node" };
            foreach (string name in names)
            {
                Process[] all;
                try { all = Process.GetProcessesByName(name); }
                catch { continue; }

                foreach (var process in all)
                {
                    try
                    {
                        string exe;
                        try { exe = process.MainModule.FileName; }
                        catch { continue; }   // 权限/位数不同读不到，跳过而不是崩溃

                        string full;
                        try { full = Path.GetFullPath(exe); }
                        catch { continue; }

                        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                            continue;

                        string leaf = Path.GetFileName(full);
                        bool isMain = string.Equals(leaf, ExeName, StringComparison.OrdinalIgnoreCase);
                        bool isNode = string.Equals(leaf, "node.exe", StringComparison.OrdinalIgnoreCase)
                                      && full.IndexOf(Path.DirectorySeparatorChar + "runtime" + Path.DirectorySeparatorChar,
                                          StringComparison.OrdinalIgnoreCase) >= 0;
                        if (isMain || isNode) found.Add(process);
                        else process.Dispose();
                    }
                    catch { }
                }
            }
            return found;
        }

        /// <summary>主程序优先，node 次之：反过来主程序会立刻把 node 重启。</summary>
        private static void CloseInstances(List<Process> list)
        {
            var ordered = new List<Process>();
            foreach (var process in list)
            {
                string leaf = "";
                try { leaf = Path.GetFileName(process.MainModule.FileName); } catch { }
                if (string.Equals(leaf, ExeName, StringComparison.OrdinalIgnoreCase)) ordered.Add(process);
            }
            foreach (var process in list)
            {
                if (!ordered.Contains(process)) ordered.Add(process);
            }

            foreach (var process in ordered)
            {
                try
                {
                    if (process.HasExited) continue;
                    TryLog("closing pid=" + process.Id);
                    // 先礼后兵：请求正常关闭，2 秒不退再强杀
                    try { process.CloseMainWindow(); } catch { }
                    if (process.WaitForExit(2000)) continue;
                    try { process.Kill(); } catch { }
                    process.WaitForExit(3000);
                }
                catch { }
            }
        }

        private static bool StillRunning(List<Process> list)
        {
            foreach (var process in list)
            {
                try { if (!process.HasExited) return true; } catch { }
            }
            return false;
        }

        /// <summary>
        /// 确认旧版本已退出。GUI 模式下弹窗告知并允许自动关闭/重试；
        /// 静默安装直接尝试关闭，关不掉就返回 false（由调用方报错退出）。
        /// </summary>
        private static bool EnsureNoRunningInstances(string dir, IProgress<int> progress)
        {
            bool interactive = progress != null;

            for (int round = 0; round < 5; round++)
            {
                List<Process> running = FindRunningInstances(dir);
                if (running.Count == 0) return true;

                int count = running.Count;
                if (interactive)
                {
                    bool go = PromptForm.Ask(
                        "课铃正在运行",
                        "要安装新版本，需要先关闭正在运行的课铃。\r\n\r\n"
                        + "检测到：ClassBell.exe、runtime\\node.exe（共 " + count + " 个进程）\r\n\r\n"
                        + "关闭后你正在编辑的内容会自动保存。",
                        "自动关闭并继续安装", "取消", false, "");
                    if (!go)
                    {
                        foreach (var process in running) process.Dispose();
                        return false;
                    }
                }

                CloseInstances(running);
                foreach (var process in running) process.Dispose();

                if (!StillRunning(FindRunningInstances(dir))) return true;

                if (!interactive) return false;   // 静默安装不弹窗，直接失败

                bool retry = PromptForm.Ask(
                    "无法自动关闭课铃",
                    "请手动退出后再试：\r\n\r\n"
                    + "1) 在系统托盘（可能折叠在右下角 ^ 里）右键课铃图标 →「退出课铃」\r\n"
                    + "2) 或在任务管理器里结束 ClassBell.exe\r\n\r\n"
                    + "然后点「重试」。",
                    "重试", "取消", false, "");
                if (!retry) return false;
            }
            return FindRunningInstances(dir).Count == 0;
        }

        internal static void KillApp()
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

        /// <summary>读已安装版本号：注册表优先，退化为读旧 exe 的文件版本。</summary>
        internal static System.Version ReadInstalledVersion(string dir)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey))
                {
                    if (key != null)
                    {
                        string text = key.GetValue("DisplayVersion") as string;
                        System.Version parsed;
                        if (!string.IsNullOrWhiteSpace(text) && System.Version.TryParse(text, out parsed)) return parsed;
                    }
                }
            }
            catch { }

            try
            {
                string exe = Path.Combine(dir, ExeName);
                if (File.Exists(exe))
                {
                    var info = FileVersionInfo.GetVersionInfo(exe);
                    System.Version parsed;
                    if (System.Version.TryParse(info.FileVersion, out parsed)) return parsed;
                }
            }
            catch { }

            return null;
        }

        /// <summary>
        /// 卸载旧版本：只传 /S（静默，默认保留 %APPDATA%\ClassBell）与 /KEEPDIR（不删目录，
        /// 避免卸载器延迟 rmdir 删掉安装器稍后解压的文件）。
        /// </summary>
        private static bool UninstallPrevious(string dir)
        {
            string uninstaller = Path.Combine(dir, "Uninstall.exe");
            if (!File.Exists(uninstaller)) return false;

            TryLog("uninstalling previous version from " + dir);
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = uninstaller,
                    Arguments = "/S /KEEPDIR",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = dir
                };
                using (var process = Process.Start(info))
                {
                    if (process == null) return false;
                    if (!process.WaitForExit(60000))
                    {
                        TryLog("uninstaller timeout, killing");
                        try { process.Kill(); } catch { }
                        try { process.WaitForExit(5000); } catch { }
                    }
                }
                return true;
            }
            catch (Exception ex)
            {
                TryLog("uninstall previous failed: " + ex.Message);
                return false;
            }
        }

        /// <summary>把安装目录里的便携数据（data\）备份到临时目录，装完再恢复。</summary>
        private static string PreservePortableData(string dir)
        {
            string data = Path.Combine(dir, "data");
            if (!Directory.Exists(data)) return null;
            try
            {
                // 放在安装目录的同级位置：同盘、可写，且不会被安装器的目录清理波及
                string parent = Path.GetDirectoryName(dir);
                if (string.IsNullOrEmpty(parent)) parent = Path.GetTempPath();
                string backup = Path.Combine(parent, ".classbell-data-backup-" + Guid.NewGuid().ToString("N"));
                CopyTree(data, backup);
                TryLog("preserved portable data -> " + backup);
                return backup;
            }
            catch (Exception ex)
            {
                TryLog("preserve portable data failed: " + ex.Message);
                return null;
            }
        }

        private static void RestorePreservedData(string dir, string backup)
        {
            if (string.IsNullOrEmpty(backup) || !Directory.Exists(backup)) return;
            try
            {
                string data = Path.Combine(dir, "data");
                if (!Directory.Exists(data)) CopyTree(backup, data);
                TryLog("restored portable data");
            }
            catch (Exception ex)
            {
                TryLog("restore portable data failed: " + ex.Message);
            }
            finally
            {
                try { Directory.Delete(backup, true); } catch { }
            }
        }

        private static void CopyTree(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string file in Directory.GetFiles(from))
            {
                File.Copy(file, Path.Combine(to, Path.GetFileName(file)), true);
            }
            foreach (string sub in Directory.GetDirectories(from))
            {
                CopyTree(sub, Path.Combine(to, Path.GetFileName(sub)));
            }
        }

        /// <summary>
        /// 已装旧版本且版本更低时：备份便携数据 → 跑卸载器 → 清掉残留文件。
        /// 返回便携数据备份路径（没有则 null），由调用方在解压后恢复。
        /// </summary>
        private static string UpgradeFromPrevious(string dir, IProgress<int> progress)
        {
            System.Version installed = ReadInstalledVersion(dir);
            if (installed == null) return null;

            System.Version current;
            if (!System.Version.TryParse(Program.Version, out current)) return null;
            if (installed >= current)
            {
                TryLog("installed " + installed + " >= current " + current + ", skip uninstall");
                return null;
            }

            if (progress != null) progress.Report(1);
            string preserved = PreservePortableData(dir);
            UninstallPrevious(dir);

            // 旧版卸载器会安排 "timeout 2 & rmdir /s /q <dir>"。
            // 必须先把这个延迟删除等过去，否则它会把我们刚解压的文件删掉。
            WaitForDirectoryRemoved(dir, 20000);
            Thread.Sleep(2500);
            return preserved;
        }

        /// <summary>
        /// 主动删掉安装目录并轮询到“确实不存在”。
        /// 旧版卸载器排的延迟 rmdir 会在这段时间里落空，从而不会误删新文件。
        /// </summary>
        private static void WaitForDirectoryRemoved(string dir, int timeoutMs)
        {
            var started = Environment.TickCount;
            while (Environment.TickCount - started < timeoutMs)
            {
                try
                {
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                }
                catch { }
                if (!Directory.Exists(dir)) return;
                Thread.Sleep(400);
            }
            TryLog("install dir still present after wait: " + dir);
        }

        /// <summary>卸载后清掉目录里剩下的旧文件（保留目录本身）。</summary>
        private static void ClearInstallDir(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return;
                foreach (string file in Directory.GetFiles(dir))
                {
                    try { File.Delete(file); } catch { }
                }
                foreach (string sub in Directory.GetDirectories(dir))
                {
                    try { Directory.Delete(sub, true); } catch { }
                }
            }
            catch (Exception ex)
            {
                TryLog("clear install dir failed: " + ex.Message);
            }
        }

        internal static Stream FindResource(string suffix)
        {
            var assembly = Assembly.GetExecutingAssembly();
            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                    return assembly.GetManifestResourceStream(name);
            }
            return null;
        }

        internal static string ReadLicense()
        {
            using (var stream = FindResource(".txt"))
            {
                if (stream == null) return "MIT License\n\nCopyright (c) 2026 ClassBell";
                using (var reader = new StreamReader(stream))
                    return reader.ReadToEnd();
            }
        }

        internal static void CreateShortcut(string path, string target, string workingDirectory)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch (Exception ex) { TryLog("shortcut error " + ex.Message); }
        }

        internal static void TryLog(string message)
        {
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "ClassBell-install.log"),
                    DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
            }
            catch { }
        }
    }

    /// <summary>安装器里用到的极简确认框：固定两个按钮，避免 MessageBox 的“是/否”语义不清。</summary>
    internal sealed class PromptForm : Form
    {
        private PromptForm(string title, string body, string okText, string cancelText, bool danger, string detail)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(247, 244, 236);
            Font = new Font("Microsoft YaHei UI", 9F);
            ClientSize = new Size(448, string.IsNullOrEmpty(detail) ? 214 : 250);

            var head = new Label
            {
                Text = title,
                Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
                ForeColor = Color.FromArgb(43, 58, 48),
                Bounds = new Rectangle(22, 18, 402, 28),
                AutoSize = false
            };

            var text = new Label
            {
                Text = body,
                ForeColor = Color.FromArgb(90, 100, 92),
                Bounds = new Rectangle(22, 52, 402, string.IsNullOrEmpty(detail) ? 96 : 120),
                AutoSize = false
            };

            var ok = new Button
            {
                Text = okText,
                DialogResult = DialogResult.OK,
                Bounds = new Rectangle(150, ClientSize.Height - 50, 150, 34),
                BackColor = danger ? Color.FromArgb(196, 85, 67) : Color.FromArgb(46, 74, 58),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            ok.FlatAppearance.BorderSize = 0;

            var cancel = new Button
            {
                Text = cancelText,
                DialogResult = DialogResult.Cancel,
                Bounds = new Rectangle(310, ClientSize.Height - 50, 116, 34),
                BackColor = Color.FromArgb(236, 231, 219),
                ForeColor = Color.FromArgb(60, 70, 62),
                FlatStyle = FlatStyle.Flat
            };
            cancel.FlatAppearance.BorderSize = 0;

            Controls.Add(head);
            Controls.Add(text);
            Controls.Add(ok);
            Controls.Add(cancel);
            AcceptButton = ok;
            CancelButton = cancel;
        }

        /// <summary>返回 true = 用户点了主按钮（继续/重试）。</summary>
        internal static bool Ask(string title, string body, string okText, string cancelText, bool danger, string detail)
        {
            using (var form = new PromptForm(title, body, okText, cancelText, danger, detail))
            {
                return form.ShowDialog() == DialogResult.OK;
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox pathBox;
        private readonly CheckBox desktopBox;
        private readonly CheckBox licenseBox;
        private readonly Button installButton;
        private readonly ProgressBar progress;
        private readonly Label status;
        private Panel finishPanel;
        private bool busy;

        public SetupForm(string initialDir = null)
        {
            Text = "课铃 ClassBell 安装程序";
            ClientSize = new Size(680, 500);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(243, 240, 231);
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var header = new Panel { Dock = DockStyle.Top, Height = 104, BackColor = Color.FromArgb(20, 62, 51) };
            var iconBox = new PictureBox
            {
                Image = Icon != null ? Icon.ToBitmap() : null,
                SizeMode = PictureBoxSizeMode.Zoom,
                Location = new Point(28, 24),
                Size = new Size(54, 54),
                BackColor = Color.Transparent
            };
            var title = new Label
            {
                Text = "课铃 ClassBell",
                ForeColor = Color.FromArgb(250, 246, 234),
                Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(98, 24)
            };
            var subtitle = new Label
            {
                Text = "课程作业自动识别与到期提醒 · 安装程序 v" + Program.Version,
                ForeColor = Color.FromArgb(190, 211, 199),
                Font = new Font("Microsoft YaHei UI", 9F),
                AutoSize = true,
                Location = new Point(101, 62)
            };
            header.Controls.Add(iconBox);
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            Controls.Add(header);

            var intro = new Label
            {
                Text = "课铃会把作业、考试与自定义日程放在一个清晰的窗口里。安装包包含本地服务与 WebView2 桌面宿主，安装不需要管理员权限。",
                ForeColor = Color.FromArgb(86, 96, 88),
                Location = new Point(34, 128),
                Size = new Size(612, 44)
            };
            Controls.Add(intro);

            var pathLabel = new Label { Text = "安装位置", ForeColor = Color.FromArgb(60, 70, 62), Location = new Point(34, 184), AutoSize = true };
            Controls.Add(pathLabel);
            pathBox = new TextBox { Text = string.IsNullOrWhiteSpace(initialDir) ? Program.DefaultDir : initialDir, Location = new Point(34, 208), Width = 512, Height = 30, BorderStyle = BorderStyle.FixedSingle };
            Controls.Add(pathBox);
            var browse = new Button { Text = "浏览…", Location = new Point(556, 207), Width = 90, Height = 30 };
            browse.Click += (s, e) =>
            {
                using (var dialog = new FolderBrowserDialog { Description = "选择课铃的安装位置", SelectedPath = pathBox.Text })
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK) pathBox.Text = dialog.SelectedPath;
                }
            };
            Controls.Add(browse);

            desktopBox = new CheckBox { Text = "创建桌面快捷方式", Checked = true, Location = new Point(34, 254), AutoSize = true, ForeColor = Color.FromArgb(60, 70, 62) };
            Controls.Add(desktopBox);

            licenseBox = new CheckBox
            {
                Text = "我已阅读并同意 MIT 许可协议与隐私说明",
                Location = new Point(34, 288),
                AutoSize = true,
                ForeColor = Color.FromArgb(60, 70, 62)
            };
            licenseBox.CheckedChanged += (s, e) =>
            {
                installButton.Enabled = licenseBox.Checked && !busy;
                installButton.BackColor = installButton.Enabled
                    ? Color.FromArgb(31, 111, 92)
                    : Color.FromArgb(150, 170, 160);
            };
            Controls.Add(licenseBox);

            var licenseLink = new LinkLabel
            {
                Text = "查看许可协议",
                Location = new Point(340, 287),
                AutoSize = true,
                LinkColor = Color.FromArgb(31, 111, 92)
            };
            licenseLink.LinkClicked += (s, e) => new LicenseForm().ShowDialog(this);
            Controls.Add(licenseLink);

            var note = new Label
            {
                Text = "数据默认保存在 %APPDATA%\\ClassBell；卸载时可以选择保留。",
                ForeColor = Color.FromArgb(130, 137, 129),
                Location = new Point(34, 322),
                Size = new Size(610, 24)
            };
            Controls.Add(note);

            progress = new ProgressBar { Location = new Point(34, 360), Width = 612, Height = 8, Style = ProgressBarStyle.Continuous };
            Controls.Add(progress);
            status = new Label { Text = "准备安装", ForeColor = Color.FromArgb(110, 118, 110), Location = new Point(34, 374), Size = new Size(612, 24) };
            Controls.Add(status);

            installButton = new Button
            {
                Text = "开始安装",
                Location = new Point(430, 432),
                Width = 106,
                Height = 38,
                BackColor = Color.FromArgb(31, 111, 92),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Enabled = false
            };
            installButton.BackColor = Color.FromArgb(150, 170, 160);
            installButton.FlatAppearance.BorderSize = 0;
            installButton.Click += async (s, e) => await InstallAsync();
            Controls.Add(installButton);

            var cancel = new Button { Text = "取消", Location = new Point(546, 432), Width = 100, Height = 38, FlatStyle = FlatStyle.Flat };
            cancel.Click += (s, e) => Close();
            Controls.Add(cancel);

            finishPanel = BuildFinishPanel();
            Controls.Add(finishPanel);
            finishPanel.Visible = false;
        }

        private Panel BuildFinishPanel()
        {
            var panel = new Panel { Location = new Point(0, 104), Size = new Size(680, 396), BackColor = Color.FromArgb(243, 240, 231), Visible = false };
            var mark = new Label
            {
                Text = "✓",
                ForeColor = Color.White,
                BackColor = Color.FromArgb(31, 111, 92),
                Font = new Font("Segoe UI", 26F, FontStyle.Bold),
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(292, 60),
                Size = new Size(96, 96)
            };
            var title = new Label
            {
                Text = "安装完成",
                Font = new Font("Microsoft YaHei UI", 20F, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 45, 37),
                AutoSize = true,
                Location = new Point(285, 178)
            };
            var text = new Label
            {
                Text = "课铃已经准备好。登录学习通后会自动识别作业，也可以先手动记录日程。",
                ForeColor = Color.FromArgb(110, 118, 110),
                Location = new Point(118, 222),
                Size = new Size(450, 24),
                TextAlign = ContentAlignment.MiddleCenter
            };
            var launch = new CheckBox { Text = "立即启动课铃 ClassBell", Checked = true, Location = new Point(260, 268), AutoSize = true };
            var done = new Button
            {
                Text = "完成",
                Location = new Point(286, 314),
                Width = 108,
                Height = 38,
                BackColor = Color.FromArgb(31, 111, 92),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            done.FlatAppearance.BorderSize = 0;
            done.Click += (s, e) =>
            {
                if (launch.Checked) Program.LaunchApp(pathBox.Text.Trim());
                Close();
            };
            panel.Controls.Add(mark);
            panel.Controls.Add(title);
            panel.Controls.Add(text);
            panel.Controls.Add(launch);
            panel.Controls.Add(done);
            return panel;
        }

        private async Task InstallAsync()
        {
            if (busy) return;
            string dir;
            try { dir = Path.GetFullPath(pathBox.Text.Trim()); }
            catch { MessageBox.Show(this, "安装路径无效。", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            if (string.IsNullOrWhiteSpace(pathBox.Text)) return;

            busy = true;
            installButton.Enabled = false;
            pathBox.Enabled = false;
            desktopBox.Enabled = false;
            licenseBox.Enabled = false;
            status.Text = "正在安装，请稍候…";
            var progressReporter = new Progress<int>(value =>
            {
                progress.Value = Math.Max(0, Math.Min(100, value));
                if (value < 100) status.Text = "正在释放文件… " + value + "%";
            });
            try
            {
                await Task.Run(() => Program.InstallCore(dir, desktopBox.Checked, progressReporter));
                status.Text = "安装完成";
                finishPanel.Visible = true;
                finishPanel.BringToFront();
            }
            catch (Exception ex)
            {
                busy = false;
                installButton.Enabled = licenseBox.Checked;
                pathBox.Enabled = true;
                desktopBox.Enabled = true;
                licenseBox.Enabled = true;
                status.Text = "安装失败：" + ex.Message;
                MessageBox.Show(this, "安装失败：\n" + ex.Message, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class LicenseForm : Form
    {
        public LicenseForm()
        {
            Text = "课铃 ClassBell · 许可协议";
            ClientSize = new Size(620, 520);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(255, 253, 248);
            var box = new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                BackColor = Color.FromArgb(255, 253, 248),
                ForeColor = Color.FromArgb(55, 65, 58),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = Program.ReadLicense()
            };
            Controls.Add(box);
            var close = new Button { Text = "关闭", Dock = DockStyle.Bottom, Height = 38, FlatStyle = FlatStyle.Flat };
            close.Click += (s, e) => Close();
            Controls.Add(close);
        }
    }
}
