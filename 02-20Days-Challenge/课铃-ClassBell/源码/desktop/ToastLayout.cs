using System;
using System.Drawing;
using System.Windows.Forms;

namespace ClassBell
{
    /// <summary>
    /// 右下角提醒弹窗（TrayToastForm）的布局计算。
    ///
    /// 为什么要单独抽出来：
    ///  1. 原来的布局是写死的 ClientSize + 写死的 Label.Bounds，标题一长就折行、
    ///     折行后把下面两行挤掉。要修就必须按文字实际需要的高度来算，这段计算值得单独测；
    ///  2. 布局要同时跟随「界面大小」设置和系统 DPI，两套比例混在一起很容易算错，
    ///     放在一个纯函数里，探针程序可以直接按不同比例调用它验证。
    ///
    /// 缩放约定（与桌面浮窗 FloatWindow 保持一致，避免两个窗口看起来不一样大）：
    ///  - 像素（宽高、内边距、间距）乘 uiScale × dpiScale；
    ///  - 字号只乘 uiScale —— 点值会被 GDI+ 按系统 DPI 自动放大，再乘一次就成了「大字塞小盒」。
    /// </summary>
    internal static class ToastLayout
    {
        /// <summary>100% 缩放下的基准宽度。够放下「18:00 截止 · 还有 1 天 7 小时」这类文案。</summary>
        internal const int BaseWidth = 392;

        private const int PaddingX = 18;
        private const int PaddingTop = 12;
        private const int PaddingBottom = 14;
        private const int GapAfterTitle = 8;
        private const int GapBetweenLines = 4;

        private const float TitlePointSize = 11f;
        private const float LinePointSize = 9f;

        /// <summary>文字最窄也要有这么宽，否则窄屏上会变成一列一列的字。</summary>
        internal const int MinTextWidth = 120;

        /// <summary>
        /// 量文字。默认用 TextRenderer（Label 渲染也走 GDI，量出来的高度才和实际一致）。
        /// 抽成委托是为了让探针可以喂一个按 DPI 等比缩放的假测量器，
        /// 这样不用真的换显示器也能验证 125% / 150% 的布局。
        /// </summary>
        internal delegate Size MeasureTextDelegate(string text, Font font, Size constraint);

        /// <summary>计算好的布局结果。字体一并返回，保证「量的时候」和「画的时候」用的是同一个字体。</summary>
        internal sealed class Metrics
        {
            public int ClientWidth;
            public int ClientHeight;
            public Rectangle Title;
            public Rectangle Line1;
            public Rectangle Line2;
            public Font TitleFont;
            public Font LineFont;
        }

        /// <summary>默认测量器：按词折行、不加额外内边距，与 Label 的默认渲染一致。</summary>
        internal static Size DefaultMeasure(string text, Font font, Size constraint)
        {
            return TextRenderer.MeasureText(
                text ?? string.Empty,
                font,
                constraint,
                TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
        }

        /// <summary>
        /// 按缩放比例算出弹窗的客户区尺寸和三块文字的位置。
        ///
        /// 高度不再是常量，而是「三块文字各自量出来的高度 + 内边距 + 间距」。
        /// 标题折成几行都能容纳，这是修掉「标题一长就把下面挤掉」的关键。
        /// </summary>
        /// <param name="uiScale">界面大小设置（0.9 / 1.0 / 1.1 / 1.25 / 1.4 / 1.6）</param>
        /// <param name="dpiScale">屏幕 DPI 比例（150% 屏 = 1.5）</param>
        /// <param name="maxWidth">可用最大宽度（设备像素），超出时收窄，通常是工作区宽度减去边距</param>
        internal static Metrics Compute(
            float uiScale,
            float dpiScale,
            string heading,
            string line1,
            string line2,
            MeasureTextDelegate measure,
            int maxWidth)
        {
            if (uiScale < 0.8f) uiScale = 0.8f;
            if (uiScale > 1.8f) uiScale = 1.8f;
            if (dpiScale < 0.75f || dpiScale > 4f) dpiScale = 1f;
            if (measure == null) measure = DefaultMeasure;

            float pixelScale = uiScale * dpiScale;
            int width = (int)Math.Round(BaseWidth * pixelScale);
            // 屏幕太窄时收窄，不让弹窗顶出屏幕
            if (maxWidth > 0 && width > maxWidth) width = maxWidth;
            if (width < MinTextWidth) width = MinTextWidth;

            int padX = (int)Math.Round(PaddingX * pixelScale);
            int padTop = (int)Math.Round(PaddingTop * pixelScale);
            int padBottom = (int)Math.Round(PaddingBottom * pixelScale);
            int gapTitle = (int)Math.Round(GapAfterTitle * pixelScale);
            int gapLines = (int)Math.Round(GapBetweenLines * pixelScale);
            int textWidth = Math.Max(MinTextWidth, width - padX * 2);

            // 字号只乘 uiScale：点值本身已经会随系统 DPI 放大
            var titleFont = new Font("Microsoft YaHei UI", TitlePointSize * uiScale, FontStyle.Bold);
            var lineFont = new Font("Microsoft YaHei UI", LinePointSize * uiScale);

            Size titleSize = measure(heading ?? string.Empty, titleFont, new Size(textWidth, int.MaxValue));
            Size line1Size = measure(line1 ?? string.Empty, lineFont, new Size(textWidth, int.MaxValue));
            Size line2Size = measure(line2 ?? string.Empty, lineFont, new Size(textWidth, int.MaxValue));

            // 量出来的宽度可能小于实际可用宽度（短文字），高度一定用它给的值
            int titleH = Math.Max(titleFont.Height, titleSize.Height);
            int line1H = Math.Max(lineFont.Height, line1Size.Height);
            int line2H = Math.Max(lineFont.Height, line2Size.Height);

            var metrics = new Metrics();
            metrics.ClientWidth = width;
            metrics.ClientHeight = padTop + titleH + gapTitle + line1H + gapLines + line2H + padBottom;
            metrics.TitleFont = titleFont;
            metrics.LineFont = lineFont;
            metrics.Title = new Rectangle(padX, padTop, textWidth, titleH);
            metrics.Line1 = new Rectangle(padX, metrics.Title.Bottom + gapTitle, textWidth, line1H);
            metrics.Line2 = new Rectangle(padX, metrics.Line1.Bottom + gapLines, textWidth, line2H);
            return metrics;
        }

        /// <summary>
        /// 把弹窗摆到主屏右下角，并保证整块都在工作区里（任务栏以上）。
        ///
        /// 为什么不能只写 Bottom - Height：高 DPI + 最大字号时窗口会变高，
        /// 直接减可能算出负坐标跑到屏幕外，用户就再也看不见提醒。
        /// </summary>
        internal static Point PlaceBottomRight(Rectangle workingArea, int width, int height, int margin)
        {
            int x = workingArea.Right - width - margin;
            int y = workingArea.Bottom - height - margin;
            if (x < workingArea.Left + margin) x = workingArea.Left + margin;
            if (y < workingArea.Top + margin) y = workingArea.Top + margin;
            return new Point(x, y);
        }
    }
}