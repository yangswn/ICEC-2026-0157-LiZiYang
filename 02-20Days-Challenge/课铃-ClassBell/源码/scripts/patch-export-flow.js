'use strict';
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ------------------------------------------------------------------ HostApi */
{
  const p = root + 'desktop/HostApi.cs';
  let s = fs.readFileSync(p, 'utf8');
  const anchor = '        public static async Task<string> PostJsonAsync(string path, object payload)';
  const add = [
    '        /// <summary>',
    '        /// 读取任意文本响应（导出日志、导出备份这类非 JSON 接口）。',
    '        /// </summary>',
    '        public static async Task<string> GetTextAsync(string path)',
    '        {',
    '            var response = await Client.GetAsync(BaseUrl + path);',
    '            var text = await response.Content.ReadAsStringAsync();',
    '            if (!response.IsSuccessStatusCode)',
    '                throw new Exception("HTTP " + (int)response.StatusCode + ": " + text);',
    '            return text;',
    '        }',
    '',
    anchor
  ].join('\n');
  if (s.includes(anchor)) { s = s.replace(anchor, add); fs.writeFileSync(p, s, 'utf8'); done.push('HostApi.GetTextAsync'); }
  else console.log('MISS: HostApi anchor');
}

/* ---------------------------------------------------------------- MainForm */
{
  const p = root + 'desktop/MainForm.cs';
  let s = fs.readFileSync(p, 'utf8');

  const anchor = '                    case "chooseFolder":';
  const add = [
    '                    // 导出走宿主保存对话框：WebView2 里的 <a download> 在部分机器上',
    '                    // 会被静默拦截，用户点了却什么都没发生。由 C# 落盘更可靠。',
    '                    case "saveLogs":',
    '                        Respond(id, true, await SaveExportAsync("/api/logs/export", "ClassBell-process_logs", ".jsonl", "日志文件 (*.jsonl)|*.jsonl"));',
    '                        break;',
    '                    case "saveData":',
    '                        Respond(id, true, await SaveExportAsync("/api/data/export", "ClassBell-backup", ".json", "备份文件 (*.json)|*.json"));',
    '                        break;',
    anchor
  ].join('\n');
  if (s.includes(anchor)) { s = s.replace(anchor, add); done.push('host save cases'); }
  else console.log('MISS: MainForm switch anchor');

  const helperAnchor = '        private string ChooseFolder()';
  const helper = [
    '        /// <summary>',
    '        /// 从本地服务取一份导出内容，弹出“另存为”后写入磁盘。',
    '        /// 返回 { path, bytes }；用户取消时 path 为空。',
    '        /// </summary>',
    '        private async Task<Dictionary<string, object>> SaveExportAsync(string apiPath, string filePrefix, string extension, string filter)',
    '        {',
    '            string body;',
    '            try',
    '            {',
    '                body = await HostApi.GetTextAsync(apiPath);',
    '            }',
    '            catch (Exception ex)',
    '            {',
    '                SafeLog("export fetch failed: " + ex.Message);',
    '                throw new Exception("无法从本地服务获取导出内容：" + ex.Message);',
    '            }',
    '',
    '            string suggested = filePrefix + "-" + DateTime.Now.ToString("yyyyMMdd-HHmm") + extension;',
    '            string target = null;',
    '            using (var dialog = new SaveFileDialog())',
    '            {',
    '                dialog.Title = "保存导出文件";',
    '                dialog.FileName = suggested;',
    '                dialog.Filter = filter + "|所有文件 (*.*)|*.*";',
    '                dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);',
    '                dialog.OverwritePrompt = true;',
    '                if (dialog.ShowDialog(this) == DialogResult.OK) target = dialog.FileName;',
    '            }',
    '            if (string.IsNullOrWhiteSpace(target))',
    '                return new Dictionary<string, object> { { "path", "" }, { "bytes", 0 } };',
    '',
    '            // 统一写 UTF-8 无 BOM，避免 Excel / Git 工具读出乱码',
    '            File.WriteAllText(target, body, new UTF8Encoding(false));',
    '            var info = new FileInfo(target);',
    '            SafeLog("export saved: " + info.Length + " bytes");',
    '            return new Dictionary<string, object>',
    '            {',
    '                { "path", target },',
    '                { "bytes", info.Length }',
    '            };',
    '        }',
    '',
    helperAnchor
  ].join('\n');
  if (s.includes(helperAnchor)) { s = s.replace(helperAnchor, helper); done.push('SaveExportAsync helper'); }
  else console.log('MISS: helper anchor');

  fs.writeFileSync(p, s, 'utf8');
}

/* ------------------------------------------------------------------ bridge */
{
  const p = root + 'src/renderer/bridge.js';
  let s = fs.readFileSync(p, 'utf8');

  const fromLogs = 'copyLogs: () => { download(\'/api/logs/export\'); return Promise.resolve({ copied: 1 }); },';
  const toLogs = [
    '    // 优先让宿主弹“另存为”并落盘；浏览器模式下退回普通下载。',
    '    copyLogs: async () => {',
    '      try { return await host(\'saveLogs\'); }',
    '      catch (_) { download(\'/api/logs/export\'); return { path: \'\', fallback: true }; }',
    '    },'
  ].join('\n');
  if (s.includes(fromLogs)) { s = s.replace(fromLogs, toLogs); done.push('copyLogs host'); }
  else console.log('MISS: copyLogs');

  const fromData = 'exportData: () => { download(\'/api/data/export\'); return Promise.resolve(\'download\'); },';
  const toData = [
    '    exportData: async () => {',
    '      try { return await host(\'saveData\'); }',
    '      catch (_) { download(\'/api/data/export\'); return { path: \'\', fallback: true }; }',
    '    },'
  ].join('\n');
  if (s.includes(fromData)) { s = s.replace(fromData, toData); done.push('exportData host'); }
  else console.log('MISS: exportData');

  fs.writeFileSync(p, s, 'utf8');
}

/* --------------------------------------------------------------------- app */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');

  const fromLogs = [
    "  $('#btn-export-logs').addEventListener('click', async () => {",
    '    const result = await api.copyLogs();',
    "    if (result) toast(`已导出 ${result.copied} 个日志文件。`, 'success');",
    '  });'
  ].join('\n');

  const toLogs = [
    "  $('#btn-export-logs').addEventListener('click', async () => {",
    '    try {',
    '      const result = await api.copyLogs();',
    "      if (result && result.path) toast('日志已保存到：' + result.path, 'success', 7000);",
    "      else if (result && result.fallback) toast('已开始下载日志文件。', 'success');",
    "      else toast('已取消保存。', 'info');",
    '    } catch (error) {',
    "      toast(`导出日志失败：${error.message || error}`, 'error', 6000);",
    '    }',
    '  });'
  ].join('\n');

  if (s.includes(fromLogs)) { s = s.replace(fromLogs, toLogs); done.push('export logs UI'); }
  else console.log('MISS: export logs UI');

  const fromData = [
    "  $('#btn-export-data').addEventListener('click', async () => {",
    '    const file = await api.exportData();',
    "    if (file) toast('数据已导出。', 'success');",
    '  });'
  ].join('\n');

  const toData = [
    "  $('#btn-export-data').addEventListener('click', async () => {",
    '    try {',
    '      const result = await api.exportData();',
    "      if (result && result.path) toast('数据已保存到：' + result.path, 'success', 7000);",
    "      else if (result && result.fallback) toast('已开始下载备份文件。', 'success');",
    "      else toast('已取消保存。', 'info');",
    '    } catch (error) {',
    "      toast(`导出数据失败：${error.message || error}`, 'error', 6000);",
    '    }',
    '  });'
  ].join('\n');

  if (s.includes(fromData)) { s = s.replace(fromData, toData); done.push('export data UI'); }
  else console.log('MISS: export data UI');

  fs.writeFileSync(p, s, 'utf8');
}

console.log('applied:', done.join(', '));
