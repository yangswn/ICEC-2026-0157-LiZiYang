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
        internal const string Version = "1.10.0";
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
                    InstallCore(dir, false, null);   // 静默安装不看报告
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

        /// <summary>
        /// 目标安装目录的默认值。优先级：注册表里上次装的位置（目录还在）→ 默认位置。
        /// 必须先看注册表，否则每次升级都可能装到别处，快捷方式就指向旧版。
        /// </summary>
        internal static string DefaultDir
        {
            get
            {
                string previous = InstalledLocation();
                if (!string.IsNullOrEmpty(previous))
                {
                    TryLog("previous install location: " + previous);
                    return previous;
                }

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
        /// 读上次的安装位置。只有目录确实存在才采用 —— 用户手工删过目录时不能还往那儿装。
        /// </summary>
        internal static string InstalledLocation()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey))
                {
                    if (key == null) return null;
                    string location = key.GetValue("InstallLocation") as string;
                    if (string.IsNullOrWhiteSpace(location)) return null;
                    location = location.Trim().Trim('"');
                    return Directory.Exists(location) ? Path.GetFullPath(location) : null;
                }
            }
            catch { return null; }
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

        internal static InstallReport InstallCore(string dir, bool desktopShortcut, IProgress<int> progress)
        {
            dir = Path.GetFullPath(dir);
            TryLog("Install to " + dir);

            // 覆盖安装前必须先让旧版本退出：runtime\node.exe 被主程序托管，
            // 直接覆盖会报“文件正由另一进程使用”。
            if (!EnsureNoRunningInstances(dir, progress))
            {
                throw new Exception("课铃仍在运行，已取消安装。请退出课铃后重试。");
            }
            // 覆盖安装：只做版本检查 + 备份关键数据，不调用旧卸载器、不删目录
            string preservedData = PrepareOverwrite(dir, progress);

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
                            ExtractFileWithRetry(entry, target);
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

            // 覆盖安装不删目录，data\ 本来还在；这里只补“确实缺失”的文件
            RestoreUserData(dir, preservedData);

            // 不管走哪条安装路径，都把桌面/开始菜单的快捷方式指回当前目录，
            // 并逐个回读校验：装完还指着旧目录是最难查的那种问题。
            // 桌面上已经有图标（哪怕指着旧目录）就必须修正它，
            // 否则用户点图标打开的还是旧版本 —— 这正是这次要修的坑。
            string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
            bool includeDesktop = desktopShortcut || File.Exists(desktopLink);
            var shortcutIssues = RewriteShortcuts(dir, includeDesktop);
            foreach (string issue in shortcutIssues) TryLog("shortcut issue: " + issue);

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
            // 总是把最终目录写回注册表，下次升级才不会装到别处
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
                    key.SetValue("InstallLocation", dir);
            }
            catch (Exception ex) { TryLog("InstallLocation write failed: " + ex.Message); }

            var others = FindOtherInstalls(dir);
            foreach (string other in others) TryLog("other install found: " + other);

            if (progress != null) progress.Report(100);
            TryLog("Install complete");
            return new InstallReport
            {
                Dir = dir,
                ShortcutIssues = shortcutIssues,
                OtherInstalls = others
            };
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


        /* ------------------------------------------------- 用户数据保全 */

        private const string AppDataFolderName = "ClassBell";

        /// <summary>%APPDATA%\ClassBell（非便携模式的数据目录）。</summary>
        private static string RoamingDataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppDataFolderName);
        }

        /// <summary>递归统计文件数与总字节，用于备份校验。</summary>
        private static void MeasureTree(string dir, out int files, out long bytes)
        {
            files = 0;
            bytes = 0;
            if (!Directory.Exists(dir)) return;
            foreach (string file in Directory.GetFiles(dir))
            {
                files += 1;
                try { bytes += new FileInfo(file).Length; } catch { }
            }
            foreach (string sub in Directory.GetDirectories(dir))
            {
                int subFiles;
                long subBytes;
                MeasureTree(sub, out subFiles, out subBytes);
                files += subFiles;
                bytes += subBytes;
            }
        }

        /// <summary>复制后校验：文件数与字节数必须一致。</summary>
        private static bool CopyTreeVerified(string from, string to)
        {
            CopyTree(from, to);
            int fromFiles, toFiles;
            long fromBytes, toBytes;
            MeasureTree(from, out fromFiles, out fromBytes);
            MeasureTree(to, out toFiles, out toBytes);
            bool ok = fromFiles == toFiles && fromBytes == toBytes;
            TryLog("backup verify " + (ok ? "OK" : "MISMATCH") + " files " + fromFiles + "/" + toFiles
                + " bytes " + fromBytes + "/" + toBytes);
            return ok;
        }

        /// <summary>
        /// 升级前备份用户数据（便携 data\ 与非便携 %APPDATA%\ClassBell 都备）。
        /// 备份或校验失败会抛异常 —— 调用方据此中止安装，绝不先删后装。
        /// </summary>
        private static string PreserveUserData(string dir)
        {
            string portableData = Path.Combine(dir, "data");
            string roamingData = RoamingDataDir();
            bool hasPortable = Directory.Exists(portableData) && File.Exists(Path.Combine(portableData, "data.json"));
            bool hasRoaming = Directory.Exists(roamingData) && File.Exists(Path.Combine(roamingData, "data.json"));
            if (!hasPortable && !hasRoaming) return null;

            string parent = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(parent)) parent = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            string backup = Path.Combine(parent, ".classbell-data-backup-" + stamp);
            int suffix = 1;
            while (Directory.Exists(backup))
            {
                backup = Path.Combine(parent, ".classbell-data-backup-" + stamp + "-" + suffix);
                suffix += 1;
            }

            Directory.CreateDirectory(backup);

            if (hasPortable)
            {
                if (!CopyTreeVerified(portableData, Path.Combine(backup, "install-data")))
                    throw new Exception("备份现有数据失败（安装目录 data\\ 校验不一致），已中止安装。请关闭课铃后重试。");
            }

            if (hasRoaming)
            {
                // 非便携模式：只备关键文件 + 日志，避免把 WebView2 缓存也复制一份
                string roamingBackup = Path.Combine(backup, "appdata");
                Directory.CreateDirectory(roamingBackup);
                foreach (string name in new[] { "data.json", "data.backup.json", "cx-cookies.json", "window.json", "install.id" })
                {
                    string src = Path.Combine(roamingData, name);
                    if (File.Exists(src)) File.Copy(src, Path.Combine(roamingBackup, name), true);
                }
                string logs = Path.Combine(roamingData, "process_logs");
                if (Directory.Exists(logs))
                {
                    if (!CopyTreeVerified(logs, Path.Combine(roamingBackup, "process_logs")))
                        throw new Exception("备份运行日志失败（校验不一致），已中止安装。");
                }
            }

            TryLog("user data preserved -> " + backup);
            return backup;
        }

        /// <summary>
        /// 装完后恢复用户数据：哪一份缺失就补哪一份，并校验。
        /// 备份目录保留不删（滚动保留最近 2 份），出问题还能手工找回。
        /// </summary>
        private static void RestoreUserData(string dir, string backup)
        {
            if (string.IsNullOrEmpty(backup) || !Directory.Exists(backup)) return;

            try
            {
                string portableFrom = Path.Combine(backup, "install-data");
                string portableTo = Path.Combine(dir, "data");
                if (Directory.Exists(portableFrom))
                {
                    if (!File.Exists(Path.Combine(portableTo, "data.json")))
                    {
                        CopyTree(portableFrom, portableTo);
                        TryLog("restored portable data");
                    }
                }

                string roamingFrom = Path.Combine(backup, "appdata");
                string roamingTo = RoamingDataDir();
                if (Directory.Exists(roamingFrom))
                {
                    Directory.CreateDirectory(roamingTo);
                    foreach (string file in Directory.GetFiles(roamingFrom))
                    {
                        string target = Path.Combine(roamingTo, Path.GetFileName(file));
                        if (!File.Exists(target)) File.Copy(file, target, false);
                    }
                    string logsFrom = Path.Combine(roamingFrom, "process_logs");
                    if (Directory.Exists(logsFrom))
                    {
                        string logsTo = Path.Combine(roamingTo, "process_logs");
                        CopyTree(logsFrom, logsTo);
                    }
                    TryLog("restored appdata files");
                }
            }
            catch (Exception ex)
            {
                TryLog("restore user data failed: " + ex.Message);
            }

            PruneOldBackups(Path.GetDirectoryName(backup));
        }

        /// <summary>滚动保留最近 2 份备份，避免长期占用磁盘。</summary>
        private static void PruneOldBackups(string parent)
        {
            try
            {
                if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent)) return;
                var dirs = Directory.GetDirectories(parent, ".classbell-data-backup-*");
                Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < dirs.Length - 2; i += 1)
                {
                    try { Directory.Delete(dirs[i], true); } catch { }
                }
            }
            catch { }
        }

        /// <summary>
        /// 覆盖单个文件，带三层保护：
        ///  1. 目标是只读（旧版安装器可能留下只读文件）→ 先清掉只读属性；
        ///  2. 覆盖失败通常是对面句柄还没释放 → 等 300ms 重试，最多 5 次；
        ///  3. 仍失败 → 抛异常中止安装并报出具体文件，避免留下“装了一半”的状态。
        /// </summary>
        private static void ExtractFileWithRetry(ZipArchiveEntry entry, string target)
        {
            if (File.Exists(target))
            {
                try
                {
                    FileAttributes attributes = File.GetAttributes(target);
                    if ((attributes & FileAttributes.ReadOnly) != 0)
                    {
                        File.SetAttributes(target, attributes & ~FileAttributes.ReadOnly);
                        TryLog("cleared read-only: " + target);
                    }
                }
                catch { }
            }

            int attempt = 0;
            while (true)
            {
                try
                {
                    entry.ExtractToFile(target, true);
                    return;
                }
                catch (IOException ex)
                {
                    attempt += 1;
                    if (attempt >= 5)
                    {
                        TryLog("extract failed after " + attempt + " attempts: " + target + " (" + ex.Message + ")");
                        throw new Exception("无法覆盖文件（可能仍被占用）：\r\n" + target
                            + "\r\n\r\n请确认课铃已完全退出后重试安装。");
                    }
                    Thread.Sleep(300);
                }
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
        /// 覆盖安装的准备工作：版本检查 + 备份关键数据。
        ///
        /// 这里**不再调用旧版 Uninstall.exe**：
        ///  - 旧卸载器不认识参数，会整目录删除并排一个 "timeout 2 & rmdir /s /q" 的延迟删除；
        ///  - 那个延迟删除会与安装器的解压撞车，把刚装好的文件连同 data\ 一起删掉
        ///    （2026-11-13 真实事故）；
        ///  - 卸载与重装之间还有空窗，中途失败就是“软件没了”。
        ///
        /// 标准做法（Inno / NSIS / MSI 升级）都是直接覆盖：不动目录、不跑卸载器。
        /// 旧版本多出来的文件即使残留也无害（同名文件会被覆盖）。
        ///
        /// 返回备份目录（没有需要备份的数据时返回 null）。
        /// </summary>
        private static string PrepareOverwrite(string dir, IProgress<int> progress)
        {
            System.Version installed = ReadInstalledVersion(dir);
            System.Version current;
            bool hasCurrent = System.Version.TryParse(Program.Version, out current);

            // 版本检查：同版本或更高版本已装 → 不需要额外动作，直接覆盖即可
            if (installed != null && hasCurrent && installed >= current)
            {
                TryLog("installed " + installed + " >= current " + current + ", overwrite in place");
            }
            else if (installed != null)
            {
                TryLog("upgrading from " + installed + " to " + current + " by overwrite");
            }
            else
            {
                TryLog("fresh install (no previous version detected)");
            }

            if (progress != null) progress.Report(1);
            return PreserveUserData(dir);
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

        /// <summary>
        /// 写一个快捷方式并**回读校验** TargetPath。
        /// 回读这一步是关键：光写不校验，出现过「快捷方式还指着旧目录」却没人发现的情况。
        /// @returns null 表示成功，否则返回一句人话失败原因
        /// </summary>
        internal static string CreateShortcut(string path, string target, string workingDirectory)
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
            catch (Exception ex)
            {
                TryLog("shortcut write failed: " + path + " :: " + ex.Message);
                return "写入失败：" + ex.Message;
            }

            string actual = ReadShortcutTarget(path);
            if (string.IsNullOrEmpty(actual))
            {
                TryLog("shortcut readback empty: " + path);
                return "写入后读不回目标路径";
            }
            if (!string.Equals(Path.GetFullPath(actual), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
            {
                TryLog("shortcut mismatch: " + path + " -> " + actual + " (want " + target + ")");
                return "仍指向 " + actual;
            }
            TryLog("shortcut ok: " + path + " -> " + actual);
            return null;
        }

        /// <summary>读快捷方式的 TargetPath（失败返回空串）。</summary>
        /// <summary>这个目录能不能写（用来判断该不该往公共桌面写快捷方式）。</summary>
        internal static bool CanWriteFolder(string folder)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(folder)) return false;
                if (!Directory.Exists(folder)) return false;
                string probe = Path.Combine(folder, ".classbell-write-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        internal static string ReadShortcutTarget(string path)
        {
            try
            {
                if (!File.Exists(path)) return "";
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                object target = shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null);
                return target == null ? "" : target.ToString();
            }
            catch { return ""; }
        }

        /// <summary>
        /// 重写所有课铃快捷方式到当前目录（桌面 / 公共桌面 / 开始菜单），
        /// 并逐个回读校验。返回失败清单给完成页展示。
        /// </summary>
        internal static List<string> RewriteShortcuts(string dir, bool includeDesktop)
        {
            var issues = new List<string>();
            string exe = Path.Combine(dir, ExeName);
            string uninstaller = Path.Combine(dir, "Uninstall.exe");

            var links = new List<KeyValuePair<string, string>>();
            if (includeDesktop)
            {
                links.Add(new KeyValuePair<string, string>(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), exe));
                links.Add(new KeyValuePair<string, string>(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), AppName + ".lnk"), exe));
            }

            string group = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
            links.Add(new KeyValuePair<string, string>(Path.Combine(group, AppName + ".lnk"), exe));
            links.Add(new KeyValuePair<string, string>(Path.Combine(group, "卸载课铃.lnk"), uninstaller));

            foreach (var link in links)
            {
                string folder = Path.GetDirectoryName(link.Key);
                // 公共桌面多半不可写（按用户安装不需要管理员权限）——
                // 这不是错误，跳过就行，否则完成页天天挂着一条吓人的警告
                if (!CanWriteFolder(folder))
                {
                    TryLog("shortcut folder not writable, skipped: " + folder);
                    continue;
                }
                try
                {
                    Directory.CreateDirectory(folder);
                    string error = CreateShortcut(link.Key, link.Value, dir);
                    if (error != null) issues.Add(link.Key + "：" + error);
                }
                catch (Exception ex)
                {
                    TryLog("shortcut rewrite failed: " + link.Key + " :: " + ex.Message);
                    issues.Add(link.Key + "：" + ex.Message);
                }
            }
            return issues;
        }

        /// <summary>
        /// 找别的目录里的课铃（不删，只提示）。
        /// 机器上并存两份时，从旧快捷方式启动会打开旧版，用户会以为新版本没生效。
        /// </summary>
        internal static List<string> FindOtherInstalls(string currentDir)
        {
            var found = new List<string>();
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string current = Path.GetFullPath(currentDir).TrimEnd('\\');

            var candidates = new[]
            {
                Path.Combine(local, "Programs", "ClassBell"),
                Path.Combine(local, "ClassBell"),
                Path.Combine(documents, "ClassBell"),
                Path.Combine(programFiles, "ClassBell"),
                Path.Combine(programFilesX86, "ClassBell"),
                InstalledLocation()
            };

            foreach (string candidate in candidates)
            {
                if (string.IsNullOrWhiteSpace(candidate)) continue;
                try
                {
                    string full = Path.GetFullPath(candidate).TrimEnd('\\');
                    if (string.Equals(full, current, StringComparison.OrdinalIgnoreCase)) continue;
                    string exe = Path.Combine(full, ExeName);
                    if (!File.Exists(exe)) continue;
                    if (found.Contains(exe)) continue;
                    string version = "";
                    try { version = FileVersionInfo.GetVersionInfo(exe).FileVersion; } catch { }
                    found.Add(exe + (string.IsNullOrEmpty(version) ? "" : "（版本 " + version + "）"));
                }
                catch { }
            }
            return found;
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

    /// <summary>安装结果：完成页据此显示警告。</summary>
    internal sealed class InstallReport
    {
        internal string Dir = "";
        internal List<string> ShortcutIssues = new List<string>();
        internal List<string> OtherInstalls = new List<string>();
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
        private Label finishWarnings;
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

        /// <summary>
        /// 把安装报告里的问题显示在完成页。
        /// 快捷方式指向不对时必须让用户看见 —— 否则他点图标打开的是旧版本，
        /// 会以为这次更新什么都没改（这事真的发生过，排查了一整轮）。
        /// </summary>
        private void ShowFinishWarnings(InstallReport report)
        {
            if (finishWarnings == null) return;
            if (report == null) { finishWarnings.Visible = false; return; }

            var lines = new List<string>();
            if (report.ShortcutIssues != null && report.ShortcutIssues.Count > 0)
            {
                lines.Add("有快捷方式没能指向当前目录：" + report.ShortcutIssues[0]);
                if (report.ShortcutIssues.Count > 1)
                    lines.Add("（另有 " + (report.ShortcutIssues.Count - 1) + " 个同样的问题）");
            }
            if (report.OtherInstalls != null && report.OtherInstalls.Count > 0)
            {
                lines.Add("检测到另一份课铃：" + report.OtherInstalls[0]);
                lines.Add("它可能是旧版本，建议卸载或删除，否则从旧快捷方式启动会打开旧版。");
            }

            if (lines.Count == 0) { finishWarnings.Visible = false; return; }
            finishWarnings.Text = string.Join("\r\n", lines.ToArray());
            finishWarnings.Visible = true;
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
            // 警告区：快捷方式指向不对、或者机器上还有另一份课铃时占一块位置
            finishWarnings = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(170, 66, 45),
                Location = new Point(40, 244),
                Size = new Size(600, 44),
                AutoSize = false,
                TextAlign = ContentAlignment.TopLeft,
                Visible = false
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
            panel.Controls.Add(finishWarnings);
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
                InstallReport report = await Task.Run(() => Program.InstallCore(dir, desktopBox.Checked, progressReporter));
                status.Text = "安装完成";
                ShowFinishWarnings(report);
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
