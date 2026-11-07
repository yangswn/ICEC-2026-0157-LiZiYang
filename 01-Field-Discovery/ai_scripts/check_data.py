# -*- coding: utf-8 -*-
"""
第一阶段数据体检：查组数、查缺漏、查现场照能不能对上。

它回答三个问题：
    1. 计划采多少组，实际采了多少组，缺哪些？
    2. 汇总表里的每一条记录，是不是都有一张对应的现场同框照？
    3. 课题06 的原始导出文件数，和汇总表的记录数对不对得上？

为什么要写这个：
    缺组和错配是"组数一多就必然发生"的事。脚本会把它暴露出来。
    反过来说，一个能跑出 24/24、15/15、照片 15/15 的仓库，
    比一句"我采了 24 组"有说服力得多。

用法：
    python 01-Field-Discovery/ai_scripts/check_data.py

依赖：只用标准库。
"""

import sys
import csv
from pathlib import Path
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 计划要求（以后加点位改这里就行）
PLAN = {
    "课题03": {"点位": 8, "每点位次数": 3, "表": "课题03-无线信号盲区-原始数据.csv"},
    "课题06": {"点位": 5, "每点位时段": 3, "表": "课题06-噪声地图-原始数据.csv"},
}

PHOTO_COL = "同框照片文件名"


def read_csv_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def build_photo_index(raw_dir):
    """把所有图片的文件名建索引，方便判断'这张照在不在仓库里'"""
    index = {}
    for p in raw_dir.rglob("*"):
        if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".heic"):
            index.setdefault(p.name, []).append(p)
    return index


def main():
    here = Path(__file__).resolve().parent
    raw_dir = here.parent / "raw_data"
    out = []

    def emit(text=""):
        print(text)
        out.append(text)

    emit("=" * 74)
    emit("第一阶段数据体检")
    emit(f"数据目录：{raw_dir}")
    emit("=" * 74)

    photo_index = build_photo_index(raw_dir)
    total_photo_files = sum(len(v) for v in photo_index.values())
    emit(f"图片文件总数：{total_photo_files}")
    emit()

    # ---------- 课题03 ----------
    t03 = raw_dir / PLAN["课题03"]["表"]
    emit("【课题03 · 无线信号盲区】")
    if not t03.exists():
        emit("  汇总表不存在，跳过。")
    else:
        rows = read_csv_rows(t03)
        emit(f"  汇总表记录数：{len(rows)} 条")
        by_point = defaultdict(list)
        for r in rows:
            by_point[r.get("点位编号", "?")].append(r)
        emit(f"  涉及点位数：{len(by_point)} 个")
        need = PLAN["课题03"]["每点位次数"]
        short = []
        for pid in sorted(by_point):
            n = len(by_point[pid])
            flag = "OK" if n >= need else "缺"
            emit(f"    {pid}: {n}/{need}  {flag}")
            if n < need:
                short.append(f"{pid}(少{need - n}次)")
        if short:
            emit(f"  ⚠ 未采足的：{'、'.join(short)}")
        else:
            emit("  ✅ 每个点位都达到计划次数")

        # 照片对应
        missing_photo = []
        checked = 0
        for r in rows:
            name = (r.get(PHOTO_COL) or "").strip()
            if not name:
                missing_photo.append(f"第{r.get('序号','?')}条：照片栏为空")
                continue
            checked += 1
            if name not in photo_index:
                missing_photo.append(f"第{r.get('序号','?')}条：找不到 {name}")
        emit(f"  照片核对：{checked - len([m for m in missing_photo if '找不到' in m])}/{len(rows)} 条能在仓库里找到对应照片")
        for m in missing_photo[:10]:
            emit(f"    ⚠ {m}")
    emit()

    # ---------- 课题06 ----------
    t06 = raw_dir / PLAN["课题06"]["表"]
    emit("【课题06 · 噪声地图】")
    if not t06.exists():
        emit("  汇总表不存在，跳过。")
    else:
        rows = read_csv_rows(t06)
        emit(f"  汇总表记录数：{len(rows)} 条")

        combo = Counter((r.get("点位编号", "?"), r.get("时段", "?")) for r in rows)
        points = sorted({c[0] for c in combo})
        periods = sorted({c[1] for c in combo})
        emit(f"  点位 {len(points)} 个 × 时段 {len(periods)} 个 = 计划 {len(points) * len(periods)} 格")
        emit(f"  实际填了 {len(combo)} 格")

        grid = []
        for p in points:
            cells = []
            for t in periods:
                n = combo.get((p, t), 0)
                cells.append(f"{t}{n}组" if n else f"{t}空")
            grid.append(f"    {p}: " + "  ".join(cells))
        emit("\n".join(grid))

        empty = [f"{p}-{t}" for p in points for t in periods if combo.get((p, t), 0) == 0]
        if empty:
            emit(f"  ⚠ 空格子：{'、'.join(empty)}")
        else:
            emit("  ✅ 15 格全满")

        missing_photo = []
        for r in rows:
            name = (r.get(PHOTO_COL) or "").strip()
            if not name:
                missing_photo.append(f"第{r.get('序号','?')}条：照片栏为空")
            elif name not in photo_index:
                missing_photo.append(f"第{r.get('序号','?')}条：找不到 {name}")
        emit(f"  照片核对：{len(rows) - len(missing_photo)}/{len(rows)} 条能找到对应照片")
        for m in missing_photo[:10]:
            emit(f"    ⚠ {m}")

        # 原始导出文件 vs 汇总记录
        exports = sorted(raw_dir.rglob("T06_*.csv"))
        emit(f"  原始导出文件：{len(exports)} 个（汇总表 {len(rows)} 条）")
        if len(exports) == len(rows):
            emit("  ✅ 一个文件对一条记录")
        else:
            emit(f"  ⚠ 数量不一致，差 {len(exports) - len(rows)}")

    emit()
    emit("=" * 74)
    emit("体检完。以上任何一条 ⚠ 都值得写进报告的「异常与取舍」里——")
    emit("主动写出来是严谨，被评审发现是漏洞。")

    out_path = here / "check_data_result.txt"
    try:
        out_path.write_text("\n".join(out), encoding="utf-8")
        print(f"\n结果已写入：{out_path}")
    except OSError as e:
        print(f"\n（结果文件没写成功：{e}，但上面的内容已经打印出来了，可以直接复制）")


if __name__ == "__main__":
    main()
