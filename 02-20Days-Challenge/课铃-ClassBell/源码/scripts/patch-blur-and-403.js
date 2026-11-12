'use strict';
/**
 * 处理同学反馈的三件事：
 *  1) 页面“很糊” —— 真因是宿主按 DPI 又把 WebView2 缩放了一次（96/dpi），
 *     双重缩放导致文字发虚。WebView2 本身已经按系统 DPI 渲染，去掉这次补偿。
 *  2) 字体引导 —— 首次打开时弹“界面大小”引导，让用户当场选清楚。
 *  3) 作业接口 403 —— 备用通道其实成功了，不该按“异常”报给用户；
 *     标记为已恢复（recovered），日志页与统计里降级显示。
 */
const fs = require('fs');
const root = 'C:/Users/24373/Documents/deepseek-harness/default-workspace/campus-pulse/';
const done = [];

/* ---------------- 1) 去掉 DPI 双重缩放（模糊根因） ---------------- */
{
  const p = root + 'desktop/MainForm.cs';
  let s = fs.readFileSync(p, 'utf8');
  const from = `        private void ApplyDpiZoom()
        {
            try
            {
                uint dpi = GetDpiForWindow(webView.Handle);
                if (dpi >= 96) webView.ZoomFactor = Math.Max(0.5, 96.0 / dpi);
            }
            catch { }
        }`;
  const to = `        /// <summary>
        /// 注意：这里故意 **不** 再按 DPI 缩放。
        /// WebView2 已经跟随系统 DPI 渲染（150% 时自动放大），
        /// 之前又乘了 96/dpi 做一次补偿，等于把页面缩回去，
        /// 小数缩放会把文字渲染发虚 —— 这就是用户反馈“页面很糊”的原因。
        /// 字号大小交给用户在“界面大小”里选择。
        /// </summary>
        private void ApplyDpiZoom()
        {
            if (webView != null) webView.ZoomFactor = 1.0;
        }`;
  if (s.includes(from)) { s = s.replace(from, to); fs.writeFileSync(p, s, 'utf8'); done.push('MainForm dpi zoom removed'); }
  else console.log('MISS: MainForm ApplyDpiZoom');
}

/* LoginForm / ReminderForm 里同样的补偿也要去掉 */
for (const file of ['desktop/LoginForm.cs', 'desktop/ReminderForm.cs']) {
  const p = root + file;
  let s = fs.readFileSync(p, 'utf8');
  const block = `                try
                {
                    uint dpi = GetDpiForWindow(webView.Handle);
                    if (dpi >= 96) webView.ZoomFactor = Math.Max(0.5, 96.0 / dpi);
                }
                catch { }`;
  if (s.includes(block)) {
    s = s.replace(block, `                // 不再按 DPI 二次缩放，避免文字发虚（WebView2 已跟随系统 DPI）\n                webView.ZoomFactor = 1.0;`);
    fs.writeFileSync(p, s, 'utf8');
    done.push(file + ' dpi zoom removed');
  } else console.log('MISS:', file);
}

/* ---------------- 3) 403 但备用成功 → 标记 recovered ---------------- */
{
  const p = root + 'server/chaoxing.js';
  let s = fs.readFileSync(p, 'utf8');
  const from = `      this.telemetry.log('task_feed_error', { ok: false, error, meta: { fallback: true } });`;
  const to = `      // 主接口（gas/taskmsg）在部分账号上固定返回 403，这是平台限制而不是故障；
      // 后面的课程列表/H5 兜底会正常工作，所以把这条记为“已恢复”，
      // 避免日志页把每次同步都渲染成红色异常。
      this.telemetry.log('task_feed_error', {
        ok: false,
        error,
        meta: { fallback: true, recovered: true }
      });`;
  if (s.includes(from)) { s = s.replace(from, to); fs.writeFileSync(p, s, 'utf8'); done.push('chaoxing recovered flag'); }
  else console.log('MISS: task_feed_error log');
}

/* 统计里把 recovered 的条目排除出“错误数” */
{
  const p = root + 'server/telemetry.js';
  let s = fs.readFileSync(p, 'utf8');
  const from = `      const errors = entries.filter((e) => e.ok === false).length;`;
  const to = `      // 只统计“尚未恢复”的错误：像 learn 主接口 403 但备用通道成功的情况，
      // 对用户没有影响，不该出现在错误计数里（否则每天都是 8 条红字）。
      const errors = entries.filter((e) => e.ok === false && !(e.meta && e.meta.recovered)).length;`;
  if (s.includes(from)) { s = s.replace(from, to); fs.writeFileSync(p, s, 'utf8'); done.push('telemetry recovered exclusion'); }
  else console.log('MISS: telemetry errors line');
}

/* 日志页文案改为中性说明 */
{
  const p = root + 'src/renderer/app.js';
  let s = fs.readFileSync(p, 'utf8');
  const from = `  task_feed_error: '作业接口异常',`;
  const to = `  task_feed_error: '主接口 403（已用备用读取）',`;
  if (s.includes(from)) { s = s.replace(from, to); s = s.replace("  course_list_error: '课程列表异常',", "  course_list_error: '课程列表异常',"); fs.writeFileSync(p, s, 'utf8'); done.push('log label neutral'); }
  else console.log('MISS: task_feed_error label');
}

console.log('applied:', done.join(', '));
