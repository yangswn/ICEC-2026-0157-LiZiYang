using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ClassBell.Setup
{
    internal static class Program
    {
        internal const string AppName = "课铃 ClassBell";
        internal const string Version = "1.3.3";
        internal const string Publisher = "ClassBell";
        internal const string ExeName = "ClassBell.exe";
        internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassBell";

        [STAThread]
        private static void Main(string[] args)
        {
            try { File.WriteAllText(@"C:\Users\24373\Documents\deepseek-harness\default-workspace\.tools\setup-main.log", "MAIN " + string.Join(" ", args)); } catch { }
            try { Console.Error.WriteLine("SETUP MAIN " + string.Join(" ", args)); } catch { }
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

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
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
            KillApp();
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

        public SetupForm()
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
            pathBox = new TextBox { Text = Program.DefaultDir, Location = new Point(34, 208), Width = 512, Height = 30, BorderStyle = BorderStyle.FixedSingle };
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
