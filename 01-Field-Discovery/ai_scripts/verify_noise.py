# -*- coding: utf-8 -*-
"""
重算 NoiseLedger 导出的噪声指标，并与 App 自带 Summary 对比。

用途：
    验证「报告里的数字能不能从原始数据复算出来」。
    能复算 = 数据可溯源；复算不出来 = 必须写进报告的局限章节。

输入： 01-Field-Discovery/raw_data/**/*.csv（NoiseLedger 原始导出）
输出： 屏幕上打印对比表，同时写入 ai_scripts/verify_noise_result.txt

用法（在仓库任意位置都行）：
    python 01-Field-Discovery/ai_scripts/verify_noise.py

依赖：只用 Python 标准库，不需要装任何东西。
"""

import sys
import math
import statistics
from pathlib import Path

# Windows 控制台默认不是 UTF-8，中文容易乱码，这里强制一下
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------- 指标计算 ----------

def leq_equal_weight(values):
    """等效连续声级 Leq（等权）：10*log10(mean(10^(L/10)))"""
    if not values:
        return float("nan")
    return 10 * math.log10(sum(10 ** (v / 10.0) for v in values) / len(values))


def leq_time_weight(ts, values):
    """Leq（按时间戳加权）。采样间隔不均匀时比等权更严格。"""
    if len(values) < 2:
        return leq_equal_weight(values)
    dts = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
    dts.append(statistics.median(dts))
    total_t = sum(dts)
    if total_t <= 0:
        return leq_equal_weight(values)
    num = sum(d * 10 ** (v / 10.0) for d, v in zip(dts, values))
    return 10 * math.log10(num / total_t)


def percentile_level(values, p):
    """统计声级 L_p：p% 的时间超过此值（降序取第 p% 位）"""
    if not values:
        return float("nan")
    desc = sorted(values, reverse=True)
    idx = min(len(desc) - 1, int(round(p / 100.0 * len(desc))))
    return desc[idx]


# ---------- 文件解析 ----------

def parse_noise_export(path):
    """解析 NoiseLedger 导出文件，返回 (summary字典, 声级列表, 时间戳列表)"""
    lines = path.read_text(encoding="utf-8-sig").splitlines()

    summary = {}
    i = 0
    # 前几行是 Session Summary，形如 "Leq (dB),29.6"
    while i < len(lines) and lines[i].strip():
        parts = lines[i].split(",")
        if len(parts) >= 2:
            summary[parts[0].strip()] = parts[1].strip()
        i += 1

    # 跳过空行，找到数据表头
    while i < len(lines) and not lines[i].startswith("Timestamp"):
        i += 1
    i += 1

    values, stamps = [], []
    for line in lines[i:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        try:
            stamps.append(int(parts[0]))
            values.append(float(parts[1]))
        except ValueError:
            continue

    return summary, values, stamps


def fmt(x, width=7, digits=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return f"{'--':>{width}}"
    return f"{x:>{width}.{digits}f}"


# ---------- 主流程 ----------

def main():
    here = Path(__file__).resolve().parent          # .../01-Field-Discovery/ai_scripts
    raw_dir = here.parent / "raw_data"

    files = sorted(raw_dir.rglob("*.csv"))
    targets = [f for f in files if f.name.startswith("T06_")]

    out = []
    def emit(text=""):
        print(text)
        out.append(text)

    emit("=" * 78)
    emit("NoiseLedger 原始导出 · 指标重算与比对")
    emit(f"扫描目录：{raw_dir}")
    emit(f"命中课题06 导出文件：{len(targets)} 个（总 csv {len(files)} 个）")
    emit("=" * 78)

    if not targets:
        emit("没有找到以 T06_ 开头的导出文件，检查一下路径。")
        (here / "verify_noise_result.txt").write_text("\n".join(out), encoding="utf-8")
        return

    header = (f"{'文件':<34}{'n':>5}{'分钟':>7}"
              f"{'Leq_app':>9}{'Leq_算':>8}{'偏差':>8}"
              f"{'L10_app':>9}{'L10_算':>8}{'L90_app':>9}{'L90_算':>8}")
    emit(header)
    emit("-" * 78)

    rows = []
    for f in targets:
        summary, values, stamps = parse_noise_export(f)
        if not values:
            emit(f"{f.name[:32]:<34}  解析失败，没有数据行")
            continue

        duration_min = (max(stamps) - min(stamps)) / 1000.0 / 60.0
        leq_calc = leq_equal_weight(values)
        leq_tw = leq_time_weight(stamps, values)
        l10_calc = percentile_level(values, 10)
        l90_calc = percentile_level(values, 90)

        def app(key):
            try:
                return float(summary.get(key, ""))
            except (TypeError, ValueError):
                return None

        leq_app = app("Leq (dB)")
        l10_app = app("L10 (dB)")
        l90_app = app("L90 (dB)")
        diff = (leq_calc - leq_app) if leq_app is not None else None

        rows.append({
            "name": f.name,
            "n": len(values),
            "dur": duration_min,
            "leq_app": leq_app, "leq_calc": leq_calc, "leq_tw": leq_tw, "diff": diff,
            "l10_app": l10_app, "l10_calc": l10_calc,
            "l90_app": l90_app, "l90_calc": l90_calc,
        })

        emit(f"{f.name[:32]:<34}{len(values):>5}{duration_min:>7.2f}"
             f"{fmt(leq_app, 9)}{fmt(leq_calc, 8)}{fmt(diff, 8, 1)}"
             f"{fmt(l10_app, 9)}{fmt(l10_calc, 8)}"
             f"{fmt(l90_app, 9)}{fmt(l90_calc, 8)}")

    # ---------- 汇总 ----------
    diffs = [r["diff"] for r in rows if r["diff"] is not None]
    # 分位数允许 0.5 dB 容差：App 与脚本的分位取整方式可能差一档
    l10_diff = [abs(r["l10_app"] - r["l10_calc"]) for r in rows if r["l10_app"] is not None]
    l90_diff = [abs(r["l90_app"] - r["l90_calc"]) for r in rows if r["l90_app"] is not None]
    l10_ok = sum(1 for d in l10_diff if d < 0.5)
    l90_ok = sum(1 for d in l90_diff if d < 0.5)

    emit("-" * 78)
    emit(f"L10 与 App 吻合（容差 0.5 dB）：{l10_ok}/{len(rows)} 组"
         + (f"，最大差 {max(l10_diff):.1f} dB" if l10_diff else ""))
    emit(f"L90 与 App 吻合（容差 0.5 dB）：{l90_ok}/{len(rows)} 组"
         + (f"，最大差 {max(l90_diff):.1f} dB" if l90_diff else ""))

    if diffs:
        mae = sum(abs(d) for d in diffs) / len(diffs)
        emit(f"Leq 偏差范围：{min(diffs):+.1f} ~ {max(diffs):+.1f} dB")
        emit(f"Leq 平均绝对误差：{mae:.2f} dB")
        lower = sum(1 for d in diffs if d < -0.5)
        emit(f"其中明显偏低（>0.5 dB）{lower} 组、其余 {len(diffs) - lower} 组基本吻合")

    emit()
    emit("怎么读这张表：")
    emit("  · 分位数（L10/L50/L90）基本能由原始数据复现 → 横向比较可用")
    emit("  · Leq 系统性偏低 → 无法从导出数据独立复算，正文引用 App 输出并注明")
    emit("  · 偏差大的组，多半是样本数少的组（n 一栏），时长越短越容易偏")

    out_path = here / "verify_noise_result.txt"
    try:
        out_path.write_text("\n".join(out), encoding="utf-8")
        print(f"\n结果已写入：{out_path}")
    except OSError as e:
        print(f"\n（结果文件没写成功：{e}，但上面的内容已经打印出来了，可以直接复制）")


if __name__ == "__main__":
    main()
