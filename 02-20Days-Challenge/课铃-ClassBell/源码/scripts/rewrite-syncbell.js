'use strict';
/**
 * 重写 ~/syncbell.sh：
 *  - 自动探测课铃真实的日志目录（安装版在 %APPDATA%，便携版在安装目录 data\\）；
 *  - 不再写死 campus-pulse/process_logs（那份是旧的仓库副本，不是程序实时写入处）；
 *  - 默认只同步当天；--all 同步全部历史；--commit 顺手 git 提交。
 * 输出必须 LF + UTF-8 无 BOM，否则 Git Bash 执行报错。
 */
const fs = require('fs');

const target = 'C:/Users/24373/syncbell.sh';

const script = `#!/usr/bin/env bash
# ============================================================
# 课铃 ClassBell · 每日日志同步
# 作用：把课铃当天真实写入的 Telemetry 日志同步进 ICEC 仓库的
#       02-20Days-Challenge/process_logs/，供“连续 7 天日志”验收。
#
# 用法：
#   bash ~/syncbell.sh            # 只同步今天
#   bash ~/syncbell.sh --all      # 同步全部历史日志
#   bash ~/syncbell.sh --commit   # 同步后自动 git add/commit
#   bash ~/syncbell.sh --all --commit
#
# 为什么需要“探测”：课铃有两种数据目录
#   1) 安装版：%APPDATA%\\ClassBell\\process_logs
#   2) 便携版 / AppData 不可写时：<安装目录>\\data\\process_logs
# 写死其中一个，另一个就会报“今天没有日志文件”。
# ============================================================
set -u

REPO="$HOME/Desktop/ICEC-2026-0157-LiZiYang"
DEST="$REPO/02-20Days-Challenge/process_logs"
TODAY=$(date +%Y-%m-%d)

# 候选日志目录，按“最可能是程序实时写入处”排序
CANDIDATES=(
  "$HOME/Documents/deepseek-harness/default-workspace/ClassBell/data/process_logs"
  "$HOME/AppData/Roaming/ClassBell/process_logs"
  "$HOME/Documents/deepseek-harness/default-workspace/campus-pulse/process_logs"
)

ALL=0
COMMIT=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --commit) COMMIT=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用 --all / --commit）"; exit 2 ;;
  esac
done

echo "=========================================="
echo "  课铃 · 每日日志同步   $TODAY"
echo "=========================================="

[ -d "$REPO" ] || { echo "❌ 找不到仓库目录：$REPO"; exit 1; }
[ -d "$DEST" ] || { echo "❌ 找不到目标目录：$DEST"; exit 1; }

# --- 1/4 探测真实日志目录 ---------------------------------
echo
echo "=== 1/4 定位日志目录 ==="
SRC=""
for d in "\${CANDIDATES[@]}"; do
  if [ -d "$d" ]; then
    # 优先选“有今天文件”的目录；否则先记下第一个存在的目录备用
    if [ -f "$d/$TODAY.jsonl" ]; then
      SRC="$d"
      echo "  ✔ 命中（含今天日志）：$d"
      break
    fi
    [ -z "$SRC" ] && SRC="$d"
  fi
done

if [ -z "$SRC" ]; then
  echo "❌ 所有候选目录都不存在："
  for d in "\${CANDIDATES[@]}"; do echo "     $d"; done
  echo "   → 先打开课铃运行一次，让它创建日志目录。"
  exit 1
fi

if [ ! -f "$SRC/$TODAY.jsonl" ]; then
  echo "⚠ 已选目录：$SRC"
  echo "  但今天还没有 $TODAY.jsonl"
  ls -1t "$SRC"/*.jsonl 2>/dev/null | head -3 | sed 's/^/     最近文件：/'
  echo "  → 打开课铃用一会儿（查看页面/同步/操作任务都会写日志），再回来跑。"
  exit 1
fi

# --- 2/4 复制 -------------------------------------------------
echo
echo "=== 2/4 复制日志 ==="
n=0
if [ "$ALL" -eq 1 ]; then
  for f in "$SRC"/*.jsonl; do
    [ -f "$f" ] || continue
    cp -f "$f" "$DEST/" && n=$((n+1))
  done
  echo "  已复制 $n 个日志文件（含全部历史）"
else
  cp -f "$SRC/$TODAY.jsonl" "$DEST/" && n=$((n+1))
  echo "  已复制今天：$TODAY.jsonl"
fi
if [ -f "$SRC/index.json" ]; then
  cp -f "$SRC/index.json" "$DEST/" && n=$((n+1))
  echo "  已复制 7 天索引：index.json"
fi

# --- 3/4 自检 -------------------------------------------------
echo
echo "=== 3/4 自检 ==="
count=$(ls -1 "$DEST"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
echo "  仓库内日志天数：$count 天（目标 ≥ 7）"
echo "  今日文件行数：$(wc -l < "$DEST/$TODAY.jsonl" | tr -d ' ') 行"
echo "  今日文件大小：$(du -h "$DEST/$TODAY.jsonl" | cut -f1)"

# --- 4/4 提交（可选） -----------------------------------------
if [ "$COMMIT" -eq 1 ]; then
  echo
  echo "=== 4/4 Git 提交 ==="
  cd "$REPO" || exit 1
  git add "02-20Days-Challenge/process_logs" || exit 1
  if git diff --cached --quiet; then
    echo "  没有需要提交的变更。"
  else
    git commit -m "log(classbell): $TODAY 真实运行日志" || exit 1
    echo "  已提交。需要推送时执行：git push"
  fi
else
  echo
  echo "=== 4/4 提交（已跳过） ==="
  echo "  需要时执行：cd $REPO && git add 02-20Days-Challenge/process_logs && git commit -m \\"log: $TODAY\\""
fi

echo
echo "✔ 完成。源目录：$SRC"
`;

fs.writeFileSync(target, script, { encoding: 'utf8' });
const back = fs.readFileSync(target);
console.log('written bytes', back.length, 'BOM?', back[0] === 0xef && back[1] === 0xbb && back[2] === 0xbf, 'CRLF?', back.includes(Buffer.from('\r\n')));
