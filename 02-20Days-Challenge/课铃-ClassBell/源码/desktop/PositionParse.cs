using System;
using System.Drawing;
using System.Globalization;

namespace ClassBell
{
    /// <summary>
    /// 浮窗位置 "x,y" 的解析。
    ///
    /// 单独成文件是为了能单测：这里处理的是外部写进设置里的值，
    /// 必须扛得住极端输入（比如 int.MinValue），否则一次坏值就能让宿主启动即崩。
    /// </summary>
    internal static class PositionParse
    {
        // 位置数值的合理范围。超出这个范围一定不是真实屏幕坐标，
        // 当作没设过比"夹到边上"更符合预期 —— 用户的显示器不会在十万像素外。
        internal const int Limit = 100000;

        /// <summary>
        /// 解析 "x,y"。成功返回 true 并给出点；格式不对或数值超出 ±Limit 返回 false。
        ///
        /// 判范围用的是区间比较而不是 Math.Abs —— Math.Abs(int.MinValue) 会抛
        /// OverflowException（-2147483648 的绝对值 2147483648 超出 int 上限），
        /// 而这里恰好会收到这种值。
        /// </summary>
        internal static bool TryParse(string raw, out Point point)
        {
            point = Point.Empty;
            if (string.IsNullOrWhiteSpace(raw)) return false;

            var parts = raw.Split(',');
            if (parts.Length != 2) return false;

            int x;
            int y;
            if (!int.TryParse(parts[0].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out x)) return false;
            if (!int.TryParse(parts[1].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out y)) return false;
            if (x < -Limit || x > Limit) return false;
            if (y < -Limit || y > Limit) return false;

            point = new Point(x, y);
            return true;
        }
    }
}
